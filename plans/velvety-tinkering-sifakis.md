# RAM Accumulation Investigation: DuckDB-WASM Memory Retention

**Status:** 🔍 DIAGNOSIS - Post-Parquet Implementation
**Branch:** `opfs-ux-polish`
**Date:** January 23, 2026

## Problem Statement

Despite implementing Parquet cold storage snapshots (reducing snapshot RAM from 1.5GB → 5MB), RAM still accumulates to **2.1GB** after just 2 "Standardize Date" operations on a 1M row dataset.

**Expected:**
- Base table: ~1.5GB
- 2 Parquet snapshots: ~10MB (2 × 5MB)
- **Total: ~1.5GB**

**Actual:**
- **RAM usage: 2.1GB** (600MB excess)

---

## Root Cause Analysis

### Finding 1: DuckDB-WASM Known Memory Retention Issue

**Source:** [GitHub Issue #1904](https://github.com/duckdb/duckdb-wasm/issues/1904) (Oct 2024)

> "Memory usage remains high after executing a query and is not released, even after performing additional operations... It seems that DuckDB frees the memory, but the WASM worker does not."

**Impact:** DuckDB properly frees memory internally, but the **WASM worker heap doesn't shrink**, causing browser-reported RAM to stay elevated.

### Finding 2: Column Versioning Expression Chains

**Location:** `src/lib/commands/column-versions.ts`

For Tier 1 transforms (trim, lowercase, uppercase, etc.), columns are versioned with expression chaining:
```typescript
// After 2 transforms on "DateField":
DateField = STANDARDIZE_DATE(STANDARDIZE_DATE(DateField__base))
```

Each expression layer may allocate temporary memory during query execution that isn't released by WASM.

### Finding 3: DuckDB Buffer Pool Accumulation

**Location:** `src/lib/duckdb/memory.ts` line 61

```typescript
SELECT * FROM duckdb_memory()  // Shows memory by component tag
```

DuckDB's buffer pool caches data pages in memory. Even after CHECKPOINT, the WASM heap may not shrink because:
1. WASM linear memory only grows, never shrinks (by design)
2. DuckDB marks blocks as free but WASM doesn't release to browser

### Finding 4: Diff Views Already Protected

**Status:** ✅ No Issue

Diff views are properly dropped immediately after use (executor.ts:303-311).

### Finding 5: Audit Details Already Pruned

**Status:** ✅ No Issue

Audit log pruned to 100 entries on initialization.

---

## Diagnostic Plan

### Phase 1: Memory Profiling

**Goal:** Identify exact source of 600MB excess RAM

**Actions:**
1. **Query `duckdb_memory()` before/after each operation**
   - Track memory by component (buffer_manager, column_data, etc.)
   - Identify which tag accumulates 600MB

2. **Query `duckdb_tables()` to list all tables**
   - Check for orphaned staging tables, diff views, or snapshot tables
   - Verify Parquet snapshots aren't duplicating as in-memory tables

3. **Log column versioning state**
   - Check if expression chains are creating excessive temporary allocations
   - Monitor `__base` column accumulation

**Implementation:**
```typescript
// Add diagnostic logging in executor.ts after command execution:
const memBefore = await getDuckDBMemoryUsage()
const tablesBefore = await getEstimatedTableSizes()

// ... execute command ...

const memAfter = await getDuckDBMemoryUsage()
const tablesAfter = await getEstimatedTableSizes()

console.log('[Memory Diagnostic]', {
  memoryDelta: memAfter.totalBytes - memBefore.totalBytes,
  tableCountDelta: tablesAfter.length - tablesBefore.length,
  byTagDelta: Object.keys(memAfter.byTag).map(tag => ({
    tag,
    delta: memAfter.byTag[tag].memoryBytes - (memBefore.byTag[tag]?.memoryBytes || 0)
  }))
})
```

---

### Phase 2: Aggressive Memory Reclamation Strategy

**Goal:** Force DuckDB to release memory where possible

#### Strategy A: Aggressive Checkpointing

**Current:** CHECKPOINT every 5 batches (250k rows)

**Proposed:** CHECKPOINT after every Tier 3 operation

```typescript
// In executor.ts after Tier 3 command execution:
if (tier === 3) {
  const conn = await getConnection()
  await conn.query('CHECKPOINT')
  console.log('[Memory] Checkpointed after Tier 3 operation')
}
```

**Rationale:** Flushes WAL and potentially releases buffer pool pages

#### Strategy B: Force Column Materialization Earlier

**Current:** Materialize after 10 Tier 1 transforms

**Proposed:** Materialize after 5 transforms for large tables (>500k rows)

```typescript
// In column-versions.ts:
const threshold = ctx.table.rowCount > 500_000 ? 5 : 10

if (versionInfo.expressionStack.length >= threshold) {
  await materializeColumn(...)
}
```

**Rationale:** Reduces expression chain complexity, preventing deep temporary allocations

#### Strategy C: Manual VACUUM After Snapshot Pruning

**Location:** executor.ts `pruneOldestSnapshot()`

```typescript
// After dropping snapshot table:
await dropTable(snapshot.tableName!)
await conn.query('VACUUM')  // Force reclaim freed space
```

**Rationale:** VACUUM reclaims space from deleted tables

#### Strategy D: Clear Result Sets Explicitly

**Issue:** Query results may hold references in WASM

**Proposed:** Explicitly drop large result sets

```typescript
// After capturing audit details:
const result = await conn.query(`SELECT ...`)
const data = result.toArray()
// Process data...
result = null  // Clear reference
```

---

### Phase 3: Alternative - Streaming Operations

**Goal:** Avoid loading full result sets into memory

#### Streaming Audit Capture (DEPRECATED - SEE WARNING)

**⚠️ CRITICAL WARNING:** Do NOT pull data into JavaScript memory only to insert it back. This doubles memory pressure (DuckDB RAM + JS Heap).

**WRONG Approach (Memory Inefficient):**
```typescript
// ❌ BAD: Materializes data in JS heap
const chunk = await conn.query(`SELECT ... LIMIT 10000 OFFSET ${offset}`)
const data = chunk.toArray()  // ❌ Loads into JS memory
// Insert data back...
```

**CORRECT Approach (Pure SQL):**
```typescript
// ✅ GOOD: Data never touches JS heap
for (let offset = 0; offset < totalRows; offset += CHUNK_SIZE) {
  await conn.query(`
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value)
    SELECT
      gen_random_uuid(),
      '${auditEntryId}',
      ROW_NUMBER() OVER () + ${offset},
      '${columnName}',
      previous_value,
      new_value
    FROM (
      SELECT ... FROM table
      WHERE ...
      LIMIT ${CHUNK_SIZE} OFFSET ${offset}
    )
  `)
}
```

