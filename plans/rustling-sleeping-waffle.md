# Performance Optimization: Large Tables (1M–2M Rows) ✅ IMPLEMENTED

## Problem

Adding a single row to a 1M-row table takes **6-8 seconds** due to three cascading operations:

| Step | What | Time | Code |
|------|------|------|------|
| 1 | Full Parquet snapshot for undo | 2-3s | `executor.ts:292-348` |
| 2 | UPDATE all rows' `_cs_id` to shift positions | 1-2s | `insert-row.ts:96-98` |
| 3 | Full Parquet snapshot for persistence | 2-3s | `executor.ts:786` → `snapshot-storage.ts:292` |

Target: **<100ms** for row insert/delete at up to 2M rows.

## Key Insight from Codebase Audit

The codebase already separates display from identity in most places:
- **Diff view** → `ROW_NUMBER() OVER (ORDER BY CAST("_cs_id" AS INTEGER))` (diff-engine.ts:1096)
- **Grid row numbers** → positional `row + 1` (DataGrid.tsx:1887)
- **Audit drill-down** → `ROW_NUMBER()` computed at query time (ManualEditDetailView.tsx:46)
- **Row highlighting** → `_cs_id` as identity, mapped to visual index (DataGrid.tsx:2259)

This means gap-based `_cs_id` would work **without changing the user-facing UX**.

---

## Phase 1: Eliminate Parquet Snapshots for Row Operations

### 1A. Promote `insert_row` from Tier 3 → Tier 2

**Why**: Inserting an empty row is perfectly invertible — undo = delete the row.

**File: `src/lib/commands/data/insert-row.ts`**
- Change `getInvertibility()` to return `{ tier: 2, undoStrategy: 'Inverse SQL' }`
- The executor checks `requiresSnapshot(command.type)` at line 295 — Tier 2 returns false, so the 2-3s Parquet snapshot is skipped
- Undo path: `DELETE FROM table WHERE "_cs_id" = '{newCsId}'` — the row was all NULLs, so nothing is lost

### 1B. Promote `delete_row` from Tier 3 → Tier 2

**File: `src/lib/commands/data/delete-row.ts`**
- Before executing DELETE, capture the row data:
  ```sql
  SELECT * FROM table WHERE "_cs_id" IN ('id1', 'id2')
  ```
- Store captured rows in command instance (private field)
- Undo path: INSERT the captured rows back
- **Threshold**: If deleting >**500** rows, fall back to Tier 3 snapshot. The captured row data is serialized to JSON in `timelineStore` for persistence across page reloads — large payloads would freeze the UI thread or exceed storage quotas. Use serializable payload size as the constraint, not memory.

### 1C. Extend changelog to journal row insert/delete

**Existing pattern**: Cell edits already use OPFS JSONL changelog for instant persistence (~2-3ms) instead of full Parquet export. Extend this to row mutations.

**File: `src/lib/opfs/changelog-storage.ts`**
- Add discriminator to `ChangelogEntry`: `type: 'cell_edit' | 'insert_row' | 'delete_row'`
- `insert_row` entries: `{ type, tableId, ts, csId, originId, insertAfterCsId, columnNames }`
- `delete_row` entries: `{ type, tableId, ts, csIds, deletedRows }`

**File: `src/hooks/usePersistence.ts`**
- Extend `replayChangelogEntries()` (line 77) to replay INSERT/DELETE entries
- Write journal entry after insert/delete instead of triggering priority Parquet save

### 1D. Skip priority save for journaled operations

**File: `src/lib/commands/executor.ts`**
- Around line 786 where priority save is requested:
  - If operation was journaled to changelog, skip `requestPrioritySave()`
  - The next compaction cycle (every 30s idle) will merge journal into Parquet

### Phase 1 Expected Result
- Pre-snapshot: **eliminated** (Tier 2, no snapshot needed)
- _cs_id shift: still 1-2s (addressed in Phase 2)
- Priority save: **eliminated** (journaled, ~2-3ms)
- **Total: ~1-2s** (down from 6-8s)

---

## Phase 2: O(1) Row Insert via Gap-Based `_cs_id`

### Approach

Assign `_cs_id` with gaps between values. Insert between rows = pick the midpoint. No other rows updated.

| Initial | After inserting between row 200 and 300 |
|---------|----------------------------------------|
| 100, 200, 300, 400 | 100, 200, **250**, 300, 400 |

Display: Users always see 1, 2, 3, 4, 5 (computed via `ROW_NUMBER()` which already exists).

### Gap Strategy
- **Initial gap**: 100 per row (e.g., `ROW_NUMBER() * 100`)
- 2M rows × 100 = 200 million — well within INT32 (max 2.1B)
- **99 inserts** at any position before local rebalance needed
- **Insert at beginning**: new `_cs_id` = first row's `_cs_id` / 2 (e.g., 50 if first is 100)
- **Insert between X and Y**: new `_cs_id` = (X + Y) / 2 (integer division)
- **No gap available** (prev + 1 == next): triggers rebalance (see safety rules below)

