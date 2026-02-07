# Phase 2: Shard-Based Transform Engine

## Context

CleanSlate Pro's transform engine currently hits **~1GB peak memory** when transforming 1M-row tables. The executor uses OFFSET/LIMIT batching on the full DuckDB table, which requires both the source table (~500MB) and a growing staging table (~500MB) to be resident simultaneously. For 2M+ rows, this causes OOM crashes.

Sprints 1-3 built the zero-resident foundation: micro-shard storage (50k-row Arrow IPC shards in OPFS), ChunkManager (row-budget LRU for shard-by-shard access), and an index-first diff engine that processes snapshots shard-by-shard with only ~280MB peak. Phase 2 applies the same pattern to the transform engine.

**Goal**: Peak memory during transforms drops from **~1GB to ~150MB** for 1M-row tables. Individual transform commands don't change. The shard path is transparent — it lives inside `batch-utils.ts`.

---

## How It Works (Product-Level Summary)

**Today**: When you apply a transform to a large table, the app holds the entire table in memory AND builds a complete copy with the changes applied — doubling memory usage.

**After Phase 2**: The app saves the current table to disk first, frees memory, then processes 50,000 rows at a time — reading a small chunk, transforming it, writing the result to disk, and moving to the next chunk. Peak memory is ~150MB instead of ~1GB, regardless of table size.

The user experience is the same except for a progress indicator: "Processing shard 5/20" during large transforms.

---

## Architecture Decision: Drop-and-Rebuild

Instead of keeping the active DuckDB table resident during the transform, we:

1. **Ensure** the OPFS snapshot is current (it always is — persistence auto-saves)
2. **DROP** the live DuckDB table (frees ~500MB)
3. **Process** shards: load 1 shard → transform → write output shard to OPFS → evict → next
4. **Rebuild** the DuckDB table from the new OPFS snapshot

**Why drop?** If we keep the source table, peak is source (500MB) + transform buffers (50MB) = 550MB. By dropping first, peak is only 1 input shard (50MB) + 1 output shard (50MB) + buffers = ~150MB.

**Safety**: The OPFS snapshot is the durable copy. The executor already creates a pre-snapshot for undo before reaching the batch path. If the process dies mid-transform, the old snapshot is untouched.

---

## Which Transforms Get the Shard Path?

Only transforms where each row is independent (no cross-row dependencies):

| Shard-Parallel | Not Shard-Parallel |
|---|---|
| trim, uppercase, lowercase, title_case, sentence_case | remove_duplicates (needs all rows for dedup) |
| replace, replace_empty, collapse_spaces | fill_down (reads previous row) |
| cast_type, pad_zeros, split_column, combine_columns | custom_sql (arbitrary SQL may need full table) |
| standardize_date, calculate_age, fix_negatives | excel_formula (window functions) |
| hash, mask, redact, last4, zero, scramble | combine:stack, combine:join, match:merge |

Non-parallel transforms stay on the existing OFFSET batch path (no change).

---

## Implementation Steps

### Step 1: `exportSingleShard()` in `snapshot-storage.ts`

New function to write one DuckDB temp table as a single Arrow IPC shard file to OPFS. This is the output side of the shard pipeline — each transformed shard gets written directly to disk.

```typescript
export async function exportSingleShard(
  conn: AsyncDuckDBConnection,
  tableName: string,        // DuckDB temp table with one shard of transformed data
  snapshotId: string,       // Output snapshot ID (temp, e.g., "_xform_my_table_1707...")
  shardIndex: number        // 0, 1, 2...
): Promise<ShardInfo>       // Returns metadata for manifest construction
```

Uses the same atomic `.tmp` → rename pattern as `exportTableToSnapshot`.

**File**: `src/lib/opfs/snapshot-storage.ts`

---

### Step 2: `swapSnapshots()` in `snapshot-storage.ts`

New function to atomically replace one snapshot with another: delete old shards/manifest, rename new shards to the original snapshot ID.

```typescript
export async function swapSnapshots(
  oldSnapshotId: string,    // The original snapshot (will be deleted)
  newSnapshotId: string,    // The temp output snapshot (will be renamed)
  finalSnapshotId: string   // What the output should be renamed to (usually = oldSnapshotId)
): Promise<void>
```

**File**: `src/lib/opfs/snapshot-storage.ts`

---

### Step 3: `runShardTransform()` in `batch-utils.ts`

Core new function — the shard-based transform orchestrator:

