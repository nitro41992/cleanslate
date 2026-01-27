# Plan: Update CLAUDE.md with Persistence Architecture

## Task
Add documentation for the new dual-layer persistence architecture that enables data and state preservation across browser refreshes.

## Proposed Changes

### Location
Add a new subsection **"Persistence Architecture"** under section 4 (Architecture), after "Command Pattern" and before section 5 (Engineering Directives).

### Content to Add

The new section will document:

1. **Dual-Layer Architecture** - Data layer (Parquet) vs App State layer (JSON)
2. **Key Files** - `state-persistence.ts`, `snapshot-storage.ts`, `usePersistence.ts`
3. **Restoration Flow** - How data is restored on page load
4. **Save Mechanisms** - Adaptive debounce, save queue coalescing, chunked exports
5. **Storage Layout** - OPFS directory structure
6. **Dirty State Tracking** - UI indicators for unsaved changes

### Files Modified
- `CLAUDE.md` - Add new "Persistence Architecture" subsection

## Verification
- Read the updated CLAUDE.md to verify formatting and accuracy
- Ensure the new section integrates cleanly with existing documentation

---

## Proposed Content

```markdown
### Persistence Architecture

Data persists across browser refreshes via a **dual-layer** OPFS storage system:

| Layer | Storage | Format | Purpose |
|-------|---------|--------|---------|
| Data | `cleanslate/snapshots/` | Parquet | Table rows (chunked for >250k rows) |
| App State | `cleanslate/app-state.json` | JSON | Metadata, timelines, UI prefs |

**Key Files:**
| File | Purpose |
|------|---------|
| `src/lib/persistence/state-persistence.ts` | App-level JSON state (save/restore) |
| `src/lib/opfs/snapshot-storage.ts` | Parquet I/O with chunking & cleanup |
| `src/hooks/usePersistence.ts` | Lifecycle hook (hydration, auto-save) |

**Restoration Flow (Page Load):**
```
initDuckDB() → cleanupCorruptSnapshots() → restoreAppState()
     ↓
usePersistence: listParquetSnapshots() → importTableFromParquet() → addTable()
     ↓
setIsReady(true) → render grid
```

**Save Mechanisms:**
- **Adaptive debounce:** 2s default, 3s for >100k rows, 5s for >500k, 10s for >1M
- **Save queue coalescing:** Prevents concurrent exports for same table
- **Chunked exports:** Tables >250k rows split into ~50MB Parquet chunks
- **Corrupt file cleanup:** Deletes <200 byte broken files on startup

**Dirty State Tracking (`useUIStore`):**
- `dirtyTables: Set<string>` — Tables with unsaved changes
- `persistenceStatus: 'idle' | 'dirty' | 'saving' | 'error'`
- UI shows amber pulse → spinner → green checkmark

**OPFS Layout:**
```
cleanslate/
├── app-state.json
└── snapshots/
    ├── table_name.parquet (or _part_N.parquet for chunked)
    └── snapshot_timeline_*.parquet (undo snapshots)
```
```
