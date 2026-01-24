# Fix Diff Memory Issue for Large Tables (1M+ Rows)

**Status:** 🎯 READY FOR IMPLEMENTATION
**Branch:** `opfs-ux-polish`
**Date:** January 23, 2026

## Problem Statement

Diff operation fails with memory error when comparing 1M x 1M row tables:

```
Error: Diff operation requires ~11.66 GB but only 614.40 MB available.
```

**Current behavior:**
- Pre-flight memory check blocks diff at validation
- Formula estimates 2x more memory than actually needed
- No chunking/batching strategy for large tables
- Users cannot compare tables > 500k rows

**User impact:** Critical feature is unusable for production datasets

---

## Executive Summary

### The Solution: Narrow Diff Table Strategy

**Problem:** Diff stores ALL columns from both tables → 12 GB for 1M x 1M rows
**Solution:** Store only metadata (row IDs + status) → 26 MB for 1M x 1M rows
**Result:** 500x memory reduction, enables diffs up to 10M+ rows

**How it works:**
1. **CREATE:** Run FULL OUTER JOIN once, but only SELECT row IDs + diff status (narrow table)
2. **FETCH:** Grid paginates 500 rows at a time, JOINs back to original tables for actual data
3. **Memory:** ~26 MB metadata + ~3 MB per page = ~30 MB total (vs 12 GB before!)

**Implementation:** ~230 lines modified across 3 files, 3-4 hours work

**Risk:** Low (proven JOIN pattern, graceful degradation, easy rollback)

---

## Root Cause Analysis

### Finding 1: Memory Estimation Bug (2x Too High)

**Location:** `src/lib/diff-engine.ts:108-113`

```typescript
// ❌ WRONG: Assumes Cartesian product
const estimatedRows = Number(rows_a) + Number(rows_b)
const estimatedCols = Number(cols_a) + Number(cols_b)
const estimatedBytes = estimatedRows * estimatedCols * 100
```

**For 1M x 1M table with 30 columns:**
- Current: `(1M + 1M) × (30 + 30) × 100 = 12 GB` ❌
- Correct: `max(1M, 1M) × (30 + 30) × 50 = 3 GB` ✅

**Why it's wrong:**
- FULL OUTER JOIN produces `max(rows_a, rows_b)` rows, not sum
- Uses 100 bytes/cell instead of `AVG_BYTES_PER_CELL` (50 bytes)
- Doesn't account for DuckDB's zstd compression (~3-5x reduction)

### Finding 2: DuckDB-WASM Disk Spilling Not Functional

