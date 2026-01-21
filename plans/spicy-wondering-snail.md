# CleanSlate Pro UI Redesign Plan

## Overview

Complete UI overhaul with **à la carte workflow** (not forced steps). Users upload data, optionally apply any combination of features, and see accumulated changes in a persistent preview. Adopt shadcn/ui wholesale for Notion-style aesthetics.

**Core concept**: Upload → Preview → Apply any features (optional) → Preview updates → Persist as new table

**Performance target**: Handle files up to 2GB (millions of rows) smoothly

---

## 1. Information Architecture

### À La Carte Model (Not Stepper)

Users can apply features in any order, skip any they don't need:
- Upload CSV → See preview → Done (just wanted to view data)
- Upload → Clean (trim whitespace) → Done
- Upload → Clean → Match → Combine → Done
- Upload → Just run Diff against another file → Done

The **preview** is always visible and accumulates all applied operations.

### New Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Logo    │ Tables ▾ │  [Clean] [Match] [Combine] [Scrub] [Diff] │  Actions
│──────────────────────────────────────────────────────────────────│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                                                             │ │
│  │                    DATA PREVIEW                             │ │
│  │                   (Glide DataGrid)                          │ │
│  │                                                             │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Pending Changes: 3 transforms, 12 merges  [Persist as Table]│ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘

When user clicks [Clean] button, a panel slides in from right:
┌──────────────────────────────────────────────────────────────────┐
│                                          │ CLEAN PANEL          │
│         DATA PREVIEW                     │ ─────────────────────│
│                                          │ Add Transform:       │
│                                          │ [Trim] [Upper] [...]│
│                                          │                      │
│                                          │ Recipe:              │
│                                          │ 1. Trim → Name       │
│                                          │ 2. Upper → Status    │
│                                          │                      │
│                                          │ [Apply to Preview]   │
└──────────────────────────────────────────────────────────────────┘
```

### Route Structure (Simplified)
```
/                    → Main app (single page)
/?table=my_table     → Load specific table
/?panel=clean        → Open clean panel
/?panel=match        → Open match panel
```

### Layout Components
- **AppHeader** - Logo, table selector dropdown, action toolbar, global actions
- **ActionToolbar** - Buttons: Clean, Match, Combine, Scrub, Diff
- **PreviewArea** - Central DataGrid showing current preview state
- **FeaturePanel** - Slide-in panel from right for feature configuration
- **StatusBar** - Bottom bar showing pending changes + "Persist as Table" button

---

## 2. shadcn/ui Migration

### Installation
```bash
npx shadcn@latest init
# Style: new-york
# Base color: neutral
# CSS variables: yes
```

### Components to Add
| Component | Purpose |
|-----------|---------|
| `button` | Toolbar buttons, actions |
| `card` | Panel containers |
| `dialog` | Modals (ingestion wizard) |
| `input` | Form fields |
| `select` | Table selector, dropdowns |
| `checkbox` | Multi-select in matcher |
| `data-table` | Matcher table view (TanStack) |
| `sheet` | Slide-in feature panels |
| `command` | Future: quick actions |
| `badge` | Status indicators |
| `sonner` | Toast notifications |
| `dropdown-menu` | Table actions menu |
| `popover` | Tooltips, popovers |
| `separator` | Visual dividers |

### Color Theme (Notion-style dark)
```css
.dark {
  --background: 25 5% 10%;      /* #191919 */
  --foreground: 0 0% 98%;
  --card: 25 5% 12%;            /* #202020 */
  --popover: 25 5% 14%;
  --primary: 211 100% 50%;      /* Notion blue #2383e2 */
  --secondary: 25 5% 20%;
  --muted: 25 5% 25%;
  --muted-foreground: 0 0% 60%;
  --accent: 25 5% 18%;
  --border: 25 5% 18%;
}
```

---

## 3. Unified Preview System

### New Store: `previewStore.ts`

```typescript
interface PreviewState {
  // Active table being worked on
  activeTableId: string | null
  activeTableName: string | null

