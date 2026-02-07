# Phase 3: Shard-Based Combiner Engine

## Context

The combiner (Stack + Join) currently loads **both full source tables** into DuckDB-WASM simultaneously to execute a single atomic SQL statement. For two 1M-row tables, this means ~1GB+ peak memory (sourceA + sourceB + result), triggering OOM crashes.

Worse, the current combiner **cannot handle frozen tables at all** — it calls `getTableColumns(tableName)` and `FROM "tableName"` in SQL, both of which require the table to exist in DuckDB. With the Single Active Table Policy (only 1 table in DuckDB at a time), the non-active source table is frozen to OPFS, making the combine fail silently.

The ChunkManager + micro-shard infrastructure from Sprints 1-2 enables processing tables shard-by-shard (50k rows at a time) from OPFS without full materialization. The diff engine was already adapted to this pattern in Sprint 3. This plan adapts the combiner to the same approach.

**Goal**: Stack and Join work with frozen tables, peak memory drops from ~1GB+ to ~100-200MB during processing, one code path for all table sizes.

---

## Strategy Overview

| Operation | Current | Target |
|-----------|---------|--------|
| **Stack** | `CREATE TABLE ... UNION ALL` (both full tables in DuckDB) | Iterate source A shards + source B shards, write output shards directly to OPFS |
| **Join** | `CREATE TABLE ... FROM l JOIN r` (both full tables) | Index-first: build key indexes shard-by-shard, JOIN indexes, hydrate matches in batches |
| **Source access** | Must be in DuckDB (fails for frozen tables) | ChunkManager reads from OPFS snapshots; works with frozen tables |
| **Peak memory** | ~1GB+ (sourceA + sourceB + result) | Stack: ~100MB, Join: ~200MB |

**Fast path**: If both sources are already in DuckDB AND combined row count ≤ `SHARD_SIZE` (50k), use the existing direct SQL path. Zero overhead for small tables.

---

## Source Resolution

Both sources could be either in DuckDB (active table) or frozen in OPFS. We need a helper to resolve each source.

**Snapshot ID convention**: `tableName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()` (same pattern used in `freezeTable`, `thawTable`, `usePersistence`).

```typescript
// New helper in combiner-engine.ts
interface ResolvedSource {
  type: 'duckdb' | 'snapshot'
  tableName: string         // DuckDB table name
  snapshotId: string        // OPFS snapshot ID (for 'snapshot' type)
  manifest: SnapshotManifest | null
}
```

**Logic**: Check `information_schema.tables` for existence in DuckDB. If not found, derive `normalizedSnapshotId` from the table name and read the manifest from OPFS. If neither exists, error.

---

## Step 1: Shard-Level Stack (UNION ALL)

### Algorithm

**Phase 0 — Schema Discovery** (~50MB peak)
1. Resolve both sources (DuckDB or snapshot)
2. For each source: get column names + types
   - If in DuckDB: `getTableColumns(tableName)`
   - If snapshot: load shard 0 via ChunkManager → query `information_schema.columns` → evict shard 0
3. Compute union column list with NULL-padding map (same logic as current `stackTables`)
4. Compute result column order (merge source column orders)

**Phase 1 — Process Source A shards** (~100MB peak per iteration)
```
For each shard_i in source A:
  1. ChunkManager.loadShard(snapshotA, i) → "__combine_in"
     (if source is in DuckDB, export to temp snapshot first, then shard)
  2. CREATE TABLE "__combine_out" AS
     SELECT {null-padded columns with correct order},
            gen_random_uuid()::VARCHAR as _cs_origin_id
     FROM "__combine_in"
  3. exportSingleShard(conn, "__combine_out", resultSnapshotId, outputShardIdx)
  4. Collect ShardInfo (rowCount, byteSize)
  5. DROP "__combine_out"; evictShard(snapshotA, i)
  6. outputShardIdx++; globalRowOffset += shard.rowCount
  7. Report progress; yield to browser
```