**Research findings:**
- Native DuckDB has robust external hash joins with disk spilling
- WASM build has `temp_directory` configured but **NOT FUNCTIONAL** yet
- Source: [DuckDB-WASM Discussion #1322](https://github.com/duckdb/duckdb-wasm/discussions/1322)

**Impact:** Cannot rely on DuckDB's out-of-core processing for large diffs

### Finding 3: Proven Batching Patterns Exist in Codebase

**Batch Executor** (`batch-executor.ts`):
- Processes 50k rows per batch
- WAL checkpoints every 5 batches (250k rows)
- Staging table pattern for atomic operations
- Proven to handle 1M+ row operations

**Fuzzy Matcher** (`fuzzy-matcher.ts`):
- Block-based chunking with progress callbacks
- Adaptive strategies based on block size
- Successfully handles 2M+ row datasets

**Pattern:** Both use bounded memory per iteration + progress reporting + browser yielding

---

## Solution Design: Narrow Diff Table Strategy

### The Breakthrough: Store Metadata, Not Data

**Current Problem:**
```sql
-- Creates 12GB temp table with ALL columns from both tables
CREATE TEMP TABLE _diff_xyz AS
SELECT
  a.col1 as a_col1, b.col1 as b_col1,  -- Duplicate all 30 columns!
  a.col2 as a_col2, b.col2 as b_col2,
  ... -- 60 total columns
FROM table_a a FULL OUTER JOIN table_b b ON key
```

**Memory:** 1M rows × 60 columns × 100 bytes = **12 GB** 💥

**New Solution:**
```sql
-- Creates 24MB temp table with ONLY row IDs and status
CREATE TEMP TABLE _diff_xyz AS
SELECT
  COALESCE(a._cs_id, b._cs_id) as row_id,  -- 16 bytes UUID
  CASE
    WHEN a._cs_id IS NULL THEN 'added'      -- ~10 bytes VARCHAR
    WHEN b._cs_id IS NULL THEN 'removed'
    WHEN <value_diff> THEN 'modified'
    ELSE 'unchanged'
  END as diff_status
FROM table_a a FULL OUTER JOIN table_b b ON key_columns
```

**Memory:** 1M rows × (16 + 10) bytes = **26 MB** ✅ (500x reduction!)

### How It Works

**Phase 1: Create Narrow Diff Table (One-Time)**
```typescript
// Run FULL OUTER JOIN once, but only store metadata
await conn.query(`
  CREATE TEMP TABLE "${diffTableName}" AS
  SELECT
    COALESCE(a."_cs_id", b."_cs_id") as row_id,
    CASE
      WHEN a."_cs_id" IS NULL THEN 'added'
      WHEN b."_cs_id" IS NULL THEN 'removed'
      WHEN ${valueComparisonPredicate} THEN 'modified'
      ELSE 'unchanged'
    END as diff_status,
    a."_cs_id" as a_row_id,  -- Track which table each row came from
    b."_cs_id" as b_row_id
  FROM "${sourceTableName}" a
  FULL OUTER JOIN "${targetTableName}" b
  ON ${keyJoinCondition}
`)

// Memory: ~26 MB for 1M rows (vs 12 GB previously)
```

**Phase 2: Fetch Data On-Demand (Paginated)**
```typescript
// Grid requests 500 visible rows → JOIN back to original tables
async function fetchDiffPage(offset: number, limit: number) {
  return await conn.query(`
    SELECT
      d.diff_status,
      a.*,  -- All columns from table A (when row exists)
      b.*   -- All columns from table B (when row exists)
    FROM "${diffTableName}" d
    LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status != 'unchanged'  -- Filter out noise
    ORDER BY d.diff_status, d.row_id
    LIMIT ${limit} OFFSET ${offset}
  `)
}

// Memory per fetch: 500 rows × 60 cols × 100 bytes = 3 MB
```

### Key Benefits

1. **Massive Memory Savings**: 26 MB vs 12 GB (500x reduction)
2. **Single JOIN**: Still one FULL OUTER JOIN (fast), just different SELECT
3. **On-Demand Data**: Grid only loads visible 500 rows at a time
4. **Scales to Any Size**: 10M rows? Still ~260 MB for metadata
5. **No Chunking Needed**: Avoids complex range partitioning logic
6. **DuckDB Optimized**: Leverages native query optimization

### Implementation Details

**Value Comparison Predicate:**
```typescript
// Detect if ANY non-key column differs between A and B
const valueComparisonPredicate = nonKeyColumns
  .map(col => `a."${col}" IS DISTINCT FROM b."${col}"`)
  .join(' OR ')

// Example: (a."name" IS DISTINCT FROM b."name" OR a."age" IS DISTINCT FROM b."age")
```

**Why `IS DISTINCT FROM`?**
- Handles NULLs correctly: `NULL != NULL` is FALSE, but `NULL IS DISTINCT FROM NULL` is FALSE
- `NULL IS DISTINCT FROM 'value'` is TRUE (correctly detects as modified)

**Memory Calculation:**
```typescript
// Update validateDiffMemoryAvailability()
const estimatedRows = Math.max(Number(rows_a), Number(rows_b))
const metadataBytes = estimatedRows * (16 + 10)  // UUID + status VARCHAR(10)
const summaryQueryBytes = estimatedRows * 20     // Aggregate temp buffers

const totalEstimate = metadataBytes + summaryQueryBytes
// 1M rows: (16 + 10) * 1M + 20M = 46 MB (vs 12 GB old estimate!)
```

---

## Implementation Plan

### Phase 1: Update Memory Validation (15 minutes)

**File:** `src/lib/diff-engine.ts` (lines 90-144)

**Changes to `validateDiffMemoryAvailability()`:**

1. **Update memory calculation** (lines 108-113):
```typescript
// NEW: Narrow table stores only metadata (row IDs + status)
const estimatedRows = Math.max(Number(rows_a), Number(rows_b))  // Fix: use max, not sum
const metadataBytes = estimatedRows * (16 + 10)  // UUID (16) + status VARCHAR(10)
const summaryQueryBytes = estimatedRows * 20     // Aggregate temp buffers
const estimatedBytes = metadataBytes + summaryQueryBytes

// Example: 1M rows = 26 MB + 20 MB = 46 MB (vs 12 GB old!)
```

2. **Relax threshold** (line 131):
```typescript
const threshold = availableBytes * 0.9  // Narrow table uses minimal memory
```

3. **Update error message** (lines 134-142):
```typescript
throw new Error(
  `Diff requires ~${formatBytes(estimatedBytes)} metadata storage but only ${formatBytes(availableBytes)} available.\n\n` +
  `Note: This is just for diff metadata. Actual data is loaded on-demand (500 rows at a time).\n` +
  `Current size: ${rows_a.toLocaleString()} vs ${rows_b.toLocaleString()} rows`
)
```

### Phase 2: Modify Diff Table Creation (1-2 hours)

**File:** `src/lib/diff-engine.ts` (lines 297-354)

**Current Code (lines 297-321):**
```typescript
// ❌ OLD: Creates massive table with all columns duplicated
await withDuckDBLock(async () => {
  await conn.query(`
    CREATE TEMP TABLE "${diffTableName}" AS
    SELECT
      ${joinSelect}  -- All columns from both tables (60+ columns!)
    FROM "${sourceTableName}" a
    FULL OUTER JOIN "${targetTableName}" b
    ON ${keyJoinCondition}
    LIMIT ${ROW_LIMIT_FOR_DIFF}
  `)
})
```

**New Code:**
```typescript
// ✅ NEW: Creates narrow table with only metadata
await withDuckDBLock(async () => {
  // Build value comparison predicate
  const nonKeyColumns = sourceColumns.filter(col => !keyColumns.includes(col))
  const valueComparisonPredicate = nonKeyColumns
    .map(col => `a."${col}" IS DISTINCT FROM b."${col}"`)
    .join(' OR ')

  await conn.query(`
    CREATE TEMP TABLE "${diffTableName}" AS
    SELECT
      COALESCE(a."_cs_id", b."_cs_id") as row_id,
      a."_cs_id" as a_row_id,
      b."_cs_id" as b_row_id,
      CASE
        WHEN a."_cs_id" IS NULL THEN 'added'
        WHEN b."_cs_id" IS NULL THEN 'removed'
        WHEN (${valueComparisonPredicate}) THEN 'modified'
        ELSE 'unchanged'
      END as diff_status
    FROM "${sourceTableName}" a
    FULL OUTER JOIN "${targetTableName}" b
    ON ${keyJoinCondition}
    LIMIT ${ROW_LIMIT_FOR_DIFF}
  `)
})
```

### Phase 3: Update Pagination Query (1 hour)

**File:** `src/lib/diff-engine.ts` (lines 405-448)

**Current `fetchDiffPage()` (lines 405-417):**
```typescript
// ❌ OLD: Fetches from pre-materialized wide table
const result = await conn.query(`
  SELECT * FROM "${tempTableName}"
  WHERE _change_type != 'unchanged'
  ORDER BY ${keyOrderBy}
  LIMIT ${limit} OFFSET ${offset}
`)
```

**New `fetchDiffPage()`:**
```typescript
// ✅ NEW: JOINs back to original tables for visible rows only
export async function fetchDiffPage(
  tempTableName: string,
  sourceTableName: string,
  targetTableName: string,
  keyOrderBy: string,
  offset: number,
  limit: number = 500
): Promise<DiffRow[]> {
  await ensureDuckDB()
  const conn = await getConnection()

  const result = await conn.query<DiffRow>(`
    SELECT
      d.diff_status as _change_type,
      d.row_id as _row_id,
      a.*,  -- All columns from source table
      b.*   -- All columns from target table
    FROM "${tempTableName}" d
    LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status != 'unchanged'
    ORDER BY ${keyOrderBy}
    LIMIT ${limit} OFFSET ${offset}
  `)

  return result.toArray().map(row => row.toJSON() as DiffRow)
}

// Memory per page: 500 rows × 60 cols × 100 bytes = 3 MB (vs 1.2 GB for full table!)
```

### Phase 4: Update Summary Query (30 minutes)

**File:** `src/lib/diff-engine.ts` (lines 356-377)

**Current summary query:**
```typescript
// Works as-is! Just queries the narrow metadata table
const summaryResult = await conn.query(`
  SELECT _change_type, COUNT(*) as count
  FROM "${diffTableName}"
  GROUP BY _change_type
`)
```

**Update column name:**
```typescript
// Change _change_type → diff_status to match new schema
const summaryResult = await conn.query(`
  SELECT diff_status, COUNT(*) as count
  FROM "${diffTableName}"
  GROUP BY diff_status
`)
```

### Phase 5: Update Function Signatures (15 minutes)

**File:** `src/lib/diff-engine.ts`

**Update `fetchDiffPage` signature** (line 405):
```typescript
// OLD:
export async function fetchDiffPage(
  tempTableName: string,
  keyOrderBy: string,
  offset: number,
  limit?: number
)

// NEW: Add source/target table names for JOIN
export async function fetchDiffPage(
  tempTableName: string,
  sourceTableName: string,
  targetTableName: string,
  keyOrderBy: string,
  offset: number,
  limit?: number
)
```

**Update `DiffConfig` interface** (types):
```typescript
export interface DiffConfig {
  diffTableName: string
  sourceTableName: string  // NEW: needed for pagination JOIN
  targetTableName: string  // NEW: needed for pagination JOIN
  keyColumns: string[]
  summary: DiffSummary
  totalDiffRows: number
}
```

### Phase 6: Update VirtualizedDiffGrid (30 minutes)

**File:** `src/components/diff/VirtualizedDiffGrid.tsx`

**Update data fetching** (find `fetchDiffPage` calls):
```typescript
// OLD:
const rows = await fetchDiffPage(diffTableName, keyOrderBy, offset, limit)

// NEW: Pass source/target tables
const rows = await fetchDiffPage(
  diffTableName,
  config.sourceTableName,
  config.targetTableName,
  keyOrderBy,
  offset,
  limit
)
```

### Phase 7: Update DiffView Store (15 minutes)

**File:** `src/components/diff/DiffView.tsx` (lines 150-158)

**Update store when diff completes:**
```typescript
// Add source/target table names to config
setDiffConfig({
  diffTableName: result.diffTableName,
  sourceTableName,      // NEW
  targetTableName,      // NEW
  keyColumns,
  summary: result.summary,
  totalDiffRows: result.totalDiffRows,
})
```

---

## Verification Plan

### Test 1: Memory Validation Passes

**Goal:** Verify new estimation allows 1M+ row diffs

**Steps:**
1. Load 1M row table A (30 columns)
2. Load 1M row table B (30 columns)
3. Run diff pre-flight check
4. **Verify:** Passes validation (estimate ~46 MB < 614 MB available)

**Expected console output:**
```
[Diff] Memory check: 46 MB required, 614 MB available ✓
[Diff] Creating narrow diff table...
```

### Test 2: Narrow Table Schema Correct

**Goal:** Verify temp table has minimal columns

**Steps:**
1. Run diff on 1M x 1M tables
2. Query temp table schema:
   ```sql
   SELECT * FROM information_schema.columns
   WHERE table_name = '_diff_xyz'
   ```
3. **Verify:** Only 4 columns exist:
   - `row_id` (UUID)
   - `a_row_id` (UUID)
   - `b_row_id` (UUID)
   - `diff_status` (VARCHAR)

**NOT 60+ columns like before!**

### Test 3: Pagination JOIN Works

**Goal:** Verify grid fetches correct data via JOIN

**Steps:**
1. Run diff with some modified/added/removed rows
2. Open diff grid (loads first 500 rows)
3. Inspect network/console for SQL query
4. **Verify:** Query uses LEFT JOIN to source/target tables
5. **Verify:** Grid displays actual column values (not NULL)

**Expected SQL pattern:**
```sql
SELECT d.diff_status, a.*, b.*
FROM _diff_xyz d
LEFT JOIN table_a a ON d.a_row_id = a._cs_id
LEFT JOIN table_b b ON d.b_row_id = b._cs_id
LIMIT 500
```

### Test 4: Memory Usage During Operation

**Goal:** Confirm actual memory usage matches estimate

**Steps:**
1. Open Chrome DevTools → Memory Profiler
2. Take heap snapshot before diff
3. Run 1M x 1M diff
4. Take heap snapshot after diff creation (before pagination)
5. **Verify:** Memory increase ~50-100 MB (vs 12 GB old!)

**Breakdown:**
- Narrow table: ~26 MB
- DuckDB buffers: ~20-50 MB
- **Total: ~46-76 MB**

### Test 5: Large Dataset Stress Test

**Goal:** Verify scalability to extreme sizes

**Steps:**
1. Load 2M row table A
2. Load 2M row table B
3. Run diff
4. **Verify:** Completes without OOM
5. **Verify:** Memory usage ~100-150 MB (2M rows × 26 bytes)
6. **Verify:** Grid pagination works correctly

### Test 6: Summary Counts Accurate

**Goal:** Verify summary query produces correct counts

**Steps:**
1. Create test dataset with known diff:
   - 100 added rows (in B, not A)
   - 50 removed rows (in A, not B)
   - 200 modified rows (different values)
   - 650 unchanged rows (identical)
2. Run diff
3. **Verify:** Summary shows:
   ```
   added: 100
   removed: 50
   modified: 200
   unchanged: 650
   ```

### Test 7: Export Still Works

**Goal:** Verify streaming export adapts to new schema

**Steps:**
1. Run diff on 1M x 1M tables
2. Click "Export Diff Results"
3. **Verify:** Export completes (uses `streamDiffResults` generator)
4. **Verify:** CSV contains actual column values (not just metadata)
5. **Verify:** Memory stays bounded during export (~60 MB for 10k chunks)

---

## Critical Files to Modify

### Core Engine Changes

1. **`src/lib/diff-engine.ts`** (~200 lines modified)
   - **Lines 90-144:** Update `validateDiffMemoryAvailability()` - new memory calculation
   - **Lines 297-321:** Modify temp table creation - narrow schema (metadata only)
   - **Lines 356-377:** Update summary query - change column name to `diff_status`
   - **Lines 405-448:** Rewrite `fetchDiffPage()` - add JOIN back to source/target tables
   - **Lines 30-50:** Update types - add source/target table names to `DiffConfig`

### UI Integration Changes

2. **`src/components/diff/VirtualizedDiffGrid.tsx`** (~20 lines modified)
   - Update all `fetchDiffPage` calls to pass source/target table names
   - Column mapping for joined results (a.col1, b.col1 naming)

3. **`src/components/diff/DiffView.tsx`** (~10 lines modified)
   - Lines 150-158: Add source/target table names when setting `diffConfig`
   - Pass table names to VirtualizedDiffGrid component

### Type Definitions

4. **`src/lib/diff-engine.ts`** (type interfaces)
   - Update `DiffConfig` interface: add `sourceTableName` and `targetTableName`
   - Update `fetchDiffPage` signature: add table name parameters

**Total estimated changes:** ~230 lines across 3 files

---

## Performance Targets

### After Narrow Diff Table Implementation

| Table Size | Metadata Table Size | Pagination Memory | Expected Result | Time |
|------------|---------------------|-------------------|-----------------|------|
| 500k x 500k | 13 MB | 3 MB/page | ✅ Success | 2-3s |
| 1M x 1M | 26 MB | 3 MB/page | ✅ Success | 5-8s |
| 2M x 2M | 52 MB | 3 MB/page | ✅ Success | 10-15s |
| 5M x 5M | 130 MB | 3 MB/page | ✅ Success | 30-40s |
| 10M x 10M | 260 MB | 3 MB/page | ✅ Success | 60-90s |

**Key Points:**
- **Metadata table**: Stores only row IDs + status (~26 bytes/row)
- **Pagination memory**: 500 visible rows × 60 cols × 100 bytes = 3 MB per fetch
- **Total peak memory**: metadata + pagination = 29 MB for 1M rows (vs 12 GB old!)
- **Scalability**: Linear growth (260 MB for 10M rows, well within 2.3GB WASM heap)

### Memory Breakdown (1M x 1M Example)

| Component | Size | Notes |
|-----------|------|-------|
| Narrow diff table | 26 MB | 1M rows × (16 byte UUID + 10 byte VARCHAR) |
| Summary aggregation | 20 MB | Temporary buffer for COUNT GROUP BY |
| Grid pagination (500 rows) | 3 MB | Fetched on-demand via JOIN |
| **Total** | **49 MB** | **500x smaller than 12 GB!** |

### Performance Characteristics

**CREATE Phase (One-Time):**
- Still a single FULL OUTER JOIN (fast)
- DuckDB optimizes with hash join + radix partitioning
- 1M x 1M: ~5-8 seconds (same as before)
- 10M x 10M: ~60-90 seconds (acceptable for large datasets)

**FETCH Phase (Per Page):**
- JOIN 500 rows from metadata → source/target tables
- ~50-100ms per page (imperceptible to user)
- Infinite scroll feels instant

**Export Phase (Streaming):**
- Uses existing `streamDiffResults()` generator
- Fetches in 10k chunks via JOIN
- Memory-bounded at ~60 MB (10k rows × 60 cols)

---

## Risk Assessment

### Overall Risk: Low

**Code Changes:** ~230 lines modified across 3 files
**Complexity:** Medium (SQL schema change + pagination refactor)
**Breaking Changes:** None (internal implementation only)

### Specific Risks & Mitigations

#### Risk 1: JOIN Performance on Pagination
**Concern:** LEFT JOIN for every page fetch might be slow

**Mitigation:**
- DuckDB indexes `_cs_id` column (primary key)
- JOIN on indexed column is fast (~50ms for 500 rows)
- Only fetches visible rows, not entire dataset
- Testing will measure actual performance

**Verdict:** Low risk (proven pattern in DuckDB)

#### Risk 2: Column Name Collisions
**Concern:** `SELECT a.*, b.*` may have duplicate column names

**Mitigation:**
- DuckDB automatically qualifies duplicate columns (`a.name`, `b.name`)
- Grid already handles prefixed columns from old wide schema
- Test with tables that have identical column names

**Verdict:** Low risk (existing grid logic handles this)

#### Risk 3: NULL Handling in JOINs
**Concern:** LEFT JOIN may produce NULLs for added/removed rows

**Expected behavior:**
- Added rows: `a.*` is NULL, `b.*` has data ✓
- Removed rows: `a.*` has data, `b.*` is NULL ✓
- Modified rows: Both have data ✓

**Mitigation:**
- Grid already handles NULL cells (displays empty)
- Add test case for added/removed rows

**Verdict:** Very low risk (desired behavior)

#### Risk 4: Memory Estimation Still Wrong
**Concern:** New formula might still under/overestimate

**Mitigation:**
- Conservative: Add 20 MB buffer for temp aggregations
- Fail gracefully: If OOM at runtime, user sees error (no crash)
- Monitoring: Track actual vs estimated memory in production

**Verdict:** Low risk (conservative estimation + graceful failure)

#### Risk 5: Export Streaming Breaks
**Concern:** `streamDiffResults()` expects old wide schema

**Mitigation:**
- Update generator to use same JOIN pattern
- Test export with 1M row diff
- Verify CSV contains actual data, not just metadata

**Verdict:** Medium risk (requires code change to streaming export)

### Rollback Plan

If narrow diff table causes issues:

1. **Immediate:** Revert PR (git revert)
2. **Quick fix:** Add feature flag `USE_NARROW_DIFF` (default: false)
3. **Gradual rollout:** Enable for <100k row diffs first, monitor stability

---

## Open Questions

### Q1: Should we keep ROW_LIMIT_FOR_DIFF?

**Current:** Diff is limited to 10M rows max (line 19 in diff-engine.ts)

**Options:**
A. **Keep limit** - Safety valve for extreme cases (20M+ rows)
B. **Remove limit** - Narrow table handles any size gracefully

**Recommendation:** Keep limit at 10M but increase if users hit it

### Q2: How to handle duplicate column names in JOIN?

**Example:** Both tables have column "name"

**DuckDB behavior:**
```sql
SELECT a.*, b.* FROM table_a a JOIN table_b b
-- Result columns: a.name, a.age, b.name, b.age
```

**Grid handling:**
- Already shows prefixed columns in old schema (`a_name`, `b_name`)
- Need to verify grid handles DuckDB's automatic prefixing

**Action:** Test with identical column names in both tables

### Q3: Should export include unchanged rows?

**Current:** Export filters `WHERE _change_type != 'unchanged'`

**Options:**
A. **Keep filter** - Only export changes (smaller file)
B. **Add option** - Checkbox "Include unchanged rows"

**Recommendation:** Keep current behavior (only changes)

---

## Sources

Research based on:
- [Memory Management in DuckDB](https://duckdb.org/2024/07/09/memory-management)
- [Tuning Workloads – DuckDB](https://duckdb.org/docs/stable/guides/performance/how_to_tune_workloads)
- [Out-of-Core Processing · DuckDB-WASM Discussion #1322](https://github.com/duckdb/duckdb-wasm/discussions/1322)
- [DuckDB + Arrow Chunking Strategies](https://medium.com/@daniar.achakeyev/duckdb-arrow-how-i-approach-chunking-and-materialization-for-large-datasets-d57f927ef3d4)
- [Larger than memory joins · Discussion #3820](https://github.com/duckdb/duckdb/discussions/3820)
- [Join Processing | DuckDB DeepWiki](https://deepwiki.com/duckdb/duckdb/8.1-join-processing)

---

## Next Steps

### Immediate (Today - 3-4 hours)

**Phase 1: Core Implementation**
1. ✅ Update memory validation (15 min)
   - Fix estimation formula in `validateDiffMemoryAvailability()`
   - New calculation: metadata bytes + temp buffers

2. ✅ Modify diff table creation (1-2 hours)
   - Rewrite temp table SQL to store only metadata
   - Build value comparison predicate with `IS DISTINCT FROM`
   - Test narrow table creation with 1M rows

3. ✅ Update pagination query (1 hour)
   - Rewrite `fetchDiffPage()` to JOIN source/target tables
   - Update function signature (add table name parameters)
   - Update `DiffConfig` type interface

4. ✅ Update UI integration (30 min)
   - Pass source/target table names from DiffView
   - Update VirtualizedDiffGrid calls to `fetchDiffPage()`
   - Handle column name prefixing in grid

**Phase 2: Testing & Validation** (1-2 hours)
5. Test with 1M x 1M dataset
   - Verify memory validation passes
   - Verify narrow table schema (4 columns only)
   - Verify pagination JOIN works correctly
   - Check actual memory usage (~50 MB)

6. Test edge cases
   - Tables with duplicate column names
   - Added/removed/modified rows display correctly
   - Export still works with streaming generator

### Short-term (This Week)

**Day 1-2: Deployment**
7. Create PR with detailed testing notes
8. Code review with focus on:
   - SQL correctness (IS DISTINCT FROM predicate)
   - JOIN performance on large datasets
   - Memory validation accuracy
9. Merge and deploy to staging

**Day 3-5: Monitoring**
10. Monitor production diff operations
11. Track memory usage patterns
12. Gather user feedback on:
    - Diff speed (CREATE phase)
    - Grid scrolling performance (FETCH phase)
    - Any edge case failures

### Medium-term (If Issues Arise)

**Contingency Plans:**

**If JOIN performance is slow:**
- Add indexes on `_cs_id` columns (should already exist)
- Reduce page size from 500 → 250 rows
- Add caching layer for frequently accessed pages

**If memory estimation still wrong:**
- Add telemetry to track actual vs estimated
- Adjust formula multiplier based on real data
- Add progressive warnings (60%, 80%, 95% thresholds)

**If export breaks:**
- Update `streamDiffResults()` generator to use JOIN
- Follow same pattern as `fetchDiffPage()`
- Test with 1M row export

### Long-term (Future Enhancements)

**Potential Optimizations:**

1. **Materialized JOINs for static diffs**
   - If user isn't modifying tables, cache joined pages
   - Trade-off: More memory vs faster scrolling

2. **Diff result persistence**
   - Save narrow diff table to OPFS
   - Allow re-opening diffs without re-running
   - Similar to Parquet snapshot pattern

3. **Smart pagination prefetching**
   - Fetch next page while user views current page
   - Preload common navigation patterns (scroll down)
   - Cache last 3 pages in memory

4. **DuckDB-WASM disk spilling**
   - Track DuckDB-WASM roadmap for spilling support
   - When available, remove ROW_LIMIT_FOR_DIFF constraint
   - Simplify memory validation (trust DuckDB more)
