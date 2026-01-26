# Plan: Application State Persistence Across Page Refreshes

## Problem Statement

When users refresh the page, they see a blank workspace despite:
- ✅ DuckDB tables persisting to `opfs://cleanslate.db` (Chrome/Safari/Edge)
- ✅ Parquet snapshots existing in OPFS `snapshots/` directory
- ✅ Audit log data stored in DuckDB

The critical gap: **React application state** (table metadata, timeline history, active selections) is lost because Zustand stores are memory-only.

**User Impact:**
- Tables exist in DuckDB but aren't visible in the UI
- Undo/redo history is lost
- All transformations and drill-down context disappear
- Users must re-upload files after every refresh

## Solution: Automated State Persistence System

Build a transparent auto-save/restore system that:
1. Saves critical application state to OPFS as JSON metadata
2. Restores state automatically after DuckDB initializes
3. Reconciles metadata with actual DuckDB tables (handles orphans/mismatches)
4. Debounces writes to balance safety vs. performance

## Architecture Design

### 1. Storage Structure

**New file in OPFS:** `cleanslate/app-state.json`

```json
{
  "version": 2,
  "lastUpdated": "2026-01-26T10:30:00Z",
  "tables": [
    {
      "id": "abc123",
      "name": "customers_cleaned",
      "columns": [...],
      "rowCount": 15000,
      "createdAt": "2026-01-26T09:00:00Z",
      "updatedAt": "2026-01-26T10:30:00Z",
      "columnOrder": ["name", "email", "phone"],
      "dataVersion": 5,
      "parentTableId": null,
      "isCheckpoint": false,
      "lineage": null
    }
  ],
  "activeTableId": "abc123",
  "timelines": [
    {
      "id": "timeline-1",
      "tableId": "abc123",
      "tableName": "customers_cleaned",
      "commands": [...],
      "currentPosition": 4,
      "snapshots": [[0, "parquet:snapshot-xyz"]],
      "originalSnapshotName": "parquet:original_customers_cleaned",
      "createdAt": "2026-01-26T09:00:00Z",
      "updatedAt": "2026-01-26T10:30:00Z"
    }
  ],
  "uiPreferences": {
    "sidebarCollapsed": false
  }
}
```

**Why JSON?**
- Simple, debuggable, human-readable
- ~5-50KB for typical sessions (negligible storage overhead)
- DuckDB already handles table data persistence via OPFS database file

### 2. Data Flow

#### Save Flow (Debounced)
```
User Action (edit/transform)
  ↓
Store mutation (tableStore/timelineStore/uiStore)
  ↓
Trigger debounced save (500ms idle timeout)
  ↓
persistenceManager.saveAppState()
  ├─ tableStore.getState().tables
  ├─ timelineStore.getSerializedTimelines() [already exists!]
  ├─ tableStore.getState().activeTableId
  └─ uiStore.getState().sidebarCollapsed
  ↓
Write JSON to OPFS cleanslate/app-state.json
  ↓
Update uiStore.lastSavedAt (visual feedback)
```

#### Load Flow (After DuckDB Init)
```
App mount → useDuckDB() → initDuckDB() completes
  ↓
persistenceManager.restoreAppState()
  ├─ Read cleanslate/app-state.json from OPFS
  ├─ Validate schema version (migration hook for future)
  └─ If missing: Fresh start (no error)
  ↓
Reconcile metadata vs DuckDB reality
  ├─ Query DuckDB: "SELECT table_name FROM duckdb_tables() WHERE NOT internal"
  ├─ Tables in metadata but not DuckDB → Remove from metadata
  ├─ Tables in DuckDB but not metadata → Create minimal metadata
  └─ Corrupted JSON → Clear and start fresh
  ↓
Restore to Zustand stores
  ├─ tableStore.setState({ tables, activeTableId })
  ├─ timelineStore.loadTimelines(timelines) [already exists!]
  └─ uiStore.setSidebarCollapsed(prefs.sidebarCollapsed)
  ↓
UI renders with full state restored
```

### 3. Reconciliation Logic (Critical for Robustness)

