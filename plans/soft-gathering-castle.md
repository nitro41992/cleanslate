# Recipe Feature Plan

## Problem Statement
Users currently repeat the same 20 clicks (Trim, Fix Dates, Remove Duplicates) every time they get a new CSV. This feature transforms CleanSlate from a "one-off utility" into a "recurring business process" tool.

---

## Design Decisions (Confirmed)

| Decision | Choice |
|----------|--------|
| **Column Mapping** | Auto-match case-insensitively, show UI for unmatched columns |
| **Undo Behavior** | Per-step undo (each step is a separate undo entry) |
| **Architecture** | Hybrid: Audit Log has "Export as Recipe" + Recipe Panel has full editor |
| **Cross-table Ops** | Excluded (Stack/Join not included in recipes) |

---

## Command Safety Analysis

### Commands INCLUDED in Recipes (Schema-Dependent)

**Tier 1 (All 12):** `trim`, `lowercase`, `uppercase`, `title_case`, `remove_accents`, `replace`, `replace_empty`, `sentence_case`, `collapse_spaces`, `remove_non_printable`, `hash`, `mask`

**Tier 2 (1 only):** `rename_column`

**Tier 3 (Most):** `remove_duplicates`, `cast_type`, `split_column`, `combine_columns`, `standardize_date`, `calculate_age`, `unformat_currency`, `fix_negatives`, `pad_zeros`, `fill_down`, `custom_sql`, `scrub:redact`, `scrub:year_only`, `schema:add_column`, `schema:delete_column`, `standardize:apply`

### Commands EXCLUDED from Recipes

| Command | Reason |
|---------|--------|
| `edit:cell`, `edit:batch` | References specific row IDs |
| `match:merge` | MatchPair[] contains row ID pairs |
| `data:insert_row`, `data:delete_row` | References specific row IDs |
| `combine:stack`, `combine:join` | Requires external tables (user decision) |

---

## Architecture (Hybrid Approach)

### Overview

Two entry points, shared data model:
1. **Audit Log Sidebar**: Quick "Export as Recipe" button filters transforms from current session
2. **Recipe Panel**: Full editor for managing, editing, and applying saved recipes

### Data Model (`src/stores/recipeStore.ts`)

```typescript
interface Recipe {
  id: string
  name: string
  description: string
  version: string  // "1.0" for compatibility
  requiredColumns: string[]  // Auto-extracted from steps
  steps: RecipeStep[]
  createdAt: Date
  modifiedAt: Date
}

interface RecipeStep {
  id: string
  type: CommandType  // 'transform:trim', 'scrub:hash', etc.
  label: string
  params: Record<string, unknown>
  enabled: boolean  // Allow toggling steps on/off
}

interface RecipeState {
  recipes: Recipe[]
  selectedRecipeId: string | null
  isProcessing: boolean
  executionProgress: { current: number; total: number } | null
  columnMapping: Record<string, string> | null  // recipe col → actual col
}
```

---

## UI Components

### A. Audit Log Enhancement

Add "Export as Recipe" button to `AuditTimelineSidebar.tsx`:

```
┌─────────────────────────────────────┐
│ Audit Log               [Export as Recipe]  ← NEW
├─────────────────────────────────────┤
│ ✓ Trim → email                      │
│ ✓ Lowercase → email                 │
│ ✗ Edit cell (filtered out)          │  ← Hidden/grayed
│ ✓ Remove Duplicates → email         │
└─────────────────────────────────────┘
```

Click "Export as Recipe" → filters to schema-dependent commands → opens save dialog.

### B. Recipe Panel (`src/components/panels/RecipePanel.tsx`)

```
┌─────────────────────────────────────────────────────┐
│ Recipes                                 [×]         │
├─────────────────────────────────────────────────────┤
│ MY RECIPES                              [Import]    │
│ ┌───────────────────────────────────────────────┐   │
│ │ Email Cleanup          5 steps    [⋮]         │   │
│ │ Customer Prep          8 steps    [⋮]         │   │
│ └───────────────────────────────────────────────┘   │
│                                                     │
│ ─────────── Selected Recipe ───────────            │
│ Name: [Email Cleanup___________]                    │
│ Desc: [Prepare raw email data__]                    │
│                                                     │
│ STEPS (drag to reorder)                             │
│ ┌───────────────────────────────────────────────┐   │
│ │ ☑ 1. Trim → email                         ⋮  │   │
│ │ ☑ 2. Lowercase → email                    ⋮  │   │
│ │ ☐ 3. Hash → ssn (disabled)                ⋮  │   │
│ └───────────────────────────────────────────────┘   │
│                                                     │
│ COLUMN MAPPING (shows when columns don't match)     │
│ ┌───────────────────────────────────────────────┐   │
│ │ Recipe: email → Table: [Email ▾] ✓ matched    │   │
│ │ Recipe: ssn   → Table: [ssn_number ▾] ⚠ map   │   │
│ └───────────────────────────────────────────────┘   │
│                                                     │
│ [Save] [Export JSON] [Delete]   [▶ Apply to Table]  │
└─────────────────────────────────────────────────────┘
```

