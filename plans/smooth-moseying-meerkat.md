# Optimize Diff Comparison for 2M Rows

## Problem
The diff comparison feature fails on 100K+ row tables due to:
1. Two separate FULL OUTER JOIN queries (one for results limited to 10K, one for summary)
2. HTML `<table>` rendering (not virtualized, max 500 rows in DOM)
3. All results stored in Zustand memory
4. No DuckDB memory/performance configuration

## Solution Overview
Use a **temp table + virtualized grid** approach:
1. Execute JOIN once, store in temp table with `ROW_NUMBER()`
2. Query summary from temp table (instant, no re-join)
3. Paginate results using keyset pagination via `_row_num`
4. Render with Glide Data Grid (already used in DataGrid.tsx for 100K+ rows)

---

## Implementation Steps

### Step 1: Add DuckDB Performance Configuration
**File:** `src/lib/duckdb/index.ts`

After `db.instantiate()`, add:
```typescript
const initConn = await db.connect()
await initConn.query(`SET memory_limit = '2GB'`)
await initConn.query(`SET preserve_insertion_order = false`)
await initConn.query(`SET threads = 4`)  // Parallel JOIN execution
await initConn.close()
```

### Step 2: Refactor diff-engine.ts to Use Temp Table
**File:** `src/lib/diff-engine.ts`

Replace dual-query approach with:

```typescript
// Phase 1: Create temp table (JOIN executes once)
// Note: Include all rows (even unchanged) in case we add "Show Unchanged" toggle later
const diffTableName = `_diff_${Date.now()}`
await execute(`
  CREATE TEMP TABLE "${diffTableName}" AS
  SELECT
    ${selectCols},
    CASE WHEN ... END as diff_status
  FROM "${tableA}" a
  FULL OUTER JOIN "${tableB}" b ON ${joinCondition}
`)

// Phase 2: Summary from temp table (instant - no re-join!)
const summary = await query(`SELECT COUNT(*) FILTER (WHERE diff_status = 'added') as added, ...`)

// Phase 3: Get total non-unchanged count for grid
const totalDiffs = await query(`SELECT COUNT(*) as count FROM "${diffTableName}" WHERE diff_status != 'unchanged'`)

// Return temp table name for pagination
return { diffTableName, summary, totalDiffRows: totalDiffs[0].count, allColumns }
```

Add pagination function using **LIMIT/OFFSET** (not keyset):
```typescript
// Use LIMIT/OFFSET - DuckDB is fast enough for 2M rows, and this avoids
// the "gapped row" issue where _row_num would have gaps after filtering
export async function fetchDiffPage(
  tempTableName: string,
  offset: number,
  limit: number = 500,
  keyOrderBy: string  // Pass from original query for consistent ordering
) {
  return query(`
    SELECT * FROM "${tempTableName}"
    WHERE diff_status != 'unchanged'
    ORDER BY diff_status, ${keyOrderBy}
    LIMIT ${limit} OFFSET ${offset}
  `)
}

export async function cleanupDiffTable(tableName: string) {
  await execute(`DROP TABLE IF EXISTS "${tableName}"`)
}
```

**Why LIMIT/OFFSET instead of keyset pagination:**
- Keyset via `_row_num` creates gaps when filtering (row 1001 might be first non-unchanged)
- DuckDB handles OFFSET efficiently on 2M rows
- Allows future "Show Unchanged" toggle without re-running diff

### Step 3: Update diffStore for Pagination
**File:** `src/stores/diffStore.ts`

Replace `results: DiffResult[]` with:
```typescript
interface DiffState {
  // ... existing fields ...
  diffTableName: string | null    // Temp table reference
  totalDiffRows: number           // Total non-unchanged rows
  allColumns: string[]            // For grid columns
  summary: DiffSummary | null     // Keep summary (small)
}
```

Remove: `results: DiffResult[]` and `setResults`

### Step 4: Create Virtualized Diff Grid
**File:** `src/components/diff/VirtualizedDiffGrid.tsx` (new file)

Use Glide Data Grid following the pattern from `DataGrid.tsx`:
- `onVisibleRegionChanged` for lazy loading pages
- `getRowThemeOverride` for row coloring (green/red/yellow by status)
- `getCellContent` to format cells
- PAGE_SIZE = 500 (same as DataGrid)

Key features:
- Load data on-demand as user scrolls (fetch page when viewport changes)
- Color rows by diff_status (unless blindMode)
- **Before→After visualization:** Pass `a_col` and `b_col` values to the grid and render the arrow/comparison purely in Canvas (do NOT generate HTML strings in SQL)

### Step 5: Update DiffView.tsx
**File:** `src/components/diff/DiffView.tsx`

- Replace `<DiffResultsGrid>` with `<VirtualizedDiffGrid>`
- Pass `tempTableName`, `totalDiffRows`, `allColumns` instead of `results`
- Add cleanup via useEffect:
```typescript
useEffect(() => {
  return () => {
    if (diffTableName) {
      cleanupDiffTable(diffTableName)
    }
  }
}, [diffTableName])
```

**Note:** If user crashes/reloads, temp table dies automatically (DuckDB WASM memory is volatile). No orphan cleanup needed.

### Step 6: Update DiffExportMenu for Large Exports
**File:** `src/components/diff/DiffExportMenu.tsx`

Use chunked streaming export:
```typescript
async function* streamDiffResults(tempTableName: string, chunkSize = 10000) {
  let offset = 0
  while (true) {
    const chunk = await fetchDiffPage(tempTableName, offset, chunkSize)
    if (chunk.length === 0) break
    yield chunk
    offset += chunkSize
  }
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/duckdb/index.ts` | Add memory_limit, preserve_insertion_order config |
| `src/lib/diff-engine.ts` | Temp table approach, pagination functions, cleanup |
| `src/stores/diffStore.ts` | Replace results array with temp table reference |
| `src/components/diff/VirtualizedDiffGrid.tsx` | **NEW** - Glide Data Grid implementation |
| `src/components/diff/DiffView.tsx` | Use new grid, add cleanup |
| `src/components/diff/DiffExportMenu.tsx` | Streaming export |

## Reference Implementation
Follow patterns from:
- `src/components/grid/DataGrid.tsx` - Virtualization, lazy loading, row theming
- `src/lib/fuzzy-matcher.ts` - Chunked processing pattern

---

## Verification

1. **Build check:** `npm run build` - no TypeScript errors
2. **Lint:** `npm run lint` - no new errors
3. **Manual test:**
   - Load a 100K+ row CSV file
   - Apply a transformation (to create original snapshot)
   - Open Delta Inspector → Compare with Preview
   - Select key column → Run Comparison
   - Verify: Summary shows accurate counts, grid scrolls smoothly
4. **Export test:** Export diff results to CSV, verify file size matches summary counts

## Expected Performance

| Metric | Before | After |
|--------|--------|-------|
| Max rows | ~10K (crashes beyond) | 2M+ |
| Query time (1M rows) | N/A | ~5-10s |
| Memory (1M rows) | ~1GB JS heap | ~50KB JS + temp table in DuckDB |
| Page scroll | N/A | ~50ms per page |