```typescript
async function runShardTransform(
  ctx: CommandContext,
  buildSelectQuery: (sourceTableName: string) => string,
  sampleQuery?: string
): Promise<ExecutionResult>
```

**Algorithm**:
1. Normalize snapshot ID from table name
2. Verify OPFS manifest exists (if not, fall back to OFFSET path)
3. Capture audit samples from shard 0 (optional)
4. **DROP the live DuckDB table** + CHECKPOINT
5. Generate temp output snapshot ID: `_xform_{tableName}_{timestamp}`
6. For each shard in source manifest:
   - `chunkMgr.loadShard()` → temp input table
   - `CREATE TABLE __xform_out AS ${buildSelectQuery(tempInputTable)}`
   - `exportSingleShard(conn, "__xform_out", outputSnapshotId, i)`
   - DROP both temp tables + CHECKPOINT every 2 shards
   - Report progress via `ctx.onBatchProgress`
   - `yield` to browser
7. Write output manifest
8. `importTableFromSnapshot()` to rebuild DuckDB table
9. `swapSnapshots()` to replace old OPFS snapshot with new
10. `markTableClean()` — snapshot is already saved, skip redundant export

**Error recovery**: On failure at any step, delete temp output snapshot and reimport the original snapshot. The old data is never touched until the final swap.

The `buildSelectQuery` callback is key — it receives a table name and returns a SELECT with transforms applied. This lets every command define its own SQL without knowing about shards.

**File**: `src/lib/commands/batch-utils.ts`

---

### Step 4: Wire shard path into existing entry points

Modify `runBatchedColumnTransform()` and `runBatchedTransform()` to detect when the shard path is available:

```typescript
// In runBatchedColumnTransform():
const canUseShard = await canUseShardPath(ctx.table.name, ctx.commandType)

if (canUseShard) {
  const buildQuery = (src: string) => buildColumnOrderedSelect(
    src, columnOrder, { [column]: transformExpr }, hasCsId, hasOriginId
  )
  return runShardTransform(ctx, buildQuery, sampleQuery)
}

// Otherwise: existing OFFSET path (unchanged)
```

For `runBatchedTransform()` (raw SQL version used by split_column etc.), the `buildSelectQuery` is constructed by replacing the table name in the SQL string:

```typescript
if (canUseShard) {
  const buildQuery = (src: string) =>
    selectQuery.replaceAll(`"${ctx.table.name}"`, `"${src}"`)
  return runShardTransform(ctx, buildQuery, sampleQuery)
}
```

**File**: `src/lib/commands/batch-utils.ts`

---

### Step 5: `canUseShardPath()` utility

Determines whether a table + command combination can use the shard path:

```typescript
const NON_SHARD_PARALLEL = new Set([
  'transform:remove_duplicates',
  'transform:fill_down',
  'transform:custom_sql',
  'transform:excel_formula',
  'combine:stack', 'combine:join',
  'match:merge',
])

async function canUseShardPath(tableName: string, commandType?: string): Promise<boolean> {
  if (commandType && NON_SHARD_PARALLEL.has(commandType)) return false
  const snapshotId = tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  const manifest = await readManifest(snapshotId)
  return manifest !== null && manifest.shards.length > 0
}
```

**File**: `src/lib/commands/batch-utils.ts`

---

### Step 6: Add `snapshotAlreadySaved` to `ExecutionResult`

Since shard transforms write output directly to OPFS, the normal priority-save cycle is redundant. Add a flag:

```typescript
export interface ExecutionResult {
  // ...existing fields...
  snapshotAlreadySaved?: boolean  // Skip priority save — output already in OPFS
}
```

**File**: `src/lib/commands/types.ts`

---

### Step 7: Executor respects `snapshotAlreadySaved`

In the executor's post-execution path (~line 785), check the flag before requesting priority save:

```typescript
if (executionResult.snapshotAlreadySaved) {
  uiStore.markTableClean(tableId)
  console.log('[Executor] Shard transform already saved to OPFS, skipping priority save')
} else if (!executionResult.journaled) {
  uiStore.requestPrioritySave(tableId)
}
```

**File**: `src/lib/commands/executor.ts` (small change, ~5 lines)

---

### Step 8: Pass `commandType` to batch context

The executor needs to pass the command type so `canUseShardPath` can check whether the command is shard-parallel. Add `commandType` to `CommandContext`:

```typescript
const batchableContext: CommandContext = {
  ...ctx,
  batchMode: shouldBatch,
  batchSize: batchSize,
  commandType: command.type,  // NEW
  // ...
}
```