---

## File Format (`.json`)

```json
{
  "name": "Email Cleanup",
  "description": "Prepare raw email data for analysis",
  "version": "1.0",
  "requiredColumns": ["email"],
  "steps": [
    {
      "id": "step-1",
      "type": "transform:trim",
      "label": "Trim whitespace",
      "params": { "column": "email" },
      "enabled": true
    },
    {
      "id": "step-2",
      "type": "transform:lowercase",
      "label": "Lowercase",
      "params": { "column": "email" },
      "enabled": true
    }
  ],
  "createdAt": "2025-01-15T10:00:00Z",
  "modifiedAt": "2025-01-15T10:00:00Z"
}
```

---

## Recipe Execution Flow

```
User clicks "Apply to Table"
        ↓
Extract requiredColumns from recipe steps
        ↓
Auto-match columns (case-insensitive)
        ↓
Unmatched columns? → Show Column Mapping UI
        ↓
User confirms mapping (or all matched)
        ↓
For each ENABLED step (with progress indicator):
  ├─ Apply column mapping to params
  ├─ createCommand(step.type, { tableId, ...mappedParams })
  ├─ CommandExecutor.execute()  ← Each step = separate undo entry
  ├─ Update progress (step N of M)
  └─ If error → stop, show which step failed, allow skip/abort
        ↓
Complete → Toast "Recipe applied (N steps)"
```

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/stores/recipeStore.ts` | CREATE | Zustand store for recipes |
| `src/stores/previewStore.ts` | MODIFY | Add `'recipe'` to `PanelType` |
| `src/components/panels/RecipePanel.tsx` | CREATE | Full recipe editor panel |
| `src/components/recipe/RecipeList.tsx` | CREATE | Saved recipes list |
| `src/components/recipe/RecipeStepEditor.tsx` | CREATE | Step editor with drag-reorder |
| `src/components/recipe/ColumnMapper.tsx` | CREATE | Column mapping UI |
| `src/components/clean/AuditTimelineSidebar.tsx` | MODIFY | Add "Export as Recipe" button |
| `src/components/layout/ActionToolbar.tsx` | MODIFY | Add Recipe panel button |
| `src/components/layout/FeaturePanel.tsx` | MODIFY | Add recipe panel metadata |
| `src/lib/persistence/state-persistence.ts` | MODIFY | Add recipes to app-state.json |
| `src/lib/recipe/recipe-exporter.ts` | CREATE | Export audit entries to recipe format |
| `src/lib/recipe/recipe-executor.ts` | CREATE | Execute recipe with column mapping |
| `src/lib/recipe/column-matcher.ts` | CREATE | Case-insensitive column matching |

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Create `recipeStore.ts` with Zustand (recipes, selectedRecipeId, isProcessing)
- [ ] Add recipes array to OPFS persistence in `state-persistence.ts`
- [ ] Create `RecipePanel.tsx` shell component
- [ ] Wire up to `FeaturePanel` + `ActionToolbar` (add panel button)

### Phase 2: Recipe Export (Audit Log → Recipe)
- [ ] Create `recipe-exporter.ts` to filter schema-dependent commands from auditStore
- [ ] Add "Export as Recipe" button to `AuditTimelineSidebar.tsx`
- [ ] Implement save dialog (name, description input)
- [ ] Auto-extract `requiredColumns` from step params

### Phase 3: Recipe Editor Panel
- [ ] Create `RecipeList.tsx` (list saved recipes)
- [ ] Create `RecipeStepEditor.tsx` (view/edit steps, toggle enable/disable)
- [ ] Add drag-and-drop step reordering (use existing dnd-kit pattern if present)
- [ ] Add delete recipe confirmation

### Phase 4: Recipe Execution
- [ ] Create `column-matcher.ts` (case-insensitive matching)
- [ ] Create `ColumnMapper.tsx` UI for unmatched columns
- [ ] Create `recipe-executor.ts` (sequential execution with progress)
- [ ] Handle execution errors gracefully (show which step failed)

### Phase 5: Import/Export
- [ ] JSON file download (blob pattern from existing exports)
- [ ] JSON file import (file input → parse → validate → save)
- [ ] Recipe validation on import (check command types are valid)

---

## Verification Plan

### E2E Tests (`e2e/tests/recipes.spec.ts`)

1. **Export from Audit Log**
   - Apply 3 transforms → Click "Export as Recipe" → Verify recipe created
   - Verify manual edits are excluded from export

2. **Apply Recipe to New Table**
   - Import recipe → Load new CSV → Apply → Verify transforms applied

3. **Column Mapping**
   - Recipe expects "email", table has "Email" → Verify auto-match
   - Recipe expects "email", table has "contact_email" → Verify mapping UI appears

4. **Undo Behavior**
   - Apply 3-step recipe → Undo → Verify only last step undone
   - Undo again → Verify second step undone

5. **Import/Export**
   - Export recipe to JSON → Re-import → Verify identical

### Manual Testing
- Apply 10-step recipe to 100k row file (verify progress indicator)
- Verify recipes persist across page reload
- Verify disabled steps are skipped during execution
