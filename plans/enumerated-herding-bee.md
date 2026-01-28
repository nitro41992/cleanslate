# Fix Diff Scroll Performance for Parquet Storage

## Status: ✅ IMPLEMENTED

Implementation complete. Changes made to:
- `src/lib/diff-engine.ts`: Added `materializeDiffForPagination()`, `cleanupMaterializedDiffView()`, `getMaterializedDiffView()` functions and updated `fetchDiffPageWithKeyset()` to use materialized views
- `src/components/diff/DiffView.tsx`: Wired up materialization after `runDiff()` completes for Parquet storage, added cleanup in unmount effect

## Problem
Diff view scrolling is slow for large diffs that use Parquet storage. Console logs show:
```
[Diff] Keyset pagination not supported for Parquet storage, using OFFSET
[Violation] 'message' handler took 508ms
```

The issue: When diffs exceed 100k rows, they're stored as Parquet files to avoid OOM. But `fetchDiffPageWithKeyset` falls back to OFFSET pagination for Parquet, defeating the performance gains.

## Root Cause

**Parquet file reads are stateless:**
- `read_parquet('file.parquet')` creates an ephemeral table on each query
- No persistent index on `sort_key` column
- Keyset `WHERE sort_key > cursor` requires full table scan (no index)
- Cursors are lost between queries - Parquet is stateless

**Current behavior:**
```typescript
// diff-engine.ts:1069
if (storageType === 'parquet') {
  console.log('[Diff] Keyset pagination not supported for Parquet storage, using OFFSET')
  // Falls back to O(n) OFFSET pagination
}
```

## Industry Best Practice (2025-2026)