**Files**: `src/lib/commands/types.ts` (add field), `src/lib/commands/executor.ts` (pass it)

---

## Memory Profile

For a 1M-row, 30-column table (20 shards):

| Phase | Current (OFFSET) | After (Shard) |
|-------|------------------|---------------|
| Pre-transform | 500MB (DuckDB table) | 500MB |
| During transform (peak) | **~1GB** (source + staging) | **~150MB** (1 input + 1 output shard) |
| Post-transform | 500MB (new table) | 500MB (rebuilt from shards) |

The peak during the transform drops by **~85%**.

---

## Files Modified

| File | Change | Size |
|------|--------|------|
| `src/lib/opfs/snapshot-storage.ts` | Add `exportSingleShard()`, `swapSnapshots()` | Medium |
| `src/lib/commands/batch-utils.ts` | Add `runShardTransform()`, `canUseShardPath()`; modify `runBatchedColumnTransform()` and `runBatchedTransform()` to detect and use shard path | Large |
| `src/lib/commands/types.ts` | Add `snapshotAlreadySaved` to `ExecutionResult`, add `commandType` to `CommandContext` | Small |
| `src/lib/commands/executor.ts` | Pass `commandType` in batch context; check `snapshotAlreadySaved` flag | Small |

### Files NOT Modified

- Individual transform commands (trim.ts, uppercase.ts, split-column.ts, etc.) — **no changes**. They continue checking `ctx.batchMode` and calling `runBatchedColumnTransform()`.
- ChunkManager — used as-is
- `batch-executor.ts` — kept as OFFSET fallback for non-shard-parallel transforms

---

## Edge Cases

| Case | Handling |
|------|----------|
| Table not yet saved to OPFS | `canUseShardPath` returns false → uses existing OFFSET batch path |
| Non-shard-parallel command (remove_duplicates) | `canUseShardPath` returns false → existing OFFSET path |
| Small table (<500k rows) | `ctx.batchMode = false` → direct SQL transform (no batching at all) |
| Empty table | Shard path processes 0 shards → writes empty output → rebuilds empty table |
| Failure during shard 5 of 20 | Delete temp output snapshot → reimport original snapshot → throw error |
| Transform adds columns (split_column) | Output shard schema differs from input — natural, each shard's SELECT generates new schema |

---

## Verification Plan

### Automated
1. **Correctness**: Apply trim to a 150k-row table (3 shards) via shard path. Verify output matches direct SQL.
2. **Memory**: Apply transform to 500k+ row table. Log peak memory — should stay under 200MB during processing.
3. **Undo**: Shard transform → undo → verify data returns to original state.
4. **Param preservation**: pad_zeros with `length=9` via shard path → trigger Tier 3 replay → verify params preserved.
5. **Error recovery**: Simulate OPFS write failure during shard 2 → verify original data intact.

### Manual
6. **Progress indicator**: Transform a large table → verify "Processing shard N/M" appears in UI.
7. **Grid during transform**: The grid should show a loading/transforming state while the table is being rebuilt.
8. **Small table fast path**: Transform 100-row table → should feel instant (no shard processing visible).

---

## Sequence Diagram

```
User clicks "Apply Transform"
         |
    CommandExecutor.execute()
         |
    [Pre-snapshot for undo]           // existing, unchanged
         |
    command.execute(ctx)              // ctx.batchMode = true
         |
    runBatchedColumnTransform()
         |
    canUseShardPath()? ──NO──> existing batchExecute() (OFFSET path)
         |
        YES
         |
    runShardTransform()
    ├── Verify OPFS manifest
    ├── Capture audit samples from shard 0
    ├── DROP live DuckDB table + CHECKPOINT
    ├── for each shard (20 iterations for 1M rows):
    │   ├── loadShard() → temp_in (~50MB)
    │   ├── CREATE TABLE temp_out AS SELECT [transform] FROM temp_in
    │   ├── exportSingleShard(temp_out) → OPFS
    │   ├── DROP temp_in + temp_out
    │   ├── CHECKPOINT (every 2 shards)
    │   └── yield + report progress
    ├── writeManifest(output)
    ├── importTableFromSnapshot() → rebuild DuckDB table
    ├── swapSnapshots(old, new)
    └── markTableClean() + return { snapshotAlreadySaved: true }
         |
    [Diff view, timeline, audit]      // existing, unchanged
         |
    Executor skips priority save      // because snapshotAlreadySaved
```
