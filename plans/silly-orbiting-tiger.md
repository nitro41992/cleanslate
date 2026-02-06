# Plan: Wire resolveTableRef to use ChunkManager for shard-level loading [IMPLEMENTED]

## Context

The diff engine's `runDiff()` currently calls `resolveTableRef()` which materializes the **entire** source snapshot into a single DuckDB temp table via `importTableFromSnapshot()`. For a 1M-row table, this means ~500MB-1GB fully resident in DuckDB memory during diff computation — in addition to the target table, index tables, and diff table.

ChunkManager already provides shard-level loading (`loadShard()`, `mapChunks()`) with a 150k-row LRU budget. The diff engine's Phase 1 (index creation) and Phase 3 (column comparison) both process data in chunks naturally — they're the ideal candidates for shard-level access.

**Goal:** Reduce peak memory during `runDiff()` from "full source table + indices + diff" to "1 shard (50k rows) + indices + diff" by processing source snapshots shard-by-shard.

## Design

### What changes
- `runDiff()` — snapshot source processing uses ChunkManager instead of full materialization
- `clearDiffCaches()` — minor cleanup coordination

### What stays the same
- `resolveTableRef()` — unchanged, still used by `fetchDiffPage()` for lazy full materialization on first grid scroll
- `fetchDiffPage()` / `fetchDiffPageWithKeyset()` — unchanged
- Non-snapshot diff sources (normal tables) — unchanged

### Memory impact

| Phase | Before | After |
|-------|--------|-------|
| Schema discovery | Full table (~500MB for 1M rows) | 1 shard (~25MB for 50k rows) |
| Phase 1 (Index) | Full table already resident | 1 shard at a time, evicted between |
| Phase 3 (Compare) | Full table still resident | 1 shard at a time, evicted between |
| fetchDiffPage | Full table (cached) | Full table (lazy, on first scroll) |

Peak during runDiff drops from ~500MB to ~25MB for source data. The full materialization is deferred to `fetchDiffPage()` which only triggers when the user opens the diff view.

## Implementation

### File: `src/lib/diff-engine.ts`

#### Step 1: Add ChunkManager import

```typescript
import { getChunkManager } from '@/lib/opfs/chunk-manager'
```

#### Step 2: Extract shard-aware snapshot processing in `runDiff()`

Replace the current `resolveTableRef(tableA)` call at line 327 with a branching path for snapshot sources. The key insight: `runDiff` needs source data in three places, and we handle each differently:

1. **Schema discovery** (lines 353-358) — load shard 0, query `information_schema.columns`
2. **Origin ID validation** (lines 557-572) — use already-loaded shard 0
3. **Phase 1: Index creation** (lines 612-616) — `mapChunks` to build index shard-by-shard
4. **Phase 3: Column comparison** (lines 700-727) — `mapChunks` to UPDATE shard-by-shard

#### Step 3: Schema discovery from shard 0

Instead of materializing the full table and querying `information_schema.columns` on the temp table:

```typescript
// For snapshot sources: use ChunkManager for schema discovery
const chunkMgr = getChunkManager()
const snapshotId = tableA.replace('parquet:', '')
const shard0Table = await chunkMgr.loadShard(snapshotId, 0)

colsAAll = await query<{ column_name: string; data_type: string }>(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = '${shard0Table}' ORDER BY ordinal_position`
)
```

#### Step 4: Origin ID validation from shard 0

The validation query (line 559) checks if `_cs_origin_id` values match between source and target. Use the already-loaded shard 0:

```typescript
const matchResult = await query<{ one: number }>(`
  SELECT 1 as one
  FROM "${shard0Table}" a
  INNER JOIN "${tableB}" b ON a."${CS_ORIGIN_ID_COLUMN}" = b."${CS_ORIGIN_ID_COLUMN}"
  LIMIT 1
`)
```

After schema + validation are done, evict shard 0:
```typescript
await chunkMgr.evictShard(snapshotId, 0)
```

#### Step 5: Phase 1 — Build index table shard-by-shard

Replace `CREATE TEMP TABLE __diff_idx_a AS SELECT ... FROM ${sourceTableExpr}` with:

```typescript
// Pre-create empty index table with explicit schema
const idxACols = diffMode === 'two-tables'
  ? `_cs_id VARCHAR, _cs_origin_id VARCHAR, ${keyColumns.map(c => `"${c}" VARCHAR`).join(', ')}, _row_num BIGINT`
  : `_cs_id VARCHAR, _cs_origin_id VARCHAR, _row_num BIGINT`

await execute(`CREATE TEMP TABLE __diff_idx_a (${idxACols})`)