**Phase 2 — Process Source B shards** (~100MB peak per iteration)
- Same loop as Phase 1, continuing `outputShardIdx` and `globalRowOffset`

**Phase 3 — Finalize**
1. Write manifest for result snapshot (columns, shard info, total rows)
2. Import result snapshot into DuckDB via `importTableFromSnapshot()`
3. Assign `_cs_id` with gap-based numbering: `ALTER TABLE + UPDATE` or regenerate during import
4. CHECKPOINT to release buffers
5. Return `{ rowCount }` to caller

**_cs_id assignment**: Each shard's SELECT includes `ROW_NUMBER() OVER () + globalRowOffset` to compute globally-unique sequence numbers. After full import, run `UPDATE result SET _cs_id = _cs_id * 100` for gap-based spacing.

### Memory Budget (1M rows, 30 columns per source)

| Phase | Peak | vs Current |
|-------|------|------------|
| Schema discovery | ~50MB | — |
| Per-shard processing | ~100MB (1 input + 1 output shard) | vs ~1GB+ |
| Finalize (result import) | ~500MB (full result in DuckDB) | Same as current post-combine |

---

## Step 2: Shard-Level Join (Index-First)

### Algorithm

Follows the same index-first pattern proven in the diff engine (`diff-engine.ts` Phase 1-4).

**Phase 0 — Schema Discovery** (~50MB peak)
- Same as Stack Phase 0: resolve sources, get columns + types
- Identify key column type, compute result column list (left all + right unique)

**Phase 1 — Build Left Key Index** (~86MB peak)
```sql
CREATE TEMP TABLE __combine_idx_left (
  _cs_id {actual_type},    -- from source left table
  key_col {key_type},      -- the join key
  _row_num BIGINT           -- globally unique row number
)
```
```
For each shard_i in left source:
  1. loadShard(snapshotLeft, i) → temp table
  2. INSERT INTO __combine_idx_left
     SELECT _cs_id, "keyColumn", ROW_NUMBER() OVER () + globalOffset
     FROM temp_table
  3. evictShard; globalOffset += shard.rowCount
  4. yield; report progress ("Building left index: shard 3/10")
```

**Phase 2 — Build Right Key Index** (~122MB peak)
- Same pattern for right source → `__combine_idx_right`

**Phase 3 — Index JOIN** (~120MB → ~48MB after cleanup)
```sql
CREATE TEMP TABLE __combine_matches AS
SELECT
  COALESCE(l._cs_id, NULL) as l_cs_id,
  COALESCE(r._cs_id, NULL) as r_cs_id,
  l.key_col as l_key,
  r.key_col as r_key,
  ROW_NUMBER() OVER () as result_row_num
FROM __combine_idx_left l
{INNER|LEFT|FULL OUTER} JOIN __combine_idx_right r
  ON l.key_col = r.key_col

DROP TABLE __combine_idx_left;
DROP TABLE __combine_idx_right;
CHECKPOINT;
```

The match table categorizes rows:
- **Matched**: both `l_cs_id` and `r_cs_id` non-null
- **Left-only** (LEFT/FULL OUTER): `r_cs_id` IS NULL
- **Right-only** (FULL OUTER): `l_cs_id` IS NULL

**Phase 4 — Hydrate Result Shards** (~200MB peak per batch)
```
totalMatches = COUNT(*) FROM __combine_matches
For batch_offset = 0; batch_offset < totalMatches; batch_offset += SHARD_SIZE:

  1. Get batch IDs:
     SELECT l_cs_id, r_cs_id, l_key, r_key
     FROM __combine_matches
     ORDER BY result_row_num
     LIMIT SHARD_SIZE OFFSET batch_offset

  2. Determine which left/right shard(s) contain these _cs_id values
     (use manifest minCsId/maxCsId if populated, else scan shard metadata)

  3. Load needed left shard(s) + right shard(s) via ChunkManager

  4. Build result shard:
     CREATE TABLE "__combine_out" AS
     SELECT
       (ROW_NUMBER() OVER () + batch_offset) * 100 as _cs_id,
       gen_random_uuid()::VARCHAR as _cs_origin_id,
       l.col1, l.col2, ...,                      -- left columns
       COALESCE(l."keyCol", r."keyCol") as "keyCol",  -- key column
       r.rightOnlyCol1, r.rightOnlyCol2, ...      -- right-only columns
     FROM batch_ids b
     LEFT JOIN left_shard l ON b.l_cs_id = l._cs_id
     LEFT JOIN right_shard r ON b.r_cs_id = r._cs_id

  5. exportSingleShard(conn, "__combine_out", resultSnapshotId, outputShardIdx)
  6. DROP "__combine_out"; evict loaded shards
  7. CHECKPOINT; yield; report progress
```

