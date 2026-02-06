# Plan: Global Operation Status Indicator

## Problem
When users close side panels (Transform, Recipe, Combine), ongoing operations continue silently. Users lose visibility into background processing, get confused when edits are blocked, and don't know what's happening.

## Solution
Three additions:
1. **operationStore** — centralized Zustand store tracking all active operations
2. **OperationIndicator** — StatusBar component (bottom-right) showing active operations, clickable to reopen the source panel
3. **GridOperationBanner** — inline banner above the data grid when edits are paused

## Design Decisions (User-Confirmed)
- Allow panel close freely (no blocking/warning)
- StatusBar indicator (bottom-right, currently empty)
- Inline banner on grid for edit-blocked state
- Clickable indicator reopens the originating panel

---

## New Files

### 1. `src/stores/operationStore.ts`

Thin Zustand store. No dependencies on DuckDB/commands/panels (Level 3).

```typescript
type OperationSource = 'clean' | 'recipe' | 'combine' | 'match' | 'standardize'

interface ActiveOperation {
  id: string
  source: OperationSource
  label: string           // "Applying trim to 'email'" or "Recipe: Clean Emails (3/7 steps)"
  progress: number        // 0-100, or -1 for indeterminate
  message: string         // Phase description
  startedAt: Date
}

// Actions:
registerOperation(source, label) → string (returns id)
updateProgress(id, progress, message?) → void
deregisterOperation(id) → void
hasActiveOperations() → boolean
getActiveOperations() → ActiveOperation[]
```

Uses `Map<string, ActiveOperation>` for O(1) lookup. `generateId()` from `src/lib/utils.ts:30` for IDs.

### 2. `src/components/common/OperationIndicator.tsx`

Subscribes to `useOperationStore`. Renders in StatusBar right slot.

- **0 operations**: return `null`
- **1 operation**: Spinner + truncated label + progress %. Entire element clickable → `setActivePanel(source)`
- **2+ operations**: Spinner + "N operations" with tooltip listing each

Visual style matches `PersistenceIndicator` (same `text-xs`, icon+text layout, amber color language). Uses shadcn `Tooltip`, `Badge`. Uses `Loader2` spinner from lucide.

### 3. `src/components/grid/GridOperationBanner.tsx`

Subscribes to `useOperationStore` + `useUIStore.transformingTables`.

Shows when active table has ongoing operations:
```
[spinner] Edits paused — Transform in progress          [View]
```

- Amber background (`bg-amber-500/10`), non-modal, doesn't block scrolling
- "View" button reopens the source panel via `setActivePanel()`
- Renders between `</CardHeader>` and `<CardContent>` in App.tsx (line 425-426)

---

## Modified Files

### 4. `src/components/layout/StatusBar.tsx` (line 29)

Replace empty right-side placeholder:
```tsx
// Before:
<div className="flex items-center gap-2" />

// After:
<div className="flex items-center gap-2">
  <OperationIndicator />
</div>
```

### 5. `src/App.tsx` (between lines 425-426)

Insert banner between CardHeader and CardContent:
```tsx
</CardHeader>
<GridOperationBanner tableId={activeTable.id} />
<CardContent ...>
```

### 6. `src/components/panels/CleanPanel.tsx`

**`executeTransformation()` (~line 229-298):**
- Before `setIsApplying(true)`: call `registerOperation('clean', label)`
- In `onProgress` callback (~line 254): also call `updateProgress(opId, ...)`
- In `finally` block (~line 294): call `deregisterOperation(opId)`

**`handleFormulaApply()` (~line 449-501):**
- Same pattern: register → update → deregister

### 7. `src/components/clean/PrivacySubPanel.tsx`

**`handleApply()` (~line 219-289):**
- Before `setIsProcessing(true)` (line 230): `registerOperation('clean', label)`
- In `finally` blocks (lines 248, 289): `deregisterOperation(opId)`

### 8. `src/hooks/useRecipeExecution.tsx`

**`doExecute()` (~line 116-139):**
- Before `setIsProcessing(true)` (line 119): `registerOperation('recipe', label)`
- In progress callback (line 124): `updateProgress(opId, pct, stepLabel)`
- In `finally` block (line 134): `deregisterOperation(opId)`

### 9. `src/components/panels/CombinePanel.tsx`

**`handleStack()` (~line 126-217):**
- Before `setIsProcessing(true)` (line 133): `registerOperation('combine', label)`
- In `finally` (line 214): `deregisterOperation(opId)`
- Also deregister on early return (user cancel, line 149)

**`handleJoin()` (~line 255-338):**
- Before `setIsProcessing(true)` (line 258): `registerOperation('combine', label)`
- In `finally` (line 336): `deregisterOperation(opId)`
- Also deregister on early return (user cancel, line 276)

**`handleAutoClean()` (~line 236-253):**
- Register/deregister around `setIsProcessing(true/false)`

---

## Edit Safety During Transforms

The existing system already handles concurrent edits safely:

- **Cell edits are QUEUED, not dropped.** `editBatchStore` defers flush when `isTableTransforming(tableId)` is true (`editBatchStore.ts:125-129`). Edits stay in the batch buffer.
- **Deferred edits flush after transform completes.** The executor releases the lock (`executor.ts:862`) then calls `flushIfSafe(tableId)` (`executor.ts:870`) to flush accumulated edits.
- **Structural changes (row/column add/delete) are risky.** These go through the command executor but could corrupt data if interleaved with a running transform. The `GridOperationBanner` prevents this by communicating the table is busy.

No changes needed to the edit/transform locking system — it's already safe. The banner is purely UX communication.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Operation completes after panel closed | `finally` block calls `deregisterOperation()` → indicator disappears. Toast still fires. |
| Operation fails after panel closed | Same as above. Error toast still fires. |
| Multiple simultaneous operations | Map supports N operations. Indicator shows count badge + tooltip. |
| Component unmount during operation | Closure captures `opId` — `deregisterOperation` in `finally` still works. |
| User cancels confirmation dialog | Early return also calls `deregisterOperation`. |
| Page refresh mid-operation | Store is ephemeral — clean slate on refresh. |
| User edits cells during transform | Edits queued in `editBatchStore`, flushed automatically after transform completes. Safe. |
| User tries row/column insert/delete during transform | `GridOperationBanner` communicates table is busy. Commands execute sequentially so the structural change would queue behind the transform. |

---

## Implementation Order

1. `operationStore.ts` — no dependencies, can verify in isolation
2. `OperationIndicator.tsx` + wire into `StatusBar.tsx`
3. `GridOperationBanner.tsx` + wire into `App.tsx`
4. Integrate `CleanPanel.tsx` (primary use case)
5. Integrate `useRecipeExecution.tsx`
6. Integrate `CombinePanel.tsx`
7. Integrate `PrivacySubPanel.tsx`

---

## Verification

1. **Dev server**: `npm run dev`
2. **Transform test**: Open Transform panel → apply a transform on large dataset → close panel before completion → verify StatusBar shows spinner + label → verify GridOperationBanner appears → click indicator to reopen panel → wait for completion → verify both disappear
3. **Recipe test**: Same flow with Recipe panel (multi-step recipe on 100k+ rows)
4. **Combine test**: Same flow with Stack/Join operation
5. **Multiple operations**: Apply recipe to Table A, then start transform on Table B → verify indicator shows count
6. **Build check**: `npm run build` (TypeScript + production build)
7. **Lint check**: `npm run lint`
