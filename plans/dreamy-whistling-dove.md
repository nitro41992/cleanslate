# Recipe & Audit Log Redesign Plan

## Problem Summary

1. **Recipe creation is hidden** - Only accessible via small "Export as Recipe" button in audit sidebar
2. **Audit log shows noise** - Every transform logged, including duplicates and no-ops
3. **No idempotency** - Same transform can be applied repeatedly without smart detection
4. **Unclear distinction** - Audit log vs recipes serve different purposes but UX conflates them

## Solution Architecture

### Core Principle: Result-Based Idempotency via SQL

Instead of expensive per-cell metadata tracking, use SQL's `IS DISTINCT FROM` operator:

```sql
-- Current: Touches ALL rows
UPDATE table SET col = TRIM(col);

-- Proposed: Only touches cells that would change
UPDATE table SET col = TRIM(col) WHERE col IS DISTINCT FROM TRIM(col);
```

**Result:** If `rowsAffected === 0`, skip audit logging entirely.

---

## Implementation Phases

### Phase 1: SQL Idempotency (Foundation)

**Goal:** Transforms only affect cells that need changing; audit only logs actual changes.

#### 1.1 Update `getAffectedRowsPredicate()` in all Tier 1 commands

Use `IS DISTINCT FROM` pattern for NULL-safe comparison:

**Files to modify:**
- `src/lib/commands/transform/tier1/trim.ts`
- `src/lib/commands/transform/tier1/lowercase.ts`
- `src/lib/commands/transform/tier1/uppercase.ts`
- `src/lib/commands/transform/tier1/title-case.ts`
- `src/lib/commands/transform/tier1/sentence-case.ts`
- `src/lib/commands/transform/tier1/collapse-spaces.ts`
- `src/lib/commands/transform/tier1/remove-accents.ts`
- `src/lib/commands/transform/tier1/remove-non-printable.ts`

**Change pattern:**
```typescript
// Before
async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
  const col = this.getQuotedColumn()
  return `${col} IS NOT NULL AND ${col} != TRIM(${col})`
}

// After
async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string> {
  const col = this.getQuotedColumn()
  return `${col} IS DISTINCT FROM TRIM(${col})`
}
```

#### 1.2 Add pre-check to `Tier1TransformCommand.execute()` (OPTIMIZED)

**File:** `src/lib/commands/transform/base.ts`

**Critical Performance Optimization:** Use `LIMIT 1` instead of `COUNT(*)` to avoid double-scanning large tables.

```typescript
async execute(ctx: CommandContext): Promise<ExecutionResult> {
  // PRE-CHECK: Check if ANY row needs changing (LIMIT 1 for performance)
  const predicate = await this.getAffectedRowsPredicate(ctx)
  if (predicate && predicate !== 'TRUE') {
    const checkResult = await ctx.db.query<{ exists: number }>(
      `SELECT 1 as exists FROM ${this.getQuotedTable(ctx)} WHERE ${predicate} LIMIT 1`
    )
    const needsUpdate = checkResult.length > 0

    if (!needsUpdate) {
      // No changes needed - return success with affected=0
      return {
        success: true,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected: 0,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    }
  }

  // ... existing execute logic
  // NOTE: The actual affected count comes from the UPDATE/CTAS result, not pre-check
}
```

**Why LIMIT 1:**
- **Valid case (dirty table):** Returns immediately on first dirty row. Zero overhead.
- **Idempotent case (clean table):** Scans whole table but saves the expensive OPFS snapshot.
- **Never double-scans:** We don't need the count upfront; the UPDATE returns `affected_rows`.
```

#### 1.3 Conditional audit/timeline/snapshot in executor

**File:** `src/lib/commands/executor.ts`

Modify to skip recording AND snapshotting when `affected === 0`:

```typescript
// IMPORTANT: The affected count comes from the UPDATE/CTAS execution result
// Do NOT rely on pre-check count - the UPDATE result is the source of truth

// Around snapshot logic - ONLY snapshot if rows were affected
if (executionResult.affected > 0) {
  // Existing snapshot logic for Tier 3 commands
}

// Around line 502-514 - Audit logging
if (!skipAudit && executionResult.affected > 0) {
  progress('auditing', 60, 'Recording audit log...')
  auditInfo = command.getAuditInfo(updatedCtx, executionResult)
  this.recordAudit(ctx.table.id, ctx.table.name, auditInfo)
}

