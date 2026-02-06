# Arrow IPC Persistence → COI Multi-Threading

**Goal:** Replace Parquet persistence with Arrow IPC format to eliminate DuckDB's Parquet extension dependency, unlocking the COI bundle (pthreads + SIMD) for 2-5x query performance.

**Why:** The COI bundle can't dynamically load the Parquet extension (`LinkError: SharedArrayBuffer memory mismatch`). Arrow IPC uses APIs built into apache-arrow (v17.0.0) and duckdb-wasm (v1.33.1-dev19.0) — zero extension dependencies.

**Core Trade-off:** We are trading OPFS disk space (abundant, ~60% of free disk) for CPU cycles and extension compatibility. Arrow IPC files will be **5-10x larger** than Snappy-compressed Parquet. This is acceptable for pre-prod. Stream compression (gzip/LZ4 at JS layer) is a known future optimization path if users hit OPFS quotas — not implemented now because it adds latency to every save/load cycle and works against the performance goal.

---

## Key APIs (already installed, no new deps)

```typescript
// Export: query returns Arrow Table natively, serialize to IPC bytes
import { tableToIPC } from 'apache-arrow'
const arrowTable = await conn.query(`SELECT * FROM "${tableName}"`)
const ipcBytes: Uint8Array = tableToIPC(arrowTable, 'stream')

// Import: insert IPC bytes directly into DuckDB table
await conn.insertArrowFromIPCStream(ipcBytes, { name: tableName, create: true })
// Append subsequent chunks:
await conn.insertArrowFromIPCStream(chunk2Bytes, { name: tableName, create: false })
```

---

## Files to Modify

| File | Scope | Change |
|------|-------|--------|
| `src/lib/opfs/snapshot-storage.ts` | Heavy | Rewrite export/import internals from Parquet to Arrow IPC |
| `src/lib/diff-engine.ts` | Heavy | Replace `read_parquet()` + `registerFileWithRetry` with temp table materialization |
| `src/lib/timeline-engine.ts` | Medium | Update function names + replace `parquet_schema()` call |
| `src/hooks/usePersistence.ts` | Light | Update function name imports |
| `src/lib/commands/executor.ts` | Light | Update function name imports |
| `src/hooks/useDuckDB.ts` | Light | Update imports + guard `loadParquet` under COI |
| `src/stores/tableStore.ts` | Light | Dynamic import names (freeze/thaw unchanged) |
| `vite.config.ts` | Light | Re-enable COOP/COEP headers |
| `src/lib/duckdb/index.ts` | Light | Adaptive thread count + Parquet upload guard |
| E2E tests (3 files) | Light | `.parquet` → `.arrow` in file checks |

## Files NOT Modified