  // Pending operations queue (not yet persisted)
  pendingOperations: PendingOperation[]

  // Preview state
  isPreviewDirty: boolean  // true if pending ops exist
  previewRowCount: number

  // Change summary (vs original)
  changesSummary: {
    transformsApplied: number
    rowsMerged: number
    rowsCombined: number
    columnsObfuscated: number
  } | null
}

interface PendingOperation {
  id: string
  type: 'transform' | 'merge' | 'combine' | 'scrub'
  label: string  // Human readable: "Trim whitespace on Name"
  config: unknown
  timestamp: Date
}
```

### Flow
1. User uploads/selects table → Shown in preview
2. User opens Clean panel → Builds recipe → Clicks "Apply to Preview"
3. `pendingOperations` updated, preview regenerates, status bar shows "1 transform pending"
4. User opens Match panel → Reviews matches → Clicks "Apply Merges"
5. `pendingOperations` updated, preview shows merged data
6. User clicks **"Persist as Table"** → Creates new table with all changes baked in

### "Persist as Table" Flow
1. User clicks button
2. Dialog opens: "Save as new table" with name input
3. On confirm:
   - Execute all pending operations in DuckDB
   - Create new table entry with lineage metadata
   - Clear `pendingOperations`
   - Add audit log entry
   - New table becomes active

---

## 4. Large File Handling (Up to 2GB)

### Core Strategy: DuckDB Does the Heavy Lifting

The key insight is that **DuckDB-WASM handles all data** - the UI never loads full datasets into memory. We only fetch what's needed for display.

### Preview Virtualization

```typescript
// DataGrid already uses virtualization via Glide Data Grid
// Key settings for large files:
const PAGE_SIZE = 500          // Rows fetched per scroll chunk
const VISIBLE_BUFFER = 100     // Extra rows above/below viewport
const MAX_PREVIEW_SAMPLE = 1000 // Sample size for non-virtualized previews
```

**How it works:**
1. User uploads 2GB file → DuckDB parses in Web Worker (streaming)
2. `tableStore` receives metadata: `{ rowCount: 5_000_000, columns: [...] }`
3. DataGrid renders empty container with correct scroll height
4. As user scrolls, `onVisibleRegionChanged` fires → fetch that row range
5. Only ~500-1000 rows in memory at any time

### Transform Preview for Large Files

When applying transforms, we DON'T regenerate full preview:

```typescript
// Instead of materializing all transformed data:
const previewQuery = `
  SELECT *
  FROM ${tableName}
  WHERE rowid BETWEEN ${visibleStart} AND ${visibleEnd}
  -- Apply transform inline
  ${transformSQL}
`

// Transforms are LAZY - only computed for visible rows
// Full transform happens only at "Persist as Table" time
```

### Audit Details for Large Files

**Problem**: If a transform affects 5M rows, we can't store 5M before/after pairs.

**Solution**: Sample-based audit details with count summary:

```typescript
interface LargeFileAuditEntry {
  // Summary (always shown)
  rowsAffected: number        // 5,000,000

  // Sample details (for drill-down)
  sampleSize: number          // 1000
  sampleDetails: RowDetail[]  // First 1000 affected rows

  // Full export available via SQL
  fullDetailsQuery: string    // "SELECT * FROM _audit_details_123"
}
```

**UI indicates this:**
```
Transform: Trim → Name
Rows affected: 5,000,000
Showing first 1,000 affected rows • [Export Full Details as CSV]
```

### Matcher for Large Files

**Problem**: Levenshtein cross-join on 5M rows = explosion.

**Solution**: Already implemented blocking strategies + limit:

```typescript
// Current: Limits to 500 pairs max
// Enhancement: Progressive loading
const INITIAL_PAIRS = 100
const LOAD_MORE_INCREMENT = 100

// UI shows: "Showing 100 of 2,847 potential matches [Load More]"
```

### Memory Management

```typescript
// In previewStore - track memory pressure
interface PreviewState {
  // ...existing fields...