let globalRowOffset = 0
await chunkMgr.mapChunks(snapshotId, async (shardTable, shard) => {
  const selectCols = diffMode === 'two-tables'
    ? `"_cs_id" as _cs_id, ${aOriginIdSelect}, ${keyColumns.map(c => `"${c}"`).join(', ')}, ROW_NUMBER() OVER () + ${globalRowOffset} as _row_num`
    : `"_cs_id" as _cs_id, ${aOriginIdSelect}, ROW_NUMBER() OVER () + ${globalRowOffset} as _row_num`

  await execute(`INSERT INTO __diff_idx_a SELECT ${selectCols} FROM "${shardTable}"`)
  globalRowOffset += shard.rowCount
})
```

**Key detail:** `ROW_NUMBER() OVER ()` within each shard returns 1..N. Adding `globalRowOffset` (cumulative sum of prior shard row counts) produces globally-unique row numbers matching the original single-query behavior.

#### Step 6: Phase 3 — Column comparison shard-by-shard

Replace the LIMIT/OFFSET batching loop with shard-based iteration:

```typescript
if (pendingCount > 0) {
  const srcTgtModificationExpr = fullModificationExpr
    .replace(/\ba\."([^"]+)"/g, 'src."$1"')
    .replace(/\bb\."([^"]+)"/g, 'tgt."$1"')

  const manifest = await chunkMgr.getManifest(snapshotId)

  await chunkMgr.mapChunks(snapshotId, async (shardTable, _shard, index) => {
    onProgress?.({ phase: 'comparing', current: index + 1, total: manifest.shards.length })

    // UPDATE only rows whose a_row_id matches a _cs_id in this shard.
    // The JOIN condition naturally filters — no LIMIT/OFFSET needed.
    await execute(`
      UPDATE "${diffTableName}"
      SET diff_status = CASE
        WHEN (${srcTgtModificationExpr}) THEN 'modified'
        ELSE 'unchanged'
      END
      FROM "${shardTable}" src, "${tableB}" tgt
      WHERE "${diffTableName}".a_row_id = src."_cs_id"
        AND "${diffTableName}".b_row_id = tgt."_cs_id"
        AND "${diffTableName}".diff_status = 'pending_compare'
    `)

    // Checkpoint between shards
    const conn = await getConnection()
    await conn.query('CHECKPOINT')
  })
}
```

**Why this is cleaner:** The JOIN `a_row_id = src."_cs_id"` naturally scopes the UPDATE to only rows matching this shard. No need for the subquery with `LIMIT/OFFSET`, because the shard IS the batch boundary. Each shard processes ~50k rows — the same batch size as before.

#### Step 7: Normal table path unchanged

For non-snapshot sources (`!tableA.startsWith('parquet:')`), the existing code path is untouched. `sourceTableExpr = '"tableName"'` as before.

#### Step 8: Cleanup coordination

In `clearDiffCaches()`, no changes needed — ChunkManager's LRU handles its own cleanup, and it's already registered with the memory manager. The diff engine's `materializedSnapshots` tracking is only populated by `resolveTableRef()` (called lazily by `fetchDiffPage`), which remains unchanged.

### Variable scoping

The `sourceTableExpr` variable is currently used in:
1. Schema discovery (lines 353-358) — replaced with shard 0 query
2. Origin ID validation (line 561) — replaced with shard 0 JOIN
3. Phase 1 index creation (line 615) — replaced with mapChunks
4. Phase 3 comparison (line 710) — replaced with mapChunks
5. fetchDiffPage (line 890) — still calls `resolveTableRef()` independently

So within `runDiff()`, `sourceTableExpr` is no longer needed for snapshot sources. We introduce `snapshotId` instead for ChunkManager calls. For normal tables, `sourceTableExpr` is still set as before.

### Column type mapping for two-tables mode index

The index table column types for key columns need to match the source table. For the `CREATE TEMP TABLE` DDL, use the actual types from `colsAAll`:

```typescript
const keyColDefs = keyColumns.map(c => {
  const type = colsAAll.find(col => col.column_name === c)?.data_type || 'VARCHAR'
  return `"${c}" ${type}`
}).join(', ')
```

## Edge cases

1. **Single-shard snapshots (small tables):** mapChunks iterates once — same as loading the full table. No performance difference.
2. **Non-snapshot sources:** Code path is completely separate; no regression risk.
3. **Two-tables mode with key columns:** Key columns are extracted from each shard during Phase 1 index building. The JOIN in Phase 2 uses the index table, not the source table.
4. **Origin ID validation with 1 shard:** If shard 0 has no matching origin IDs, the validation falls back to `_cs_id` matching. This could be a false negative for multi-shard snapshots where later shards would have matches, but this is extremely unlikely (if any rows match, shard 0 almost certainly has some).

## Verification

1. **Build check:** `npm run build` — TypeScript compilation
2. **Manual test:**
   - Open app, load a CSV with >50k rows
   - Apply a transform (creates timeline snapshot)
   - Click a timeline entry to trigger diff
   - Verify diff results are identical to before
   - Check console for `[ChunkManager]` log messages showing shard load/evict
3. **E2E tests:** `npx playwright test "diff" --timeout=90000 --retries=0 --reporter=line`
4. **Memory comparison:** Open DevTools → Performance Monitor during diff on large table. Peak memory during `runDiff()` should be lower.

## Out of scope (follow-up)

- **fetchDiffPage shard-level loading** — would need shard-to-row-ID mapping (populate `minCsId`/`maxCsId` in manifest during export)
- **Populating minCsId/maxCsId** — prerequisite for fetchDiffPage optimization
- **Legacy rowCount: 0 safety** — ChunkManager LRU budget doesn't account for 0-rowcount shards (only affects legacy-migrated manifests, not timeline snapshots)