**Phase 5 — Finalize**
1. DROP `__combine_matches`
2. Write result manifest
3. Import result into DuckDB via `importTableFromSnapshot()`
4. CHECKPOINT
5. Return `{ rowCount }`

### Memory Budget (1M rows per source, 30 columns)

| Phase | Peak | vs Current |
|-------|------|------------|
| Schema discovery | ~50MB | — |
| Index building | ~122MB (2 indexes + 1 shard) | — |
| Index JOIN | ~120MB | — |
| Hydrate per batch | ~200MB (matches + 2 shards + output) | vs ~1GB+ |
| Finalize | ~500MB (full result in DuckDB) | Same as current |

---

## Step 3: Validation with Frozen Tables

Current `validateStack()` and `validateJoin()` call `getTableColumns(tableName)` which queries DuckDB. For frozen tables, this fails.

**Fix**: Add overloaded validation that accepts column metadata directly. The `CombinePanel` already has `table.columns` from `tableStore` metadata. Pass these to validation instead of querying DuckDB.

```typescript
// New signatures (backward compatible — old ones still work for DuckDB tables)
validateStack(tableA: string, tableB: string): Promise<StackValidation>
validateStackFromMetadata(colsA: ColumnInfo[], colsB: ColumnInfo[], nameA: string, nameB: string): StackValidation

validateJoin(tableA: string, tableB: string, keyColumn: string): Promise<JoinValidation>
validateJoinFromMetadata(colsA: ColumnInfo[], colsB: ColumnInfo[], nameA: string, nameB: string, keyColumn: string): JoinValidation
```

**Whitespace check** (FR-E3, join only): For frozen tables, load shard 0 and sample for whitespace on the key column. This is sufficient for a pre-combine warning — it catches the common case without loading the full table.

**Auto-clean keys**: Requires modifying source data. For now, only works when both tables are in DuckDB. If either source is frozen, show a message: "Load both tables first to auto-clean keys." This is an edge case — most users validate before combining, and auto-clean is optional.

---

## Step 4: Progress Reporting

Add progress state to `combinerStore.ts`:

```typescript
combineProgress: {
  phase: 'idle' | 'schema' | 'indexing' | 'joining' | 'hydrating' | 'finalizing'
  current: number
  total: number
} | null
```

| Operation | Phase | UI Message |
|-----------|-------|------------|
| Stack | schema | "Analyzing schemas..." |
| Stack | hydrating | "Processing shard 5/20..." |
| Stack | finalizing | "Importing result..." |
| Join | schema | "Analyzing schemas..." |
| Join | indexing | "Building key index (3/10)..." |
| Join | joining | "Matching keys..." |
| Join | hydrating | "Building result (batch 2/15)..." |
| Join | finalizing | "Importing result..." |

For small tables (< 50k rows), all phases complete in <200ms — no progress bar visible.

`CombinePanel.tsx` renders progress inline where the spinner currently shows.

---

## Step 5: Command Integration

`CombineStackCommand` and `CombineJoinCommand` signatures remain unchanged. The commands call `stackTables()` / `joinTables()` which internally dispatch:

```
if (both in DuckDB && combined rows ≤ SHARD_SIZE)
  → direct SQL path (current implementation, unchanged)
else
  → shard path (new)
```

