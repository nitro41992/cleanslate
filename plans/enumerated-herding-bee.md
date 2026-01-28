# Fix Diff OOM on 1M+ Row Tables

## Problem
- Diff operations fail with OOM error on 1M+ rows (Raw_Data_HF_V6: 1.01M rows × 31 columns)
- Error: `failed to allocate data of size 2.0 MiB (1.7 GiB/1.7 GiB used)`
- RAM usage at 3.4GB, DuckDB-WASM hitting browser memory ceiling
- **Diff view scrolling is sluggish** compared to data preview (dragging scrollbar to a position is slow)

## Root Cause Analysis

### Primary Issue: `SELECT *` Materializes All Columns
The CTEs at lines 610-614 use `SELECT *`, forcing DuckDB to materialize ALL 31 columns:

```sql
-- CURRENT: ~1.5GB for 1M rows × 31 cols × 50 bytes avg
WITH a_numbered AS (
  SELECT *, ROW_NUMBER() OVER () as _row_num FROM sourceTableExpr
),
b_numbered AS (
  SELECT *, ROW_NUMBER() OVER () as _row_num FROM "tableB"
)
```

**Why DuckDB can't optimize this:**
- `ROW_NUMBER() OVER ()` requires full table scan
- CTEs with window functions are always materialized
- Projection pushdown cannot work through materialized CTEs

### Secondary Issue: Cache Accumulation
- `resolvedExpressionCache` (line 17) never cleared between diff sessions
- `original_*` snapshots explicitly skipped in cleanup (line 988)
- File handles stay registered in DuckDB memory

### Tertiary Issue: OFFSET Pagination in Diff Grid (Scrolling)
The diff grid uses OFFSET-based pagination while the main data preview uses keyset pagination:

**Data Preview (Fast - O(1)):**
```typescript
// DataGrid.tsx:497-501 - Jumps directly to cursor position
getDataWithKeyset(tableName, { direction: 'forward', csId: targetCsId }, PAGE_SIZE)
```

**Diff Grid (Slow - O(n)):**
```sql
-- diff-engine.ts:899 - Must scan and skip all rows before offset
LIMIT ${limit} OFFSET ${offset}
```

**Impact:** Scrolling to row 500,000 in diff requires DuckDB to:
1. Scan all 500,000 rows from the diff table
2. Execute 2 LEFT JOINs for each scanned row
3. Discard 499,500 rows
4. Return only 500 visible rows

Additional factors:
- **Two JOINs per page fetch** (`diff-engine.ts:895-896`)
- **Smaller LRU cache** (8 vs 10 pages in `VirtualizedDiffGrid.tsx:63`)
- **Complex cell rendering** (~140 lines vs ~50 lines in `drawCell`)

## Industry Best Practice (2025-2026)

Per DuckDB docs and web search:
1. **Explicit column projection** - Never use `SELECT *` in CTEs with window functions
2. **Reduce threads** - Join-heavy ops need 3-4GB/thread; use `SET threads = 1`
3. **Memory limit** - Set to 50-60% of system memory to avoid OS OOM killer
4. **WASM limitation** - Browser caps at 4GB, no disk spilling for intermediate results

## Implementation Plan

### Change 1: Column Projection in CTEs (PRIMARY FIX)
**File:** `src/lib/diff-engine.ts` lines 607-624

Build explicit column list instead of `SELECT *`:

```typescript
// Before line 607, compute needed columns:
const neededColumns = new Set<string>(['_cs_id'])  // Always need row ID
keyColumns.forEach(c => neededColumns.add(c))      // Join keys
valueColumns.forEach(c => neededColumns.add(c))    // For sharedColModificationExpr

const columnList = [...neededColumns]
  .map(c => `"${c}"`)
  .join(', ')

// Then in the SQL:
const createTempTableQuery = `
  CREATE TEMP TABLE "${diffTableName}" AS
  WITH
    a_numbered AS (
      SELECT ${columnList}, ROW_NUMBER() OVER () as _row_num FROM ${sourceTableExpr}
    ),
    b_numbered AS (
      SELECT ${columnList}, ROW_NUMBER() OVER () as _row_num FROM "${tableB}"
    )
  SELECT ...