- All transform commands, grid rendering, merge/combine/standardize logic, recipe system
- `browser-detection.ts` — `supportsAccessHandle = false` stays (bug #2096 workaround)
- CSV/JSON/XLSX upload paths — unaffected

---

## Step 1: Rewrite `snapshot-storage.ts` Internals

### 1a. Export — `exportTableToSnapshot` (rename from `exportTableToParquet`)

**Old flow:** `COPY TO FORMAT PARQUET` → `db.copyFileToBuffer()` → write to OPFS → `db.dropFile()`
**New flow:** `conn.query(SELECT *)` → `tableToIPC()` → write to OPFS

```typescript
import { tableToIPC } from 'apache-arrow'

// For each chunk:
const arrowTable = await conn.query(
  `SELECT * FROM "${tableName}" ${orderByClause} LIMIT ${batchSize} OFFSET ${offset}`
)
const ipcBytes = tableToIPC(arrowTable, 'stream')
// Write ipcBytes to OPFS via atomic .tmp → rename pattern (same as today)
```

**What stays the same:** Global export lock, per-file write lock, atomic `.tmp` writes, `yieldToMain()` between chunks, `CHECKPOINT` after large exports, `getOrderByColumn()` for deterministic ordering.

**What changes:**
- File extension: `.parquet` → `.arrow`
- Remove all `COPY TO FORMAT PARQUET` SQL
- Remove all `db.copyFileToBuffer()` / `db.dropFile()` calls (no more DuckDB virtual files)
- **Mandatory:** Reduce chunk threshold from 250k → 100k rows. `tableToIPC` generates the entire Uint8Array in JS heap. A 250k row chunk of wide string data could spike JS memory and crash the tab before hitting OPFS.

**Schema consistency across chunks:** Arrow is extremely strict about schemas. If Chunk 1 has a column as Int32 and Chunk 2 has it as Int64 (or nullable vs non-nullable), the append will fail. The `getOrderByColumn()` logic with `LIMIT/OFFSET` queries the same table, so schema stays consistent. But as a safety measure: if `insertArrowFromIPCStream({ create: false })` throws a schema mismatch error, fall back to creating a temp table per chunk and `INSERT INTO ... SELECT *` to coerce types.

### 1b. Import — `importTableFromSnapshot` (rename from `importTableFromParquet`)

**Old flow:** `registerFileHandle()` → `CREATE TABLE AS SELECT * FROM read_parquet()` → `db.dropFile()`
**New flow:** read OPFS bytes → `conn.insertArrowFromIPCStream()`

```typescript
// Read file from OPFS
const fileHandle = await snapshotsDir.getFileHandle(fileName)
const file = await fileHandle.getFile()
const buffer = new Uint8Array(await file.arrayBuffer())

// Insert into DuckDB
const conn = await db.connect()
await conn.insertArrowFromIPCStream(buffer, { name: targetTableName, create: true })
// For subsequent chunks: { create: false } to append
await conn.close()
```

**What stays the same:** Auto-detect chunked vs single (check for `_part_0.arrow`), `ensureIdentityColumns()` after import.

**What's removed:** `registerFileWithRetry()`, `read_parquet()` SQL, `db.dropFile()` for unregistration.

### 1c. Update Helper Functions

| Function | Change |
|----------|--------|
| `deleteParquetSnapshot` → `deleteSnapshot` | `.parquet` → `.arrow` in file ops. Remove `db.dropFile()` (no DuckDB file registration) |
| `listParquetSnapshots` → `listSnapshots` | Filter `.arrow` instead of `.parquet` |
| `checkSnapshotFileExists` | `.parquet` → `.arrow` in file handle lookups |
| `freezeTable` | Call `exportTableToSnapshot`. Update magic byte validation |
| `thawTable` | Call `importTableFromSnapshot` |
| `cleanupCorruptSnapshots` | Detect `.arrow` files. Min valid size: ~8 bytes (Arrow IPC header) instead of 200 (Parquet) |
| `cleanupOrphanedDiffFiles` | `.parquet` → `.arrow` |
| `cleanupDuplicateCaseSnapshots` | `.parquet` → `.arrow` |
| `validateParquetMagicBytes` → `validateArrowMagicBytes` | **Soft check:** Try `0xFFFFFFFF` (Arrow IPC stream continuation token) first, but if check fails, still attempt to parse before declaring corrupt. The continuation token is an implementation detail of message encapsulation, not a formal format signature like Parquet's `PAR1`. Also use `.arrow` file extension as a secondary hint. |
| `registerFileWithRetry` | **Remove entirely** — no longer needed |

---

## Step 2: Update diff-engine.ts

The diff engine uses `read_parquet('file')` as inline SQL table expressions in complex JOIN queries. With Arrow IPC, we materialize snapshots into temp DuckDB tables instead.

### 2a. `resolveTableRef()` — Materialize Instead of Register

**Old:** Returns `read_parquet('snapshot.parquet')` SQL expression used inline in queries.
**New:** Loads Arrow IPC data into a temp DuckDB table, returns quoted table name `"_diff_snap_abc123"`.

```typescript
// Instead of:
//   registerFileWithRetry(db, fileHandle, exactFile)
//   return `read_parquet('${exactFile}')`
// Do:
const file = await fileHandle.getFile()
const buffer = new Uint8Array(await file.arrayBuffer())
const tempTableName = `_diff_snap_${snapshotId}`
const conn = await db.connect()
await conn.insertArrowFromIPCStream(buffer, { name: tempTableName, create: true })
await conn.close()
resolvedExpressionCache.set(snapshotId, `"${tempTableName}"`)
return `"${tempTableName}"`
```

Same pattern for chunked files — load each chunk with `create: false` to append.

The `resolvedExpressionCache` and `registeredParquetSnapshots` set still work — they now cache table names instead of `read_parquet()` expressions. Rename `registeredParquetSnapshots` → `materializedSnapshots`.

### 2b. Replace `parquet_schema()` (lines 392, ~1110)

**Old:** `SELECT name, type FROM parquet_schema('file.parquet')` to get column info without loading data.
**New:** After materializing into temp table, query `information_schema.columns`:
```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tempTableName}'
```

### 2c. Diff result materialization (lines ~1075-1156, ~1600-1622)

The diff engine also stores/reads its own diff result tables via Parquet. Same pattern: replace `registerFileWithRetry` + `read_parquet()` with reading Arrow IPC bytes + `insertArrowFromIPCStream` into temp tables.

### 2d. Memory Safety for Eager Loading

**Risk:** Materializing snapshots into temp tables is eager (loads full data into WASM heap), unlike `read_parquet()` which could stream. Two 500MB snapshots could OOM the WASM instance.

**Mitigations:**
- **Sequential loading:** When loading "Before" and "After" snapshots for diffing, `await` them sequentially. Do NOT `Promise.all()` — that doubles peak memory during the transfer phase.
- **Aggressive cleanup:** Before loading new comparison snapshots, DROP any previously materialized temp tables from the prior comparison. The `materializedSnapshots` set tracks what's loaded.
- **Cleanup on diff close:** Existing cleanup pattern already drops registered files — update to `DROP TABLE IF EXISTS` for each entry in `materializedSnapshots`, then clear the set.

### 2e. Cleanup

- Remove `registerFileWithRetry` import
- Rename `registeredParquetSnapshots` → `materializedSnapshots`
- Rename `storageType: 'parquet'` → `storageType: 'snapshot'` in `DiffConfig` type
- Update cleanup function to DROP temp tables instead of `db.dropFile()`

---

## Step 3: Update timeline-engine.ts

### 3a. Update imports to new function names
```typescript
import { exportTableToSnapshot, importTableFromSnapshot, checkSnapshotFileExists } from '@/lib/opfs/snapshot-storage'
```

### 3b. Replace `parquet_schema()` (line 152)
Used in `snapshotHasOriginId()` to check if a snapshot has `_cs_origin_id`. Replace with: import into temp table → query `information_schema.columns` → drop temp table. Or simpler: since all snapshots created going forward will have the column, just return `true` (this is a backward-compat check for legacy snapshots, and since we're pre-prod with no migration needed, legacy snapshots don't exist).

### 3c. Update file copy operations (lines 253-270)
Change `.parquet` → `.arrow` in OPFS file copy logic for snapshot persistence copies.

### 3d. Update all function call sites
- 5× `exportTableToParquet` → `exportTableToSnapshot`
- 1× `importTableFromParquet` → `importTableFromSnapshot`
- 4× `deleteParquetSnapshot` → `deleteSnapshot`

---

## Step 4: Update Remaining Callers

All mechanical find-and-replace within each file:

**`src/hooks/usePersistence.ts`** — Update imports (lines 24-32) and ~15 call sites
**`src/lib/commands/executor.ts`** — Update imports (lines 61-64) and ~5 call sites
**`src/hooks/useDuckDB.ts`** — Update dynamic import of `cleanupCorruptSnapshots` (line 66)
**`src/stores/tableStore.ts`** — `freezeTable`/`thawTable` names unchanged, no changes needed

---

## Step 5: Enable COI Bundle

### 5a. `vite.config.ts` — Add COOP/COEP headers plugin

```typescript
function crossOriginIsolationPlugin(): PluginOption {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        next()
      })
    },
  }
}
// plugins: [crossOriginIsolationPlugin(), react()]
```

### 5b. `src/lib/duckdb/index.ts` — Adaptive thread count

```typescript
const threadCount = isCOI ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1
await initConn.query(`SET threads = ${threadCount}`)
```

### 5c. `src/lib/duckdb/index.ts` — Guard Parquet upload

In `loadParquet()`, add early exit:
```typescript
if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
  throw new Error('Parquet file upload requires the Parquet extension which is unavailable in multi-threaded mode. Please upload as CSV, JSON, or XLSX instead.')
}
```

In `useDuckDB.ts` (line 280), catch this error and show a user-friendly toast.

### 5d. Compatibility Mode Escape Hatch

Add URL param support: `?mode=compatibility` disables COI behavior by setting `threads = 1` regardless of `crossOriginIsolated` state. This allows users with mission-critical `.parquet` files to:
1. Reload app with `?mode=compatibility`
2. Upload their `.parquet` file (single-threaded mode, extension loads fine)
3. Save it (which converts to Arrow IPC snapshot)
4. Return to normal mode (remove URL param, reload)

Implementation: Check `new URLSearchParams(window.location.search).get('mode') === 'compatibility'` in `duckdb/index.ts` before setting thread count. If compatibility mode, force `threads = 1` and skip the `loadParquet` guard.

### 5e. Service Worker Cache Consideration

CleanSlate's SW (`public/sw.js`) uses **network-first** for navigation requests, so fresh COOP/COEP headers from Vite dev server come through on normal loads. The stale-cache risk is **low** in dev. In production, the SW's `skipWaiting()` + `clients.claim()` pattern means new versions activate immediately.

**If COI fails to activate after deployment:** Add a one-time detection + forced reload in `main.tsx`:
```typescript
if (!crossOriginIsolated && !new URLSearchParams(location.search).has('mode')) {
  const reloaded = sessionStorage.getItem('coi-reload')
  if (!reloaded) {
    sessionStorage.setItem('coi-reload', '1')
    const regs = await navigator.serviceWorker?.getRegistrations()
    await Promise.all(regs?.map(r => r.unregister()) ?? [])
    location.reload()
  }
}
```
**Implement only if needed** — don't add this preemptively.

---

## Step 6: Update E2E Tests

Three test files reference `.parquet` in OPFS file checks:

- `e2e/tests/row-column-persistence.spec.ts` — ~20 references, change `.parquet` → `.arrow`
- `e2e/tests/opfs-persistence.spec.ts` — Update comments and file checks
- `e2e/tests/table-delete-persistence.spec.ts` — Line 80: `.endsWith('.parquet')` → `.endsWith('.arrow')`

---

## Implementation Order

| Step | What | Can app work after? |
|------|------|---------------------|
| 1 | Rewrite `snapshot-storage.ts` export/import + helpers | Yes (if callers updated simultaneously) |
| 2 | Update all callers (usePersistence, executor, timeline-engine) | Yes |
| 3 | Update diff-engine | Yes |
| 4 | Enable COI headers + adaptive threading | Yes |
| 5 | Guard `loadParquet` | Yes |
| 6 | Update E2E tests | Yes |
| 7 | Remove dead code, update comments | Yes |

Steps 1-3 should be done atomically (single commit) since they're interdependent.

---

## Verification

1. `npm run build` — TypeScript passes
2. `npm run dev` — Console shows `COI bundle`, `threads: 4`, `crossOriginIsolated: true`
3. Upload CSV → apply transforms → wait for green persistence indicator → page reload → data survives
4. Apply Tier 3 transform → undo → verify data integrity (Arrow IPC snapshot restore path)
5. Open Diff panel → verify diff works with Arrow IPC materialized snapshots
6. Freeze/thaw tables → verify cycle works
7. Try uploading `.parquet` file → verify user-friendly error message
8. DevTools → Application → OPFS → verify `.arrow` files (not `.parquet`)
9. `npm run test` — all E2E tests pass

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `insertArrowFromIPCStream` with `create: false` doesn't append | Low | High | Test 2-chunk roundtrip early. Fallback: temp table per chunk + `INSERT INTO ... SELECT *` |
| Schema mismatch across Arrow IPC chunks | Low | High | Same table queried with LIMIT/OFFSET ensures consistent schema. If append fails, fall back to temp-table-per-chunk + INSERT INTO SELECT |
| Diff engine OOM from eager snapshot loading | Medium | High | Sequential (not parallel) loading of Before/After snapshots. Aggressive cleanup of prior comparison's temp tables before loading new ones |
| Arrow IPC files too large for OPFS quota | Low | Medium | 100k chunk size. OPFS quota is ~60% of free disk. Future path: gzip at JS layer before OPFS write |
| Diff engine temp table accumulation | Medium | Low | DROP temp tables on diff close + on new comparison load. Track via `materializedSnapshots` set |
| COI multi-threading exposes DuckDB-WASM concurrency bug | Low | Medium | All queries go through `withMutex`. Revert to EH by removing headers |
| Service worker caches stale COOP/COEP headers | Low | Low | Detect `!crossOriginIsolated` + unregister SW + reload (only if SW exists) |

## Future Optimizations (Not Implemented Now)

| Optimization | Trigger Signal | Implementation |
|-------------|---------------|----------------|
| Stream compression (gzip/LZ4) | Users hit OPFS quota warnings | `gzip(tableToIPC(...))` before OPFS write, `gunzip(buffer)` before `insertArrowFromIPCStream`. Adds ~1-2s latency per load. |
| Lazy diff loading | Large datasets cause OOM during diff | Stream Arrow IPC in chunks instead of full materialization. Requires DuckDB-WASM streaming insert API. |