**Verdict:** Tier 1 reduction (50k → 10k) likely makes streaming unnecessary. Only implement if diagnostic logging shows audit queries are the bottleneck.

---

### Phase 4: WASM Worker Recreation (Nuclear Option)

**Goal:** Force WASM heap reset by recreating worker

**When:** After Tier 3 operations on large tables (>500k rows)

```typescript
// In executor.ts after Tier 3 command:
if (ctx.table.rowCount > 500_000) {
  // Flush to OPFS first
  await flushDuckDB(true)  // immediate

  // Recreate DuckDB connection (drops WASM worker)
  await recreateDuckDBConnection()

  console.log('[Memory] Recreated WASM worker to release memory')
}
```

**Implementation:**
```typescript
// In duckdb/index.ts:
export async function recreateDuckDBConnection(): Promise<void> {
  if (conn) {
    await conn.close()
    conn = null
  }

  // New connection will create new WASM worker with fresh heap
  conn = await db!.connect()
}
```

**Risk:** High - may cause data loss if not flushed properly

---

## Sources (Web Research)

- [Memory not released in DuckDB-WASM after query execution · Issue #1904](https://github.com/duckdb/duckdb-wasm/issues/1904)
- [Memory Management in DuckDB](https://duckdb.org/2024/07/09/memory-management)
- [Out-of-Core Processing · DuckDB-WASM Discussion #1322](https://github.com/duckdb/duckdb-wasm/discussions/1322)

---

## Recommended Approach

### Tier 1: Low-Risk Improvements (Implement First)

1. ✅ **Reduce audit detail threshold: 50,000 → 10,000 rows**
   - Location: `audit-capture.ts:24` - Change `ROW_DETAIL_THRESHOLD`
   - **Impact:** 80% reduction in audit query processing overhead
   - **Storage:** ~5-10MB saved (only stores modified column, not all 30)
   - **CPU/RAM during query:** Significant reduction (fewer rows to materialize/insert)
   - **No functional loss:** Export already limits to 10k rows (AuditDetailModal.tsx:122)

2. ✅ **Add memory diagnostic logging** - Identify exact source via `duckdb_memory()`
   - **CRITICAL:** Do not skip - confirms which component (buffer_manager, column_data) is accumulating

3. ✅ **CHECKPOINT after Tier 3 operations** - Flush WAL immediately
4. ✅ **Reduce column materialization threshold** for large tables (10 → 5)
5. ✅ **VACUUM after snapshot pruning** - Reclaim freed space

### Tier 2: Medium-Risk Optimizations (If Tier 1 Insufficient)

5. ⚠️ **Stream audit capture in chunks** - Reduce peak memory
6. ⚠️ **Clear large result sets explicitly** - Force GC hints

### Tier 3: High-Risk Nuclear Option (Last Resort)

7. 🚨 **WASM worker recreation** - Force heap reset (data loss risk)

---

## Expected Outcomes (Revised - Conservative Estimate)

**After Tier 1 Improvements:**
- **Audit threshold reduction (50k → 10k):** 80% less query processing overhead
  - **Storage:** ~10-20MB saved (only stores modified column, not all 30)
  - **Processing:** Fewer rows to materialize during `INSERT INTO SELECT` = less WASM heap expansion
  - **Verdict:** The processing overhead reduction is the real win, not just storage
- CHECKPOINT after Tier 3: May reduce WAL buffer accumulation (~50-100MB)
- Earlier materialization: May reduce expression chain overhead (~50-100MB)
- VACUUM after pruning: May reclaim freed table space (~20-50MB)

**Total Expected Reduction:** 120-220MB → **Target RAM: 1.88-1.98GB** (down from 2.1GB)

**Breakdown for 2 "Standardize Date" operations:**
- Before: 2.1GB total
- Base table: 1.5GB (unchanged)
- 2 Parquet snapshots: ~10MB (unchanged)
- **Audit captures (storage):** ~10-20MB (only modified column, 2 ops)
- **Buffer pool / WAL accumulation:** ~500-600MB (the actual culprit)

**Key Insight:** WASM heap doesn't shrink, so even temporary allocations (buffer pool, expression evaluation) expand it. Tier 1 fixes minimize those temporary spikes.

**Limitation:** WASM heap retention is architectural. We can minimize growth but can't force shrinkage without recreating the worker.

---

## Verification Plan

### Test 1: Diagnostic Logging

1. Enable memory diagnostic logging in executor.ts
2. Run 2 Standardize Date operations on 1M row dataset
3. Capture console logs showing:
   - Memory by tag before/after
   - Table count before/after
   - Delta breakdown

### Test 2: With Tier 1 Improvements

1. Implement CHECKPOINT, materialization threshold, VACUUM
2. Run same 2 operations
3. Compare RAM usage vs baseline (2.1GB)
4. Target: <1.9GB

### Test 3: Stress Test (10 Operations)

1. Run 10 Tier 3 operations in sequence
2. Monitor RAM growth rate
3. Verify snapshot pruning activates
4. Ensure RAM plateaus (not linear growth)

---

## Files to Modify

### Tier 1 (Required - Low Risk)

1. **src/lib/commands/audit-capture.ts** ⭐ **CRITICAL - BIGGEST IMPACT**
   - Change `ROW_DETAIL_THRESHOLD` from 50,000 → 10,000 (1 line)
   - Update comment to reflect new threshold
   - **Expected savings:** ~400MB for 2 operations

2. **src/lib/commands/executor.ts**
   - Add memory diagnostic logging (~30 lines)
   - Add CHECKPOINT after Tier 3 execution (~5 lines)
   - Add VACUUM after snapshot pruning (~2 lines)

3. **src/lib/commands/column-versions.ts**
   - Reduce materialization threshold for large tables (>500k: 10 → 5) (~5 lines)

**Tier 1 Total:** 3 files, ~45 lines

### Tier 2 (Optional - If Tier 1 Insufficient)

4. **src/lib/audit-capture.ts**
   - Implement streaming audit capture (~50 lines)

### Tier 3 (Nuclear Option - Last Resort)

5. **src/lib/duckdb/index.ts**
   - Implement recreateDuckDBConnection() (~20 lines)

---

## Risk Assessment

### Tier 1: Very Low Risk
- Diagnostic logging: Read-only queries
- CHECKPOINT: Safe, standard DuckDB operation
- VACUUM: Safe after table deletion
- Materialization threshold: Already tested pattern

### Tier 2: Low-Medium Risk
- Streaming audit: More complex, may slow down operations
- Explicit GC hints: May not work, no downside

### Tier 3: High Risk
- Worker recreation: Data loss if OPFS flush fails
- Only use if Tier 1/2 insufficient

---

## Open Questions

1. **Which duckdb_memory() tag is accumulating?**
   - Need diagnostic logging to identify

2. **Are Parquet snapshots accidentally duplicated as in-memory tables?**
   - Check via `duckdb_tables()` query

3. **Is the 600MB from expression chain temporary allocations?**
   - Monitor before/after column versioning operations

4. **Can we force WASM heap compaction without worker recreation?**
   - Research WASM linear memory compaction techniques

---

## Next Steps

**Phase 1: Diagnosis (30 min)**
1. Implement memory diagnostic logging
2. Run test scenario
3. Identify exact source of 600MB

**Phase 2: Implement Tier 1 Fixes (1 hour)**
4. Add CHECKPOINT after Tier 3
5. Reduce materialization threshold
6. Add VACUUM after pruning

**Phase 3: Verification (30 min)**
7. Test with 1M row dataset
8. Verify RAM reduction
9. Stress test with 10 operations

**Total Time:** 2 hours