| Scenario | DuckDB | Metadata | Action |
|----------|--------|----------|--------|
| **Normal** | Table exists | Metadata exists | Load as-is |
| **Orphan metadata** | Missing | Exists | Remove from metadata (table was deleted) |
| **Orphan table** | Exists | Missing | Create minimal metadata via introspection |
| **Corrupt JSON** | N/A | Parse error | Clear file, start fresh, log error |
| **Version mismatch** | N/A | v1 vs v2 | Run migration (future-proof) |

**Why reconciliation matters:**
- User might manually delete DuckDB tables via browser DevTools
- Snapshot cleanup might remove Parquet files
- Concurrent tabs could create race conditions
- File corruption from browser crashes

### 4. Files to Create/Modify

#### New Files

**`src/lib/persistence/state-persistence.ts`** (Core logic)
```typescript
export interface AppStateV2 {
  version: 2
  lastUpdated: string
  tables: TableInfo[]
  activeTableId: string | null
  timelines: SerializedTableTimeline[]
  uiPreferences: { sidebarCollapsed: boolean }
}

// Public API
export async function saveAppState(): Promise<void>
export async function restoreAppState(): Promise<boolean>
export async function clearAppState(): Promise<void>

// Internal helpers
async function reconcileTablesWithDuckDB(tables: TableInfo[]): Promise<TableInfo[]>
async function createMetadataFromDuckDB(tableName: string): Promise<TableInfo | null>
async function getOPFSRoot(): Promise<FileSystemDirectoryHandle>
```

**`src/lib/persistence/debounce.ts`** (Shared debounce utility)
```typescript
export class DebouncedSave {
  private timeoutId: NodeJS.Timeout | null = null
  private readonly delayMs: number

  constructor(delayMs = 500) {
    this.delayMs = delayMs
  }

  trigger(fn: () => Promise<void>): void {
    if (this.timeoutId) clearTimeout(this.timeoutId)
    this.timeoutId = setTimeout(() => {
      fn().catch(err => console.error('[Persistence] Save failed:', err))
    }, this.delayMs)
  }

  flush(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }
}
```

#### Modified Files