### Critical Safety Rule: Deterministic Redo

**Problem**: If the gap-based `_cs_id` is calculated dynamically every time a command runs, Redo may drift. Example: Insert Row A gets `_cs_id = 150`. After Undo → Redo, the table state may have changed, and the calculation produces `_cs_id = 151`. Any subsequent Redo commands that targeted "row 150" now break.

**Fix — Capture on Execute, Reuse on Redo**:

```typescript
// In insert-row.ts execute():
const idToInsert = this.params.forceCsId ?? await calculateGapId(conn, tableName, insertAfterCsId)
this.params.forceCsId = idToInsert  // Persist for Redo
```

On first execution, `forceCsId` is undefined → calculate fresh. On Redo, `forceCsId` is set → reuse the stored value. This makes Redo deterministic regardless of table state changes.

### Critical Safety Rule: Rebalance = Hard Commit

**Problem**: Rebalance changes `_cs_id` for ~1000 existing rows. Any pending changelog entries reference old `_cs_id` values. After rebalance, replaying those entries would target the wrong rows.

**Fix — Treat Rebalance as a Checkpoint**:

When rebalance is triggered:
1. **Flush**: Force immediate replay of all pending changelog entries into DuckDB
2. **Rebalance**: Execute the `_cs_id` reassignment on the live table
3. **Snapshot**: Export a full Parquet snapshot immediately (this is the one case where a full export is justified — it's rare)
4. **Clear**: Wipe the changelog (the snapshot now includes everything up to and including the rebalance)

This ensures the "identity shift" is baked into the baseline. All future changelog entries use the new `_cs_id` values.

**Why this is acceptable**: Rebalance is rare — requires 99+ inserts at the exact same position. The momentary full-export cost is amortized across hundreds of operations.

### Changes Required

#### _cs_id Assignment (8 locations → gap-based formula)

All change from `ROW_NUMBER() OVER ()` to `ROW_NUMBER() OVER () * 100`:

| File | Line | Function |
|------|------|----------|
| `src/lib/duckdb/index.ts` | 591 | `loadCSV()` |
| `src/lib/duckdb/index.ts` | 631 | `loadJSON()` |
| `src/lib/duckdb/index.ts` | 669 | `loadParquet()` |
| `src/lib/duckdb/index.ts` | 736 | `loadXLSX()` |
| `src/lib/duckdb/index.ts` | 1316 | `addCsIdToTable()` |
| `src/lib/duckdb/index.ts` | 1376 | `duplicateTable()` |
| `src/lib/combiner-engine.ts` | 90, 261 | Stack and join operations |
| `src/lib/commands/scrub/batch.ts` | 314 | Scrub batch |
| `src/lib/opfs/snapshot-storage.ts` | 115 | Snapshot restoration |

#### Insert Row Logic (2 locations → gap-finding + deterministic redo)

**File: `src/lib/commands/data/insert-row.ts`** (lines 92-112)

Replace O(n) shift with O(1) midpoint:
```typescript
// Use stored ID for Redo, or calculate fresh for first execution
const newCsId = this.params.forceCsId ?? await calculateGapId(conn, tableName, insertAfterCsId)
this.params.forceCsId = newCsId  // Persist for deterministic Redo

// INSERT with newCsId — no UPDATE of other rows
await ctx.db.execute(`INSERT INTO ${tableName} (...) VALUES ('${newCsId}', ...)`)
```

**File: `src/lib/commands/timeline-engine.ts`** (lines 822-827)
- Same change for timeline replay of insert operations
- Timeline replay must also use the stored `forceCsId` from command params

#### Utility Functions (2 locations → fix assumptions)

| File | Line | Function | Fix |
|------|------|----------|-----|
| `src/lib/duckdb/index.ts` | 958 | `estimateCsIdForRow()` | Query actual _cs_id at offset instead of assuming `rowIndex + 1` |
| `src/lib/duckdb/index.ts` | 1205 | `getRowCsId()` | Already uses OFFSET — works correctly, no change needed |

#### Local Rebalance (new utility — with hard commit semantics)

**New function in `src/lib/duckdb/index.ts`**:
```typescript
async function rebalanceCsIdRange(
  tableName: string,
  centerCsId: number,
  rangeSize = 1000
): Promise<void> {
  // 1. FLUSH: Force replay of pending changelog entries
  await flushChangelog(tableId)

  // 2. REBALANCE: Reassign _cs_id with uniform gaps in the affected range
  // SELECT _cs_id FROM table WHERE _cs_id BETWEEN (center - range) AND (center + range)
  // UPDATE with fresh gaps of 100

  // 3. SNAPSHOT: Force full Parquet export
  await exportTableToParquet(db, conn, tableName, snapshotId)

  // 4. CLEAR: Wipe changelog (snapshot is the new baseline)
  await clearChangelog(tableId)
}
```

### Migration for Existing Tables

Existing tables have sequential `_cs_id` (1, 2, 3...). On first load after this change:
- Detect sequential pattern: `SELECT MAX(CAST(_cs_id AS INTEGER)) = COUNT(*) FROM table`
- If sequential, renumber with gaps: `UPDATE table SET _cs_id = CAST(CAST(_cs_id AS INTEGER) * 100 AS VARCHAR)`
- One-time operation, happens automatically on first open

### Phase 2 Expected Result
- Insert/delete: **<100ms** (single INSERT, no UPDATE of other rows, journal write)
- Diff/transforms: **unchanged** (already use ROW_NUMBER() or ORDER BY for ordering)
- Rebalance (rare, ~1 in 100 inserts at same spot): ~2-3s one-time cost, then back to <100ms

---

## Files Modified (Complete List)

### Phase 1
| File | Changes |
|------|---------|
| `src/lib/commands/data/insert-row.ts` | Tier 3→2, add inverse SQL for undo |
| `src/lib/commands/data/delete-row.ts` | Tier 3→2 (≤500 rows), capture row data, add inverse SQL |
| `src/lib/commands/executor.ts` | Skip priority save for journaled operations |
| `src/lib/opfs/changelog-storage.ts` | Extend ChangelogEntry with insert_row/delete_row types |
| `src/hooks/usePersistence.ts` | Journal insert/delete, extend replay, skip priority save |
| `src/lib/commands/timeline-engine.ts` | Verify Tier 2 replay handles row mutations |

### Phase 2
| File | Changes |
|------|---------|
| `src/lib/duckdb/index.ts` | Gap-based assignment (8 locations), fix `estimateCsIdForRow()`, add `rebalanceCsIdRange()` with hard-commit semantics |
| `src/lib/commands/data/insert-row.ts` | Gap-finding midpoint + `forceCsId` for deterministic Redo |
| `src/lib/commands/timeline-engine.ts` | Gap-finding for timeline replay, use stored `forceCsId` |
| `src/lib/combiner-engine.ts` | Gap-based assignment (2 locations) |
| `src/lib/commands/scrub/batch.ts` | Gap-based assignment |
| `src/lib/opfs/snapshot-storage.ts` | Gap-based assignment on restore |

---

## Verification

### Phase 1
1. Load 1M+ row table
2. Insert row → should complete in ~1-2s (no Parquet snapshots)
3. Delete row → should complete in ~1-2s
4. Undo insert → row deleted (Tier 2 inverse SQL)
5. Undo delete → row restored with correct data
6. Delete 501 rows → should use Tier 3 snapshot (threshold check)
7. Reload page → journaled operations replay correctly
8. `npm run build` passes
9. Run existing E2E tests

### Phase 2
1. Insert row at beginning, middle, end → all <100ms
2. Insert 100 rows at same position → verify ordering stays correct, rebalance triggers if needed
3. **Deterministic Redo test**: Insert → Undo → Insert another row → Redo first insert → verify same `_cs_id` is used
4. **Rebalance + changelog test**: Make cell edits → trigger rebalance → verify changelog was flushed before rebalance → verify cell edits survive
5. Verify diff view shows correct positional row numbers after inserts
6. Verify audit drill-down shows correct current row positions
7. Load existing table (sequential _cs_id) → auto-migration to gap-based
8. `npm run build` passes
9. Run E2E tests

### At 2M Rows
1. Load 2M-row Parquet file
2. Insert/delete → <100ms
3. Apply transform (trim, uppercase) → should be fast (expression-based, no snapshot)
4. Run diff → verify ROW_NUMBER() positions are correct
5. Undo/redo cycle → verify correctness

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Tier 2 delete captures too much data for serialization | Threshold: >500 rows falls back to Tier 3. Constraint is JSON serialization size in timelineStore, not memory. |
| Redo produces different `_cs_id` than original execute | `forceCsId` stored in command params on first execute, reused on Redo. Makes Redo deterministic. |
| Rebalance invalidates pending changelog entries | Rebalance = hard commit: flush changelog → rebalance → snapshot → clear changelog. Future entries use new IDs. |
| Changelog replay order matters | Already sorted by timestamp in `replayChangelogEntries()` |
| Gap-based _cs_id breaks downstream that assumes sequential | Audit found only 2 utility functions affected — both have clear fixes |
| Migration of existing tables is slow for 2M rows | One-time UPDATE with multiplication — DuckDB handles this in ~1s |