`
```

**Memory savings:** 31 cols → ~5-10 cols = **~70-85% reduction**

### Change 2: Reduce Threads for Diff Operations
**File:** `src/lib/diff-engine.ts` around line 629

```typescript
// Before the diff query, reduce threads
await conn.query('SET threads = 1')

try {
  await execute(createTempTableQuery)
} finally {
  // Restore default (let DuckDB auto-detect)
  await conn.query('RESET threads')
}
```

### Change 3: Early Bail on High Memory
**File:** `src/lib/diff-engine.ts` lines 304-306

Change from logging to throwing:

```typescript
if (status.percentage > 85) {
  clearInterval(memoryPollInterval)
  throw new Error(
    `Memory critical (${status.percentage.toFixed(0)}% used). ` +
    `Aborting diff to prevent browser crash. ` +
    `Try reducing table size or closing other tabs.`
  )
}
```

### Change 4: Add Global Cache Clear Function
**File:** `src/lib/diff-engine.ts` after line 17

```typescript
/**
 * Clear all diff caches. Call when diff view closes to free memory.
 */
export function clearDiffCaches(): void {
  const snapshotCount = registeredParquetSnapshots.size
  const cacheCount = resolvedExpressionCache.size
  registeredParquetSnapshots.clear()
  resolvedExpressionCache.clear()
  console.log(`[Diff] Cleared caches: ${snapshotCount} snapshots, ${cacheCount} expressions`)
}
```

### Change 5: Wire Up Cache Cleanup in DiffView
**File:** `src/components/diff/DiffView.tsx` around line 112

```typescript
// After cleanupDiffSourceFiles call:
if (currentSourceTableName) {
  await cleanupDiffSourceFiles(currentSourceTableName)
}
// ADD: Clear all caches when diff view closes
const { clearDiffCaches } = await import('@/lib/diff-engine')
clearDiffCaches()
```

### Change 6: Keyset Pagination for Diff Grid (SCROLLING FIX)
**File:** `src/lib/diff-engine.ts` - Modify `fetchDiffPage` function (~line 880)

The diff table already has `sort_key` column. Use it for keyset pagination:

**Current (OFFSET-based):**
```sql
SELECT ... FROM diff_table
ORDER BY sort_key
LIMIT 500 OFFSET 50000  -- Scans 50,500 rows
```

**New (Keyset-based):**
```sql
SELECT ... FROM diff_table
WHERE sort_key > :lastSortKey  -- Direct B-tree lookup
ORDER BY sort_key
LIMIT 500  -- Only touches 500 rows
```

**Implementation:**

1. **Add `fetchDiffPageWithKeyset` function** in `diff-engine.ts`:
```typescript
export async function fetchDiffPageWithKeyset(
  diffTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  cursor: { sortKey: number | null; direction: 'forward' | 'backward' },
  limit: number,
  keyOrderBy: string | null,
  storageType: 'memory' | 'parquet'
): Promise<{ rows: DiffRow[]; firstSortKey: number; lastSortKey: number }> {
  const whereClause = cursor.sortKey !== null
    ? cursor.direction === 'forward'
      ? `AND d.sort_key > ${cursor.sortKey}`
      : `AND d.sort_key < ${cursor.sortKey}`
    : ''

  const orderDirection = cursor.direction === 'forward' ? 'ASC' : 'DESC'

  // ... build query with cursor-based WHERE instead of OFFSET
}
```