// Around line 639-662 - Timeline recording
if (!skipTimeline && executionResult.affected > 0) {
  progress('complete', 90, 'Recording timeline...')
  // ... existing timeline recording logic
}
```

**Key Insight:** The `affected` count from the actual UPDATE/CTAS execution is the source of truth for audit logging, not any pre-check value.

---

### Phase 2: Recipe Builder UX Redesign

**Goal:** Make recipe creation prominent with "design from scratch" as primary flow.

#### 2.1 Redesign RecipePanel entry experience

**File:** `src/components/panels/RecipePanel.tsx`

Replace current empty state with prominent build options:

```tsx
// When no recipe selected and no build mode active
{!selectedRecipe && (
  <div className="flex flex-col gap-4 p-6">
    {/* Primary CTA: Build from Scratch */}
    <Button
      variant="default"
      size="lg"
      className="h-14 text-base"
      onClick={() => setBuildMode('scratch')}
    >
      <Wand2 className="w-5 h-5 mr-3" />
      Build New Recipe
    </Button>

    {/* Secondary CTA: Import from History */}
    <Button
      variant="outline"
      onClick={() => setBuildMode('import')}
    >
      <History className="w-4 h-4 mr-2" />
      Import from Audit Log
    </Button>

    <Separator className="my-2" />

    {/* Existing recipes list */}
    <div className="text-sm text-muted-foreground mb-2">
      My Recipes ({recipes.length})
    </div>
    {/* ... recipe list */}
  </div>
)}
```

#### 2.2 Create RecipeStepBuilder component

**New file:** `src/components/panels/RecipeStepBuilder.tsx`

Allows adding transform steps without executing them:

```tsx
interface RecipeStepBuilderProps {
  recipeId: string
  tableColumns: string[]
  onStepAdded: () => void
}

const TRANSFORM_CATEGORIES = {
  'Text Cleaning': ['trim', 'lowercase', 'uppercase', 'title_case', 'collapse_spaces'],
  'Data Quality': ['remove_duplicates', 'fill_down', 'replace_empty', 'replace'],
  'Format': ['standardize_date', 'pad_zeros', 'unformat_currency', 'calculate_age'],
  'Structure': ['split_column', 'combine_columns', 'rename_column'],
  'Security': ['hash', 'mask', 'redact', 'year_only'],
}

export function RecipeStepBuilder({ recipeId, tableColumns, onStepAdded }: RecipeStepBuilderProps) {
  const [category, setCategory] = useState<string | null>(null)
  const [transform, setTransform] = useState<string | null>(null)
  const [column, setColumn] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, unknown>>({})

  const addStep = useRecipeStore((s) => s.addStep)

  const handleAddStep = () => {
    if (!transform) return

    const step: Omit<RecipeStep, 'id'> = {
      type: `transform:${transform}`,
      label: generateStepLabel(transform, column, params),
      column: column || undefined,
      params: Object.keys(params).length > 0 ? params : undefined,
      enabled: true,
    }

    addStep(recipeId, step)
    onStepAdded()

    // Reset form
    setTransform(null)
    setColumn(null)
    setParams({})
  }

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
      {/* Category selector */}
      {/* Transform selector (filtered by category) */}
      {/* Column selector (if transform requires it) */}
      {/* Dynamic params form based on transform type */}
      <Button onClick={handleAddStep} disabled={!transform}>
        <Plus className="w-4 h-4 mr-2" />
        Add Step
      </Button>
    </div>
  )
}
```

#### 2.3 Add "Already Applied" status detection

**New file:** `src/lib/recipe/step-status.ts`

```typescript
export type StepApplicationStatus =
  | 'not_applied'
  | 'already_applied'
  | 'modified_since'

// Commands that modify row structure (affect all columns)
const STRUCTURE_MODIFYING_COMMANDS = new Set([
  'remove_duplicates',
  'filter_empty',
  'data:delete_row',
  'data:insert_row',
  'match:merge',
])