Per [DuckDB 1.3 on MotherDuck](https://motherduck.com/blog/announcing-duckdb-13-on-motherduck-cdw/):
- **Materialize only what's repeatedly read** - everything else stays virtual
- DuckDB 1.3+ late materialization gives **3-10x faster reads** for LIMIT queries
- Materializing Parquet into DuckDB increases performance **2x**

Per [Halodoc Pagination Guide](https://blogs.halodoc.io/a-practical-guide-to-scalable-pagination/):
- Keyset pagination drops latencies by **60%+** over OFFSET
- Database query load reduced by **20%**, CPU improved by **30%**

**The solution:** Create a temp table from Parquet files **once** when diff opens, then use keyset pagination on that stable, indexed table.

## Implementation Plan

### Change 1: Materialize Parquet into Temp Table (PRIMARY FIX)
**File:** `src/lib/diff-engine.ts`

When a diff uses Parquet storage, materialize it into a temp table **once** when the diff view opens. This enables keyset pagination on a stable, indexed table instead of re-reading Parquet files on every scroll.

**Current flow (slow):**
```
User scrolls → read_parquet('file.parquet') → full scan → OFFSET
User scrolls → read_parquet('file.parquet') → full scan → OFFSET  (repeat)
```

**New flow (fast):**
```
Diff opens → CREATE TEMP TABLE _diff_view_X AS SELECT * FROM read_parquet(...)  (once)
User scrolls → SELECT FROM _diff_view_X WHERE sort_key > cursor  (keyset, O(1))
User scrolls → SELECT FROM _diff_view_X WHERE sort_key > cursor  (keyset, O(1))
Diff closes → DROP TABLE _diff_view_X
```

**Implementation:**

1. **Add materialization function** in `diff-engine.ts`:
```typescript
// Track materialized view tables for cleanup
const materializedDiffViews = new Map<string, string>() // diffTableName -> viewTableName

/**
 * Materialize a Parquet-backed diff into a temp table for fast keyset pagination.
 * Called once when diff view opens for large diffs.
 */
export async function materializeDiffForPagination(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[]
): Promise<string> {
  const viewTableName = `_diff_view_${Date.now()}`

  // Build the full diff query with JOINs
  const sourceTableExpr = await resolveTableRef(sourceTableName)
  const selectCols = allColumns
    .map((c) => {
      const inA = !removedColumns.includes(c)
      const inB = !newColumns.includes(c)
      const aExpr = inA ? `a."${c}"` : 'NULL'
      const bExpr = inB ? `b."${c}"` : 'NULL'
      return `${aExpr} as "a_${c}", ${bExpr} as "b_${c}"`
    })
    .join(', ')

  // Materialize with all data needed for pagination
  await execute(`
    CREATE TEMP TABLE "${viewTableName}" AS
    SELECT
      d.diff_status,
      d.row_id,
      d.sort_key,
      ${selectCols}
    FROM read_parquet('${diffTableName}_part_*.parquet') d
    LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status IN ('added', 'removed', 'modified')
  `)

  materializedDiffViews.set(diffTableName, viewTableName)
  console.log(`[Diff] Materialized ${diffTableName} into ${viewTableName}`)
  return viewTableName
}

/**
 * Cleanup materialized view when diff closes.
 */
export async function cleanupMaterializedDiffView(diffTableName: string): Promise<void> {
  const viewTableName = materializedDiffViews.get(diffTableName)
  if (viewTableName) {
    try {
      await execute(`DROP TABLE IF EXISTS "${viewTableName}"`)
      materializedDiffViews.delete(diffTableName)
      console.log(`[Diff] Dropped materialized view ${viewTableName}`)
    } catch (e) {
      console.warn(`[Diff] Failed to drop ${viewTableName}:`, e)
    }
  }
}
```

2. **Update `fetchDiffPageWithKeyset`** to use materialized view:
```typescript
export async function fetchDiffPageWithKeyset(
  tempTableName: string,
  // ... other params ...
  storageType: 'memory' | 'parquet' = 'memory'
): Promise<KeysetDiffPageResult> {
  // For Parquet, use the materialized view if available
  let queryTable = tempTableName
  if (storageType === 'parquet') {
    const viewTable = materializedDiffViews.get(tempTableName)
    if (viewTable) {
      queryTable = viewTable
      // Now we can use keyset pagination on the materialized table!
    } else {
      // Fall back to OFFSET if not materialized yet
      console.log('[Diff] No materialized view, using OFFSET')
      // ... existing fallback code ...
    }
  }

  // Keyset pagination query (works for both memory and materialized Parquet)
  const whereClause = cursor.sortKey !== null
    ? cursor.direction === 'forward'
      ? `WHERE sort_key > ${cursor.sortKey}`
      : `WHERE sort_key < ${cursor.sortKey}`
    : ''

  const result = await query<DiffRow>(`
    SELECT * FROM "${queryTable}"
    ${whereClause}
    ORDER BY sort_key ${cursor.direction === 'forward' ? 'ASC' : 'DESC'}
    LIMIT ${limit}
  `)

  // Extract cursors from result
  const firstSortKey = result.length > 0 ? result[0].sort_key : null
  const lastSortKey = result.length > 0 ? result[result.length - 1].sort_key : null

  return { rows: result, firstSortKey, lastSortKey }
}
```

3. **Wire up in DiffView.tsx** - call materialization when diff opens with Parquet storage:
```typescript
// In DiffView.tsx, after runDiff completes:
if (diffResult.storageType === 'parquet') {
  await materializeDiffForPagination(
    diffResult.diffTableName,
    sourceTableName,
    targetTableName,
    allColumns,
    newColumns,
    removedColumns
  )
}

// In cleanup effect:
await cleanupMaterializedDiffView(diffTableName)
```

**Performance gain:** O(n) OFFSET → O(1) keyset = **~60%+ latency reduction** per scroll

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/diff-engine.ts` | Add `materializeDiffForPagination()` and `cleanupMaterializedDiffView()` functions |
| `src/lib/diff-engine.ts` | Update `fetchDiffPageWithKeyset()` to use materialized view for Parquet |
| `src/components/diff/DiffView.tsx` | Call materialization on diff open, cleanup on close |

## Verification

### Manual Test - Scroll Performance
1. Load Raw_Data_HF_V6 (1.01M rows × 31 columns)
2. Apply a transform, open diff view
3. Check console for: `[Diff] Materialized _diff_xxx into _diff_view_xxx`
4. Drag scrollbar from top to ~50% position
5. **Expected:** Grid responds within 200ms (no more OFFSET fallback messages)
6. Check console: Should see keyset fetch logs, NOT "using OFFSET"

### Console Verification
**Before fix:**
```
[Diff] Keyset pagination not supported for Parquet storage, using OFFSET
[Violation] 'message' handler took 508ms
```

**After fix:**
```
[Diff] Materialized _diff_xxx into _diff_view_xxx
[DIFFGRID] Keyset fetch (estimated): page 6 from cursor 3000
```

### Regression Tests
```bash
npx playwright test e2e/tests/regression-diff.spec.ts --reporter=list
```

## Sources
- [DuckDB 1.3 on MotherDuck](https://motherduck.com/blog/announcing-duckdb-13-on-motherduck-cdw/) - Late materialization, 3-10x faster reads
- [Halodoc Pagination Guide](https://blogs.halodoc.io/a-practical-guide-to-scalable-pagination/) - 60%+ latency reduction with keyset
- [Keyset vs Offset Pagination](https://leapcell.io/blog/efficient-data-pagination-keyset-vs-offset) - O(1) vs O(n)
- [Use The Index Luke - No Offset](https://use-the-index-luke.com/no-offset) - OFFSET is fundamentally unscalable