2. **Modify `VirtualizedDiffGrid.tsx`** to track cursor positions:
```typescript
// Add to state
const [cursorCache, setCursorCache] = useState<Map<number, number>>(new Map())
// Map of: pageIndex -> sortKey at start of that page

// In loadPage, use keyset when jumping to a known position
const nearestPage = findNearestCachedPage(targetPage)
if (nearestPage) {
  // Use keyset from cached page
  await fetchDiffPageWithKeyset(..., { sortKey: cursorCache.get(nearestPage), direction: 'forward' })
} else {
  // Fall back to OFFSET for first load or distant jumps
}
```

3. **Cache sort_key values** when pages are loaded to enable fast random access.

**Memory savings:** None (this is a CPU/latency fix, not memory)
**Scroll performance:** ~10-100× faster for large tables

### Change 7: Increase Diff Grid LRU Cache
**File:** `src/components/diff/VirtualizedDiffGrid.tsx` line 63

```typescript
// Current: 8 pages (4000 rows)
const MAX_CACHED_PAGES = 8

// Change to: 12 pages (6000 rows) - closer to main grid's 10
const MAX_CACHED_PAGES = 12
```

**Rationale:** Larger cache reduces expensive re-fetches during scroll. The OOM fix (Change 1) reduces per-row memory, allowing more cached rows.

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/lib/diff-engine.ts` | 607-624 | Column projection in CTEs |
| `src/lib/diff-engine.ts` | 629 | Reduce threads to 1 |
| `src/lib/diff-engine.ts` | 304-306 | Early bail at 85% |
| `src/lib/diff-engine.ts` | after 17 | Add `clearDiffCaches()` export |
| `src/lib/diff-engine.ts` | ~880 | Add `fetchDiffPageWithKeyset()` function |
| `src/components/diff/DiffView.tsx` | ~112 | Call `clearDiffCaches()` on close |
| `src/components/diff/VirtualizedDiffGrid.tsx` | 63 | Increase MAX_CACHED_PAGES to 12 |
| `src/components/diff/VirtualizedDiffGrid.tsx` | ~200 | Use keyset pagination with cursor cache |

## Verification

### Manual Test - OOM Fix
1. Load Raw_Data_HF_V6 (1.01M rows × 31 columns)
2. Apply a transform (e.g., trim a column)
3. Open diff view (Preview Changes)
4. **Expected:** Completes without OOM, peak memory < 2GB

### Manual Test - Scroll Performance
1. Load Raw_Data_HF_V6 (1.01M rows × 31 columns)
2. Apply a transform, open diff view
3. Drag scrollbar from top to ~50% position
4. **Expected:** Grid responds within 200ms (similar to data preview)
5. Drag scrollbar rapidly up and down
6. **Expected:** No significant lag or stuttering

### Memory Profiling
- Watch console for memory poll logs
- Peak should stay under 1.5GB (vs current 1.7GB+ crash)
- After diff close, caches should be cleared

### Regression Tests
```bash
npm run test -- --grep "diff"
```

## Sources
- [DuckDB Memory Management](https://duckdb.org/2024/07/09/memory-management)
- [DuckDB OOM Errors Guide](https://duckdb.org/docs/stable/guides/troubleshooting/oom_errors)
- [DuckDB Tuning Workloads](https://duckdb.org/docs/stable/guides/performance/how_to_tune_workloads)
- [DuckDB CTE Optimization](https://duckdb.org/docs/stable/sql/query_syntax/with)
- [WASM Memory Management](https://www.getorchestra.io/guides/memory-management-in-wasm-applications-for-data-engineering)
- [DuckDB OFFSET Issue #14218](https://github.com/duckdb/duckdb/issues/14218) - Documents slow OFFSET on 115M row dataset
- [Use The Index Luke - No Offset](https://use-the-index-luke.com/no-offset) - OFFSET is fundamentally unscalable
- [Keyset vs Offset Pagination](https://leapcell.io/blog/efficient-data-pagination-keyset-vs-offset) - Keyset is O(1) vs OFFSET's O(n)