**`src/hooks/useDuckDB.ts`**
- Line ~39: After `setIsReady(true)`, call `await restoreAppState()`
- Add loading message: `setLoadingMessage('Restoring workspace...')`
- Handle restoration errors gracefully (don't block app startup)

**`src/stores/tableStore.ts`**
- Add subscription at bottom of file to trigger debounced save
- Add `loadTables()` helper for bulk restore (avoids triggering saves during load)

**`src/stores/timelineStore.ts`**
- Add subscription to trigger debounced save
- No changes to `getSerializedTimelines()` / `loadTimelines()` (already perfect)

**`src/stores/uiStore.ts`**
- Add subscription for `sidebarCollapsed` changes

**`src/lib/opfs/storage.ts`** (reuse patterns)
- Reference for OPFS access patterns (file handle, writable stream, etc.)
- Keep existing audit detail functions (legacy compatibility)

### 5. Error Handling

**Corrupted Metadata**
```typescript
try {
  const text = await file.text()
  return JSON.parse(text) as AppStateV2
} catch (error) {
  console.warn('[Persistence] Corrupted app-state.json, starting fresh:', error)
  await clearAppState()
  return null
}
```

**DuckDB Orphan Table (no metadata)**
```typescript
const duckdbTables = await query(
  "SELECT table_name FROM duckdb_tables() WHERE NOT internal AND table_name NOT LIKE '_timeline%'"
)
for (const { table_name } of duckdbTables) {
  if (!metadata.tables.some(t => t.name === table_name)) {
    console.warn(`[Persistence] Orphan table '${table_name}', creating metadata`)
    const columns = await getTableColumns(table_name)
    const rowCount = await query(`SELECT COUNT(*) as c FROM "${table_name}"`)
    // Create minimal TableInfo with generated ID
  }
}
```

**Metadata Orphan (table deleted from DuckDB)**
```typescript
const validTables = []
for (const table of metadata.tables) {
  const exists = await query(`
    SELECT COUNT(*) as c
    FROM information_schema.tables
    WHERE table_name = '${table.name}'
  `)
  if (exists[0].c > 0) {
    validTables.push(table)
  } else {
    console.warn(`[Persistence] Removing orphan metadata for '${table.name}'`)
  }
}
```

**OPFS Quota Exceeded**
```typescript
try {
  await writable.write(JSON.stringify(state))
  await writable.close()
} catch (error) {
  if (error.name === 'QuotaExceededError') {
    toast.error('Storage quota exceeded. Export tables and delete old data.')
  }
  throw error
}
```

### 6. Performance Characteristics

**Save Performance**
- Debounce: 500ms idle timeout (balance between safety and write frequency)
- File size: ~1-2KB per table metadata + ~500 bytes per timeline command
- Typical session: 5-20 tables = ~10-50KB total (trivial for OPFS)
- Max writes: ~2/second during heavy editing (acceptable)

**Load Performance**
- Parse time: <50ms for typical JSON (5-20 tables)
- Reconciliation: Single DuckDB query to list tables (~10-100ms)
- Total overhead: ~100-300ms (dominated by DuckDB, not JSON)

**Memory Impact**
- In-memory metadata: ~50-100KB for 100 tables (negligible)
- No impact on DuckDB memory (tables already loaded)

### 7. Verification Strategy

#### Manual Testing Checklist
1. ✅ Load CSV → Refresh → Table still visible with correct columns
2. ✅ Apply 3 transforms → Refresh → Can undo all 3 transforms
3. ✅ Undo 2 transforms → Refresh → Still at position after 1st transform
4. ✅ Load 5 tables → Delete 2 → Refresh → Only 3 tables shown
5. ✅ Collapse sidebar → Refresh → Sidebar still collapsed
6. ✅ Multiple tabs → Second tab shows read-only mode (existing DuckDB behavior)
7. ✅ Hard refresh (clear cache) → Data still persists (OPFS is durable)

#### E2E Test Scenarios
**Test:** `e2e/tests/persistence.spec.ts`

```typescript
test('FR-PERSIST-1: Tables persist across page refresh', async ({ page }) => {
  // Load a table
  await laundromat.uploadFile('basic-data.csv')
  await wizard.import()
  await inspector.waitForTableLoaded('basic_data', 3)

  // Refresh page
  await page.reload()
  await inspector.waitForDuckDBReady()

  // Verify table is still visible
  const tables = await inspector.getTableList()
  expect(tables).toHaveLength(1)
  expect(tables[0].name).toBe('basic_data')
})

test('FR-PERSIST-2: Timeline persists with undo/redo state', async ({ page }) => {
  // Load table and apply transforms
  await laundromat.uploadFile('whitespace-data.csv')
  await wizard.import()
  await picker.selectTransform('Trim Whitespace')
  await picker.selectColumn('name')
  await picker.apply()

  // Verify transform applied
  const beforeRefresh = await inspector.runQuery('SELECT name FROM whitespace_data')
  expect(beforeRefresh[0].name).toBe('Alice')

  // Refresh page
  await page.reload()
  await inspector.waitForDuckDBReady()

  // Verify can still undo
  const canUndo = await inspector.canUndo('whitespace_data')
  expect(canUndo).toBe(true)

  await laundromat.clickUndo()
  await inspector.waitForTableLoaded('whitespace_data', 3)

  const afterUndo = await inspector.runQuery('SELECT name FROM whitespace_data')
  expect(afterUndo[0].name).toBe('  Alice  ')
})

test('FR-PERSIST-3: Handles orphaned tables gracefully', async ({ page }) => {
  // Load table
  await laundromat.uploadFile('basic-data.csv')
  await wizard.import()

  // Manually delete table from DuckDB
  await inspector.runExecute('DROP TABLE basic_data')

  // Refresh
  await page.reload()
  await inspector.waitForDuckDBReady()

  // Verify no error, table removed from UI
  const tables = await inspector.getTableList()
  expect(tables).toHaveLength(0)
})
```

### 8. Migration Strategy for Existing Users

**Current State:**
- Users with existing data have DuckDB tables + snapshots in OPFS
- NO `app-state.json` exists yet

**On First Load After This Feature Ships:**
```
1. initDuckDB() completes
2. restoreAppState() runs
3. app-state.json not found → returns null (not an error)
4. Reconciliation discovers orphan tables in DuckDB
5. Creates minimal metadata for each table (no timeline history)
6. Saves initial app-state.json with discovered tables
7. User sees their existing tables!
```

**Outcome:**
- Existing users' data is auto-discovered on first launch
- Timeline history starts fresh (acceptable - old data had no undo anyway)
- All snapshots remain intact in OPFS (not touched)

### 9. Implementation Sequence

#### Phase 1: Core Persistence (Priority: HIGH)
1. Create `src/lib/persistence/state-persistence.ts` with save/restore/reconcile logic
2. Create `src/lib/persistence/debounce.ts` for shared debounced save utility
3. Add unit tests for reconciliation edge cases

#### Phase 2: Store Integration (Priority: HIGH)
1. Modify `tableStore.ts`: Add `loadTables()` helper and subscription
2. Modify `timelineStore.ts`: Add subscription (reuse existing serialization)
3. Modify `uiStore.ts`: Add subscription for sidebar preference

#### Phase 3: Initialization Hook (Priority: HIGH)
1. Modify `useDuckDB.ts`: Call `restoreAppState()` after DuckDB ready
2. Add loading message during restoration
3. Handle errors gracefully (log, don't block)

#### Phase 4: Testing & Validation (Priority: MEDIUM)
1. Add E2E tests for persistence scenarios
2. Manual QA: Load → Transform → Refresh → Verify
3. Test orphan handling (delete table, refresh, verify cleanup)

#### Phase 5: Polish & Documentation (Priority: LOW)
1. Add JSDoc comments to persistence API
2. Update CLAUDE.md with persistence architecture notes
3. Add troubleshooting guide for quota issues

### 10. Critical Files Summary

| File | Action | Lines | Complexity |
|------|--------|-------|------------|
| `src/lib/persistence/state-persistence.ts` | **CREATE** | ~250 | Medium |
| `src/lib/persistence/debounce.ts` | **CREATE** | ~30 | Low |
| `src/hooks/useDuckDB.ts` | **MODIFY** | +15 | Low |
| `src/stores/tableStore.ts` | **MODIFY** | +20 | Low |
| `src/stores/timelineStore.ts` | **MODIFY** | +15 | Low |
| `src/stores/uiStore.ts` | **MODIFY** | +10 | Low |
| `e2e/tests/persistence.spec.ts` | **CREATE** | ~150 | Medium |

### 11. Rollback Strategy

If issues arise post-deployment:

1. **Quick fix:** Set `ENABLE_PERSISTENCE=false` flag to disable auto-save
2. **User escape hatch:** Add "Clear Saved State" button in Settings
3. **Recovery:** `clearAppState()` deletes corrupted `app-state.json`, app restarts fresh
4. **Data safe:** DuckDB tables + Parquet snapshots untouched (only metadata cleared)

### 12. Future Enhancements (Out of Scope)

- Cloud sync via S3/Cloudflare R2 (requires backend)
- Multi-device session restore (requires auth + backend)
- Export/import workspace as `.cleanslate` file
- Persist diff/matcher/combiner configurations
- Auto-backup on quota warnings

## Success Metrics

- ✅ 0 data loss on page refresh (tables + timelines restored)
- ✅ <500ms restoration overhead on app load
- ✅ <50KB metadata file size for typical sessions
- ✅ 100% reconciliation accuracy (no orphan tables or crashes)
- ✅ E2E tests pass with 0 flakiness

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Corrupted JSON | Low | Medium | Validate on load, clear if invalid, log error |
| OPFS quota exceeded | Low | Low | Catch exception, toast warning, allow app to run |
| Reconciliation bug (orphans) | Medium | Medium | Comprehensive E2E tests, graceful fallback |
| Performance regression | Low | Low | Debounce writes, measure load time in tests |
| Browser compatibility | Low | Medium | OPFS already required for DuckDB persistence |

---

**Plan Status:** Ready for review and implementation
**Estimated Effort:** 1-2 days (2 files to create, 4 to modify, E2E tests)
**Dependencies:** None (all infrastructure exists)