export function getStepApplicationStatus(
  step: RecipeStep,
  tableId: string,
  columnMapping: Record<string, string>
): StepApplicationStatus {
  const timeline = useTimelineStore.getState().getTimeline(tableId)
  if (!timeline) return 'not_applied'

  const mappedColumn = step.column
    ? columnMapping[step.column] || step.column
    : undefined

  // Extract transform type from step.type (e.g., 'transform:trim' -> 'trim')
  const transformType = step.type.replace(/^(transform|scrub|standardize):/, '')

  // Search timeline for matching command
  const matchIndex = timeline.commands.findIndex((cmd, idx) => {
    if (idx > timeline.currentPosition) return false // Skip undone commands

    const params = cmd.params as Record<string, unknown>
    if (params.transformationType !== transformType) return false
    if (mappedColumn && params.column !== mappedColumn) return false

    return true
  })

  if (matchIndex === -1) return 'not_applied'

  // Check if column was modified after the match
  // OR if a structure-modifying command ran (affects row context for ALL columns)
  const laterModification = timeline.commands
    .slice(matchIndex + 1, timeline.currentPosition + 1)
    .some((cmd) => {
      const p = cmd.params as Record<string, unknown>
      const cmdType = p.transformationType as string

      // Structure-modifying commands invalidate ALL column-specific steps
      if (STRUCTURE_MODIFYING_COMMANDS.has(cmdType)) return true

      // Column-specific modification
      return p.column === mappedColumn
    })

  return laterModification ? 'modified_since' : 'already_applied'
}
```

#### 2.4 Visual indicators in RecipePanel steps

**File:** `src/components/panels/RecipePanel.tsx`

Add status badges to step rendering:

```tsx
// In step list rendering
{recipe.steps.map((step) => {
  const status = activeTableId
    ? getStepApplicationStatus(step, activeTableId, pendingColumnMapping || {})
    : 'not_applied'

  return (
    <div
      key={step.id}
      className={cn(
        'border rounded-lg transition-colors',
        status === 'already_applied' && 'border-emerald-500/40 bg-emerald-500/5',
        status === 'modified_since' && 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      <div className="flex items-center gap-2 p-3">
        {/* Existing step content */}

        {/* Status indicator */}
        {status === 'already_applied' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/50">
                <Check className="w-3 h-3 mr-1" />
                Applied
              </Badge>
            </TooltipTrigger>
            <TooltipContent>This step has already been applied to the current table</TooltipContent>
          </Tooltip>
        )}
        {status === 'modified_since' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-amber-500 border-amber-500/50">
                <AlertCircle className="w-3 h-3 mr-1" />
                Modified
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Applied, but column was modified since</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
})}
```

---

### Phase 3: Recipe Discoverability

**Goal:** Make recipe creation accessible from multiple entry points.

#### 3.1 Add "Save as Recipe" in CleanPanel after transforms

**File:** `src/components/panels/CleanPanel.tsx`

After applying transforms, show quick-save option:

```tsx
// Add near the bottom of the panel, after transform application section
{timeline && timeline.commands.length > 0 && (
  <div className="border-t pt-4 mt-4">
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        setActivePanel('recipe')
        // Could pre-populate with current transforms
      }}
    >
      <BookOpen className="w-4 h-4 mr-2" />
      Save transforms as recipe
    </Button>
  </div>
)}
```

#### 3.2 Multi-select audit entries for import (UX Enhancement)

**File:** `src/components/panels/RecipePanel.tsx` (import mode)

When importing from audit log, allow multi-select of specific entries rather than "Import All":

```tsx
// In import mode UI
const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set())