  // Large file indicators
  isLargeFile: boolean        // true if > 100MB or > 1M rows
  rowCount: number
  estimatedSizeMB: number

  // Memory-saving mode
  lazyPreviewEnabled: boolean // true for large files
}
```

### Upload Progress for Large Files

```typescript
// Show progress during large file ingestion
interface UploadProgress {
  phase: 'reading' | 'parsing' | 'indexing' | 'ready'
  bytesRead: number
  totalBytes: number
  rowsParsed: number
  estimatedTimeRemaining?: number
}
```

UI shows:
```
┌─────────────────────────────────────────┐
│ Uploading large_dataset.csv (1.8 GB)    │
│ ████████████░░░░░░░░░░░░ 52%            │
│ Parsing rows... 2,456,000 processed     │
└─────────────────────────────────────────┘
```

### Key Constraints

1. **Never load full dataset into JS memory** - DuckDB handles it
2. **Virtualize all grids** - Glide Data Grid already does this
3. **Lazy transform evaluation** - Only compute for visible rows
4. **Sample audit details** - Store summary + sample, not full dataset
5. **Progressive matcher results** - Load in batches with "Load More"
6. **Streaming CSV export** - Use DuckDB's COPY TO for exports

---

## 5. Audit Log Integration

### Always-Visible Audit Trail

The audit log is **always visible** alongside the preview, showing every operation that produced the current preview state.

```
┌──────────────────────────────────────────────────────────────────┐
│  [Clean] [Match] [Combine] [Scrub] [Diff]                       │
│──────────────────────────────────────────────────────────────────│
│                                           │ AUDIT LOG           │
│                                           │─────────────────────│
│      DATA PREVIEW                         │ Applied Operations: │
│      (accumulated changes)                │                     │
│                                           │ 1. Trim → Name      │
│                                           │    └ 1,234 rows     │
│                                           │                     │
│                                           │ 2. Upper → Status   │
│                                           │    └ 1,234 rows     │
│                                           │                     │
│                                           │ 3. Merge duplicates │
│                                           │    └ 45 pairs → 45  │
│                                           │      rows removed   │
│                                           │                     │
│                                           │ [View Details]      │
│──────────────────────────────────────────────────────────────────│
│ Pending: 3 operations                     [Persist as Table]    │
└──────────────────────────────────────────────────────────────────┘
```

### Drill-Down to Cell-Level Detail

Clicking an operation in the audit log opens a detail view showing:

**For Transforms (Type A):**
```
┌─────────────────────────────────────────────────────────────────┐
│ Transform: Trim Whitespace → Name column                        │
│ Applied: 2 minutes ago                                          │
│ Rows affected: 1,234                                            │
│─────────────────────────────────────────────────────────────────│
│ Row  │ Before              │ After                              │
│──────│─────────────────────│────────────────────────────────────│
│ 1    │ "  John Smith  "    │ "John Smith"                       │
│ 2    │ "Alice Wong "       │ "Alice Wong"                       │
│ 3    │ " Bob Jones"        │ "Bob Jones"                        │
│ ...  │                     │                                    │
│──────────────────────────────────────────────────────────────────│
│                                              [Export as CSV]    │
└─────────────────────────────────────────────────────────────────┘
```

**For Matcher Merges:**
```
┌─────────────────────────────────────────────────────────────────┐
│ Action: Merge Duplicates                                        │
│ Applied: 5 minutes ago                                          │
│ Pairs merged: 45 │ Rows removed: 45                             │
│─────────────────────────────────────────────────────────────────│
│ #  │ Kept Record         │ Removed Record      │ Score         │
│────│─────────────────────│─────────────────────│───────────────│
│ 1  │ John Smith          │ Jon Smith           │ 2             │
│ 2  │ Alice Wong          │ Alice Wong          │ 0             │
│ 3  │ Robert Jones        │ Bob Jones           │ 5             │
│──────────────────────────────────────────────────────────────────│
│                                              [Export as CSV]    │
└─────────────────────────────────────────────────────────────────┘
```

### Audit Store Updates

```typescript
// Enhanced audit entry for preview operations
interface PreviewAuditEntry {
  id: string
  type: 'transform' | 'merge' | 'combine' | 'scrub'

