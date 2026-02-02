# Plan: Update CLAUDE.md Based on Recent Changes

## Context

The user wants to update CLAUDE.md to reflect recent codebase changes while preserving the rules in Section 2.

## Key Discrepancies Found

### 1. Stores Count (Section 4)
- **Documented:** "8 stores"
- **Actual:** 12 stores (tableStore, timelineStore, auditStore, uiStore, editStore, editBatchStore, diffStore, previewStore, combinerStore, matcherStore, scrubberStore, standardizerStore)

### 2. Directory Structure (Section 4)
- **Missing from components/:** `clean/`, `diff/`, `panels/`, `scrub/`
- **Missing from lib/:** `validation/`, `memory-manager.ts`, `idle-detector.ts`
- **Missing from lib/commands/:** `data/`, `schema/` subdirectories

### 3. Core Modules Table (Section 4)
- Standardizer module is missing
- Architecture shifted: main UI panels are in `components/panels/`, not `features/`

### 4. Command Organization (Section 4)
- Documented tier structure is correct but missing new command categories:
  - `data/` - insert-row, delete-row
  - `schema/` - add-column, delete-column

### 5. Missing Engineering Directives (Section 5)
- No section on Memory Management (memory-manager.ts patterns)
- No section on Batch Processing (staging table pattern, WAL checkpoints)
- No mention of semantic validation framework

### 6. Missing from Three-Tier Undo Table
- Row/column operations should be categorized

## Recommended Changes

### Section 4 - Architecture

1. **Update stores count:** "8 stores" → "12 stores"
2. **Update Directory Structure:**
```
src/
├── components/       # Reusable UI (common/, grid/, layout/, ui/, panels/, clean/, diff/, scrub/)
├── features/         # Feature modules (combiner/, matcher/, scrubber/, standardizer/, diff/)
├── lib/
│   ├── commands/     # Command Pattern (transform/, edit/, data/, schema/, combine/, match/, scrub/, standardize/)
│   ├── duckdb/       # DuckDB initialization & queries
│   ├── opfs/         # OPFS storage utilities
│   ├── persistence/  # State persistence
│   ├── validation/   # Semantic validation rules
│   └── transformations.ts  # [DEPRECATED]
├── hooks/            # useDuckDB, usePersistence, useSemanticValidation, useUnifiedUndo
├── stores/           # Zustand stores (12 total)
└── types/            # TypeScript interfaces
```

3. **Update Core Modules Table:** Add Standardizer row

4. **Update Command Pattern section:**
   - Add `data:insert_row`, `data:delete_row` to Tier 2
   - Add `schema:add_column`, `schema:delete_column` to Tier 2

### Section 5 - Engineering Directives

Add new subsections:

**5.8 Memory Management**
- Memory health levels: SOFT (1GB), WARNING (1.5GB), CRITICAL (2.5GB), DANGER (3.5GB)
- Cleanup callback registration for caches during memory pressure
- Memory leak detection requires sustained >50MB/min growth

**5.9 Batch Processing Pattern**
- OFFSET-based batching with deterministic ORDER BY
- Staging table pattern for atomic operations
- WAL checkpoints every 5 batches
- `scheduler.yield()` for UI responsiveness

**5.10 Semantic Validation**
- Type-specific validators in `src/lib/validation/`
- ROW_DETAIL_THRESHOLD (10k rows) for audit capture
- Pre-transform validation with preview support

### Section 7 - Gotchas & Context

Add:
- **Row Identity:** `_cs_origin_id` tracks stable row identity for diff operations
- **Panel Architecture:** Main feature UIs are in `components/panels/`, not `features/`

## Files to Modify

| File | Change |
|------|--------|
| `/Users/narasimhakuchimanchi/Documents/Repos/clean-slate/CLAUDE.md` | Update sections 4, 5, 7 |

## Verification

1. After editing, run `npm run lint` to ensure no markdown issues
2. Visual review of the updated structure against actual `src/` layout

## Decisions

- **Add new subsections:** 5.8 Memory Management, 5.9 Batch Processing, 5.10 Semantic Validation
- **Keep Parameter Preservation sections (5.5, 5.6) as-is** - they're recent and comprehensive