{importMode && (
  <div className="space-y-2">
    <p className="text-sm text-muted-foreground">
      Select transforms to include (users often undo mistakes that shouldn't end up in recipes)
    </p>
    {auditEntries.map((entry) => (
      <div
        key={entry.id}
        className={cn(
          'flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-muted/50',
          selectedEntries.has(entry.id) && 'bg-primary/10 border border-primary/30'
        )}
        onClick={() => toggleEntry(entry.id)}
      >
        <Checkbox checked={selectedEntries.has(entry.id)} />
        <span className="text-sm">{entry.action}</span>
        <span className="text-xs text-muted-foreground ml-auto">{entry.details}</span>
      </div>
    ))}
    <Button onClick={handleImportSelected} disabled={selectedEntries.size === 0}>
      Import {selectedEntries.size} step{selectedEntries.size !== 1 ? 's' : ''}
    </Button>
  </div>
)}
```

#### 3.3 Recipe count badge on ActionToolbar

**File:** `src/components/layout/ActionToolbar.tsx`

Show badge when recipes exist:

```tsx
// In the recipe action button
{action.id === 'recipe' && recipes.length > 0 && (
  <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-primary text-[10px] text-primary-foreground flex items-center justify-center">
    {recipes.length}
  </span>
)}
```

---

## Files to Modify

### Core Idempotency (Phase 1)
| File | Change |
|------|--------|
| `src/lib/commands/transform/base.ts` | Add pre-check for 0 affected rows |
| `src/lib/commands/executor.ts` | Skip audit/timeline when affected=0 |
| `src/lib/commands/transform/tier1/trim.ts` | Update predicate to IS DISTINCT FROM |
| `src/lib/commands/transform/tier1/lowercase.ts` | Update predicate |
| `src/lib/commands/transform/tier1/uppercase.ts` | Update predicate |
| `src/lib/commands/transform/tier1/title-case.ts` | Update predicate |
| `src/lib/commands/transform/tier1/sentence-case.ts` | Update predicate |
| `src/lib/commands/transform/tier1/collapse-spaces.ts` | Update predicate |
| `src/lib/commands/transform/tier1/remove-accents.ts` | Update predicate |
| `src/lib/commands/transform/tier1/remove-non-printable.ts` | Update predicate |

### Recipe UX (Phase 2)
| File | Change |
|------|--------|
| `src/components/panels/RecipePanel.tsx` | Redesign with build-first flow, status indicators |
| `src/components/panels/RecipeStepBuilder.tsx` | NEW - Transform step builder UI |
| `src/lib/recipe/step-status.ts` | NEW - "Already Applied" detection |

### Discoverability (Phase 3)
| File | Change |
|------|--------|
| `src/components/panels/CleanPanel.tsx` | Add "Save as Recipe" shortcut |
| `src/components/layout/ActionToolbar.tsx` | Add recipe count badge |

---

## Verification Plan

### Manual Testing
1. **Idempotency:** Apply trim to column, apply trim again → second should show "0 rows affected" toast, no audit entry
2. **Recipe Builder:** Open Recipes panel → "Build New Recipe" → add steps → verify steps appear
3. **Already Applied:** Create recipe with trim step, apply to table manually, open recipe → step shows green "Applied" badge
4. **Discoverability:** Apply transforms → see "Save as recipe" link in Clean panel

### E2E Tests
Add to `e2e/tests/`:
- `recipe-idempotency.spec.ts` - Verify duplicate transforms don't create audit entries
- `recipe-builder.spec.ts` - Test build-from-scratch flow
- `recipe-status-indicators.spec.ts` - Test "Already Applied" badge accuracy

---

## Design Decisions

1. **SQL-level idempotency over metadata tracking** - Simpler, no storage overhead, leverages DuckDB's efficiency
2. **Build-first as primary flow** - Recipes are "statements of intent" (automation), not just history capture
3. **Audit = changes only** - Keeps audit log meaningful (compliance/debugging), reduces noise
4. **Visual status in recipes** - Green checkmark provides immediate feedback without running queries
5. **LIMIT 1 pre-check** - Avoids double-scanning large tables; UPDATE result is source of truth for affected count
6. **Structure-modifying commands invalidate all steps** - `remove_duplicates`, `filter_empty` etc. shift row context
7. **Multi-select audit import** - Users make mistakes (undo); don't blindly import everything

---

## Implementation Order

1. ✅ **base.ts** - Add `LIMIT 1` pre-check and early return for `affected: 0`
2. ✅ **tier1/*.ts** - Update 8 predicates to use `IS DISTINCT FROM`
3. ✅ **executor.ts** - Conditional snapshot/audit/timeline based on `affected > 0`
4. ✅ **RecipePanel.tsx** - Builder integration, status indicators
5. ✅ **RecipeStepBuilder.tsx** (new) - Transform step builder UI
6. ✅ **step-status.ts** (new) - "Already Applied" detection with structure-aware invalidation
7. ✅ **CleanPanel.tsx** - "Save as Recipe" shortcut
8. ✅ **ActionToolbar.tsx** - Recipe count badge

## Implementation Progress

### Phase 1: SQL Idempotency ✅ COMPLETE
- Updated all 8 Tier 1 command predicates to use `IS DISTINCT FROM`
- Added LIMIT 1 pre-check in `Tier1TransformCommand.execute()` for early return
- Modified executor to skip audit/timeline/snapshot when `affected === 0`
- Added orphaned snapshot cleanup for idempotent operations
- All 17 transformation E2E tests pass

### Phase 2: Recipe Builder UX ✅ COMPLETE
- RecipePanel.tsx has step builder integration with toggle button
- RecipeStepBuilder.tsx provides categorized transform selection
- step-status.ts detects "Already Applied" and "Modified Since" states
- Visual status indicators (green checkmark, amber warning) on recipe steps

### Phase 3: Recipe Discoverability ✅ COMPLETE
- CleanPanel.tsx shows "Save transforms as recipe" link when table has history
- ActionToolbar.tsx displays recipe count badge on Recipes button