  // Display info
  label: string           // "Trim Whitespace → Name"
  timestamp: Date

  // Impact metrics
  rowsAffected: number

  // Row-level details (stored in _audit_details table)
  hasRowDetails: boolean
  detailsQuery?: string   // SQL to fetch details from _audit_details

  // For merges specifically
  pairsMerged?: number
  rowsRemoved?: number
}
```

### Layout Component: `AuditSidebar`

The audit log is a **collapsible right sidebar** (not a panel that covers content):

```typescript
// In AppLayout.tsx
<div className="flex h-screen">
  <main className="flex-1 flex flex-col">
    <AppHeader />
    <PreviewArea />
    <StatusBar />
  </main>

  {/* Always visible, collapsible */}
  <AuditSidebar
    entries={previewAuditEntries}
    onEntryClick={openDetailModal}
    collapsed={auditCollapsed}
    onToggle={toggleAudit}
  />
</div>
```

### Key Behaviors

1. **Audit updates in real-time** as operations are applied to preview
2. **Entries are ordered** newest-first (most recent at top)
3. **Click any entry** to see cell-level detail in a modal
4. **"Export as CSV"** in detail modal exports the before/after data
5. **When "Persist as Table"** is clicked, audit entries are moved to permanent audit log
6. **Clear audit** only when starting fresh with a new source table

---

## 5. Matcher Redesign

### Table-Based View (Not Card Swipe)

```
┌──────────────────────────────────────────────────────────────────┐
│ MATCH PANEL                                                      │
│──────────────────────────────────────────────────────────────────│
│ Match Column: [Name ▾]   Threshold: [5]   [Find Matches]        │
│──────────────────────────────────────────────────────────────────│
│ Summary: 45 Definite │ 12 Maybe │ 8 Not Match                   │
│──────────────────────────────────────────────────────────────────│
│ Filter: (•) All  ( ) Definite  ( ) Maybe  ( ) Not Match         │
│──────────────────────────────────────────────────────────────────│
│ □ │ Record A      │ Record B      │ Score │ Type     │ Action   │
│───│───────────────│───────────────│───────│──────────│──────────│
│ □ │ John Smith    │ Jon Smith     │   2   │ Definite │ [M] [S]  │
│ □ │ Alice Wong    │ Alice Wong    │   0   │ Definite │ [M] [S]  │
│ □ │ Robert Jones  │ Bob Jones     │   5   │ Maybe    │ [M] [S]  │
│ ▼ │ (expanded: full record comparison)                          │
│──────────────────────────────────────────────────────────────────│
│ Selected: 3    [Merge Selected] [Keep Separate]                  │
└──────────────────────────────────────────────────────────────────┘
```

### Classification
```typescript
function classifyMatch(score: number, threshold: number) {
  if (score === 0) return 'definite'
  if (score <= threshold * 0.4) return 'definite'
  if (score <= threshold) return 'maybe'
  return 'not_match'
}
```

### Features
- **Grouping by classification** with filter tabs
- **Bulk selection** with checkboxes
- **Expandable rows** to see full record comparison
- **Bulk actions** bar at bottom when items selected
- **M/S keyboard shortcuts** still work for focused row

---

## 5. Component Architecture

### New Structure
```
src/
├── components/
│   ├── ui/                      # shadcn/ui components
│   │   └── (all shadcn components)
│   │
│   ├── layout/
│   │   ├── AppLayout.tsx        # NEW - Main layout wrapper
│   │   ├── AppHeader.tsx        # NEW - Top bar with toolbar
│   │   ├── ActionToolbar.tsx    # NEW - Feature buttons
│   │   ├── FeaturePanel.tsx     # NEW - Slide-in panel shell
│   │   ├── StatusBar.tsx        # NEW - Bottom pending changes bar
│   │   └── AuditSidebar.tsx     # NEW - Always-visible audit log
│   │
│   ├── panels/                  # NEW - Feature panel contents
│   │   ├── CleanPanel.tsx       # Transform builder (from RecipePanel)
│   │   ├── MatchPanel.tsx       # Table-based matcher
│   │   ├── CombinePanel.tsx     # Stack/join UI
│   │   ├── ScrubPanel.tsx       # Obfuscation rules
│   │   └── DiffPanel.tsx        # Comparison config
│   │
│   ├── matcher/                 # NEW - Matcher table components
│   │   ├── MatcherTable.tsx     # DataTable with TanStack
│   │   ├── MatcherFilters.tsx   # Classification filter
│   │   ├── MatchDetailRow.tsx   # Expandable comparison
│   │   └── BulkActionBar.tsx    # Selection actions
│   │
│   ├── grid/
│   │   └── DataGrid.tsx         # KEEP - Glide integration
│   │
│   └── common/
│       ├── FileDropzone.tsx     # KEEP
│       ├── IngestionWizard.tsx  # KEEP
│       ├── TableSelector.tsx    # NEW - Dropdown for table selection
│       └── AuditLog.tsx         # REFACTOR - Simpler list
│
├── stores/
│   ├── previewStore.ts          # NEW - Unified preview state
│   ├── tableStore.ts            # KEEP - Table metadata
│   ├── matcherStore.ts          # MODIFY - Add table view state
│   ├── auditStore.ts            # KEEP
│   └── uiStore.ts               # MODIFY - Panel open state
│
└── App.tsx                       # REWRITE - Single page app
```

### Delete After Migration
- `src/features/` (entire directory - siloed pages)
- `src/components/layout/AppShell.tsx`
- `src/features/matcher/components/CardStack.tsx`
- `src/features/matcher/components/MatchStats.tsx`

---

## 6. Implementation Phases

### Phase 1: Foundation (shadcn/ui + Layout)
1. Install shadcn/ui with New York style
2. Add core components: Button, Card, Sheet, Dialog, Select, Input, Sonner
3. Create new layout: `AppLayout`, `AppHeader`, `ActionToolbar`
4. Create `FeaturePanel` shell (Sheet-based slide-in)
5. Rewrite `App.tsx` as single-page app
6. Migrate toast to Sonner

### Phase 2: Preview System
1. Create `previewStore.ts`
2. Build `StatusBar` with pending changes display
3. Implement "Persist as Table" dialog and flow
4. Wire preview to DataGrid
5. Connect audit logging

### Phase 3: Feature Panels
1. `CleanPanel` - Extract from RecipePanel, adapt to panel format
2. `CombinePanel` - Stack/join UI in panel
3. `ScrubPanel` - Obfuscation rules in panel
4. `DiffPanel` - Comparison config in panel

### Phase 4: Matcher Redesign
1. Install TanStack Table
2. Build `MatcherTable`, `MatcherFilters`, `MatchDetailRow`
3. Update `matcherStore` with selection/classification
4. Build `MatchPanel` integrating table view
5. Delete CardStack

### Phase 5: Polish
1. Delete old feature pages
2. Update E2E tests for new selectors
3. Keyboard shortcuts
4. Final styling pass

---

## 7. Files to Modify

### Critical Files
| File | Action |
|------|--------|
| `src/App.tsx` | Rewrite as single-page with panel system |
| `src/index.css` | Update CSS variables for Notion theme |
| `package.json` | Add `@tanstack/react-table`, `sonner` |

### New Files
| File | Purpose |
|------|---------|
| `src/stores/previewStore.ts` | Unified preview + pending operations |
| `src/components/layout/AppLayout.tsx` | Main layout |
| `src/components/layout/AppHeader.tsx` | Top bar |
| `src/components/layout/ActionToolbar.tsx` | Feature buttons |
| `src/components/layout/FeaturePanel.tsx` | Slide-in panel |
| `src/components/layout/StatusBar.tsx` | Pending changes |
| `src/components/layout/AuditSidebar.tsx` | Always-visible audit log |
| `src/components/common/AuditDetailModal.tsx` | Cell-level detail view |
| `src/components/panels/CleanPanel.tsx` | Transform builder |
| `src/components/panels/MatchPanel.tsx` | Matcher UI |
| `src/components/panels/CombinePanel.tsx` | Stack/join |
| `src/components/panels/ScrubPanel.tsx` | Obfuscation |
| `src/components/panels/DiffPanel.tsx` | Comparison |
| `src/components/matcher/MatcherTable.tsx` | Table view |

---

## 8. Verification Plan

### Manual Testing
1. **Upload**: Drop CSV → Preview shows data
2. **Clean**: Click Clean → Panel opens → Add transform → Apply → Preview updates
3. **Match**: Click Match → Configure → Find matches → Table shows grouped results → Select rows → Bulk merge → Preview updates
4. **Combine**: Upload 2nd file → Click Combine → Select tables → Stack/Join → Preview shows combined
5. **Scrub**: Click Scrub → Add rules → Preview shows obfuscated
6. **Diff**: Click Diff → Select comparison table → See highlighted changes
7. **Persist**: Click "Persist as Table" → New table created → Appears in table dropdown

### E2E Test Updates
- Update selectors from `.sidebar-nav` to `.action-toolbar`
- Update panel interactions (Sheet instead of page navigation)
- Keep core data flow tests intact

### Performance Testing (Large Files)
- **100k rows**: Loads in < 5s, scrolling smooth 60fps
- **1M rows**: Loads in < 30s, scrolling smooth, transforms responsive
- **5M+ rows (2GB file)**:
  - Upload shows progress indicator
  - Grid renders with virtualization (only visible rows loaded)
  - Transforms apply lazily (no full materialization)
  - Audit shows sample + full export option
  - Memory stays under browser limits (~2GB heap)
- **Panel open/close**: Instant regardless of file size
- **Matcher on large files**: Shows progressive results with "Load More"

---

## 9. Gap Fills (Critical UX Considerations)

### Empty States

Every view needs a designed empty state:

| View | Empty State |
|------|-------------|
| **Preview (no table)** | "Drop a CSV file here or select a table from the dropdown" + Upload icon |
| **Preview (table selected, no transforms)** | Show data normally - this is the base state |
| **Audit sidebar (no operations)** | "No changes yet. Apply transforms, matches, or other operations to see history here." |
| **Matcher (no matches found)** | "No potential duplicates found. Try lowering the similarity threshold or selecting a different column." |
| **Matcher (no table selected)** | "Select a table to find duplicate records." |
| **Feature panel (initial state)** | Show configuration form with sensible defaults, ready to use |

### Error Handling Strategy

```
Error Severity → UI Treatment
──────────────────────────────────────────────────────────────
Fatal (DuckDB crash)     → Full-screen error with reload button
Operation failure        → Toast notification + operation stays in panel for retry
Validation error         → Inline error message in form field
Warning (data quality)   → Yellow banner in preview header
```

**Key errors to handle:**
- DuckDB initialization failure → Show error page with "Try reloading"
- Transform execution error → Toast with error message, operation remains in pending queue
- File parse error → IngestionWizard shows error, allows retry with different settings
- OPFS quota exceeded → Warning before operation, suggest exporting data first
- Memory limit → Show warning when file > 500MB, graceful degradation

### Undo/Redo Model

**Before Persist:**
- Pending operations queue acts as undo history
- Each operation in audit sidebar has a **[Remove]** button
- Removing an operation re-computes preview without it
- Recipe panel in Clean allows reordering/removing transforms before apply

**After Persist:**
- No undo - but user can create checkpoints before persisting
- Clear messaging: "This will permanently save changes. Create a checkpoint first?"
- Checkpoints appear in table dropdown as "my_table (checkpoint)"

### Multi-Table Selection

For Combine and Diff which need 2+ tables:

```
┌──────────────────────────────────────────────────────────────┐
│ COMBINE PANEL                                                │
│──────────────────────────────────────────────────────────────│
│ Mode: ( ) Stack (UNION)  (•) Join                           │
│──────────────────────────────────────────────────────────────│
│ Table A: [sales_jan ▾]     ← Standard dropdown              │
│ Table B: [sales_feb ▾]     ← Second dropdown                │
│                                                              │
│ Join Type: [Left ▾]   Key Column: [customer_id ▾]           │
│──────────────────────────────────────────────────────────────│
│ Preview: 1,234 rows will result                              │
│                                                              │
│                                    [Apply to Preview]        │
└──────────────────────────────────────────────────────────────┘
```

- Tables selected via dropdowns within the panel (not sidebar multi-select)
- Cannot select the same table twice
- Active preview table auto-fills as "Table A"

### Conflicting Operations

**Rule: One operation at a time**

When an operation is running:
1. Toolbar buttons remain visible but disabled (grayed out)
2. Active panel shows progress indicator
3. "Cancel" button available for long operations
4. Status bar shows: "Applying transform... [Cancel]"

Panel close during operation:
- Confirm dialog: "Operation in progress. Cancel and close?"

Table switch during operation:
- Disabled until operation completes

### Loading States

| Operation | Duration | Loading Treatment |
|-----------|----------|-------------------|
| File upload | 1-60s | Progress bar with % and rows parsed |
| Transform (small) | <1s | Button shows spinner, instant feedback |
| Transform (large) | 1-30s | Progress bar in status bar, preview shows skeleton |
| Match finding | 2-30s | Progress bar, "Analyzing X of Y records..." |
| Persist | 1-10s | Full-screen overlay: "Saving table..." |

### State Persistence

**On page refresh (with unsaved work):**
- Browser `beforeunload` warning: "You have unsaved changes"
- pendingOperations stored in sessionStorage (survives refresh, not tab close)
- Offer to restore on reload: "Restore your session?" [Yes] [Start Fresh]

**Manual save:**
- "Persist as Table" saves to DuckDB + OPFS
- Session state (open panels, scroll position) not persisted

### Panel Behavior

- **Single panel at a time** - opening new panel closes current
- **Panel width:** 400px fixed (not resizable)
- **Panel state:** Preserved within session (close [Clean], open [Match], reopen [Clean] - settings remain)
- **Close triggers:** X button, Escape key, clicking outside panel
- **Minimum viewport:** 1280px width - below this, show horizontal scroll warning

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Escape` | Close active panel |
| `Ctrl+Z` | Undo last cell edit (when in grid) |
| `Ctrl+Shift+Z` | Redo cell edit |
| `Ctrl+S` | Persist as Table (with confirm) |
| `1-5` | Open panel (1=Clean, 2=Match, 3=Combine, 4=Scrub, 5=Diff) |
| `?` | Show keyboard shortcuts help |

### Accessibility Basics

- All toolbar buttons have `aria-label`
- Panels use `role="dialog"` with `aria-labelledby`
- Operation completion announced via `aria-live` region
- Focus trapped in open panels
- Focus returns to trigger button on panel close
- Color contrast: WCAG AA (4.5:1 for text)

---

## Summary

This redesign transforms CleanSlate Pro from siloed tabs into an **à la carte toolbar-based UI**:

- **Single page** with persistent preview
- **Toolbar** provides access to features (Clean, Match, Combine, Scrub, Diff)
- **Slide-in panels** for feature configuration
- **Preview accumulates** all applied operations
- **Always-visible audit sidebar** shows all operations with drill-down to cell-level detail
- **Persist as Table** saves the result
- **Table-based Matcher** replaces card swipe
- **shadcn/ui** for consistent Notion-style aesthetics