**Undo unchanged**: Tier 2 undo = `DROP TABLE IF EXISTS "${resultTableName}"`. The result table always exists in DuckDB after finalization.

**Persistence optimization**: After shard-based combine, the result snapshot already exists in OPFS. Call `markTableAsRecentlySaved()` to prevent `usePersistence` from redundantly re-exporting. The manifest is already written.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/combiner-engine.ts` | Add `resolveSource()`, `stackTablesSharded()`, `joinTablesSharded()`. Modify `stackTables()` and `joinTables()` to dispatch based on size. Add metadata-based validation variants. |
| `src/stores/combinerStore.ts` | Add `combineProgress` state + `setCombineProgress` action |
| `src/components/panels/CombinePanel.tsx` | Pass table metadata to validation (handles frozen tables). Wire progress display. Disable auto-clean when tables frozen. |
| `src/lib/commands/combine/stack.ts` | Update `validate()` to handle frozen tables (check manifest if table not in DuckDB) |
| `src/lib/commands/combine/join.ts` | Same validation update |

No new files needed — all logic goes into existing `combiner-engine.ts`.

### Existing functions to reuse

| Function | File | Purpose |
|----------|------|---------|
| `ChunkManager.mapChunks()` | `src/lib/opfs/chunk-manager.ts` | Shard-by-shard iteration with auto-eviction |
| `ChunkManager.loadShard()` | `src/lib/opfs/chunk-manager.ts` | Load single shard into DuckDB |
| `exportSingleShard()` | `src/lib/opfs/snapshot-storage.ts` | Write one shard to OPFS |
| `writeManifest()` | `src/lib/opfs/manifest.ts` | Create manifest for result snapshot |
| `importTableFromSnapshot()` | `src/lib/opfs/snapshot-storage.ts` | Import full result into DuckDB |
| `withDuckDBLock()` | `src/lib/duckdb/lock.ts` | Serialize DuckDB access |
| `yieldToMain()` | (inline or from chunk-manager) | Browser responsiveness between shards |

---

## Edge Cases

| Case | Handling |
|------|---------|
| Both sources in DuckDB, small | Fast path: direct SQL (current code), no sharding |
| Both sources frozen | Both read from OPFS via ChunkManager — natural case |
| One active + one frozen | Active source exported to temp snapshot, then shard path |
| Empty table (0 rows) | 0 shards in manifest → result has 0 rows, single empty shard |
| Column-only mismatch (stack) | NULL padding computed in Phase 0, applied per-shard |
| FULL OUTER JOIN right-only rows | Index JOIN captures these; hydration uses `COALESCE(l.key, r.key)` |
| Join with 0 matches (INNER) | Phase 4 loops 0 times, result is empty |
| Result > source (many-to-many join) | Batched output; each batch ≤ SHARD_SIZE rows |

---

## Implementation Order

1. **Source resolution helper** — `resolveSource()` + metadata-based validation
2. **Shard-level Stack** — `stackTablesSharded()` + dispatch in `stackTables()`
3. **Shard-level Join** — `joinTablesSharded()` + dispatch in `joinTables()`
4. **Progress reporting** — Store state + CombinePanel UI
5. **Command validation** — Update stack/join commands for frozen table awareness
6. **Testing** — E2E: combine two tables (including frozen), verify result + memory

---

## Verification

1. **Small table combine** (< 50k rows): Stack + Join should work identically to current behavior (fast path)
2. **Large table stack** (> 100k rows): Upload two large CSVs → stack → verify row count = sum of sources
3. **Large table join** (> 100k rows): Join on key column → verify result matches expected join semantics
4. **Frozen table combine**: Freeze one table → open combine panel → stack/join should succeed without errors
5. **Memory**: Use `logMemoryUsage()` before/during/after combine. Peak during shard processing should stay < 300MB
6. **Progress UI**: Large combine should show phase progress, small combine should be instant (no progress visible)
7. **Undo**: After combine, undo should drop result table; redo should recreate it
8. **Existing E2E**: `e2e/tests/combiner-csid.spec.ts` should pass unchanged
