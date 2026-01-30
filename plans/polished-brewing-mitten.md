# Global Transformation Progress Indicator

## Problem

When users apply transformations to large datasets (e.g., 1M+ rows), the progress indicator is only visible while the Clean side panel is open. If the user closes the panel during processing, they lose visibility into progress.

## Solution: Auto-Close Panel + StatusBar Indicator + Global Mutex

### Key Design Decisions

1. **Auto-close panel on transform start** - Clean panel closes automatically when a transformation begins, leaving the StatusBar indicator as the sole progress view.

2. **One transformation at a time (Global Mutex)** - Only one transformation can run across ALL modules: Clean, Standardize, Match, Combine, and Scrub. This prevents data races and simplifies UX.

3. **StatusBar indicator** - Shows progress after panel closes, consistent with existing PersistenceIndicator pattern.

## Architecture

```
User clicks "Apply" in any panel
       │
       ▼
Check: uiStore.transformProgress !== null?
       │
       ├─YES─► Show toast: "Transformation already in progress"
       │
       └─NO──► Close panel → Execute command → StatusBar shows progress
                                │
                                ▼
                  TransformationProgressIndicator (StatusBar)
                                │
                                ▼
                  On complete: Clear after 1.5s delay
```

## Implementation

### 1. Add Transform Progress State to uiStore

**File:** `src/stores/uiStore.ts`

Add interface (~line 37):
```typescript
export interface TransformProgress {
  tableId: string
  tableName: string
  commandLabel: string      // "Standardize Date"
  commandType: string       // "transform:standardize_date"
  phase: 'validating' | 'snapshotting' | 'executing' | 'auditing' | 'diffing' | 'complete'
  progress: number          // 0-100
  message: string           // "Processing 450,000 / 1,000,000 rows"
  startTime: number         // Date.now()
}
```

Add to UIState interface (~line 60):
```typescript
transformProgress: TransformProgress | null
```

Add actions to UIActions (~line 115):
```typescript
setTransformProgress: (progress: TransformProgress | null) => void
isTransformRunning: () => boolean  // Convenience getter for mutex check
```

Add implementation (~line 330):
```typescript
transformProgress: null,

setTransformProgress: (progress) => {
  set({ transformProgress: progress })
},

isTransformRunning: () => {
  return get().transformProgress !== null
},
```

### 2. Create TransformationProgressIndicator Component

**File:** `src/components/common/TransformationProgressIndicator.tsx` (NEW)

- Shows spinner + command label + percentage + mini progress bar
- Tooltip shows: table name, phase, elapsed time, full message
- Styled consistently with PersistenceIndicator (amber for in-progress, green for complete)
- Auto-hides when `transformProgress` is null

### 3. Add to StatusBar

**File:** `src/components/layout/StatusBar.tsx`

```tsx
{/* Center: Status indicators */}
<div className="flex items-center gap-3">
  <TransformationProgressIndicator />
  <PersistenceIndicator />
</div>
```

### 4. Wire Executor to Update Global Progress

**File:** `src/lib/commands/executor.ts`

In `CommandExecutor.execute()`, update the `progress()` helper function (~line 160):

```typescript
const executionStartTime = Date.now()

const progress = (
  phase: ExecutorProgress['phase'],
  pct: number,
  message: string
) => {
  // Existing: local callback for CleanPanel
  onProgress?.({ phase, progress: pct, message })

  // NEW: Update global store for StatusBar indicator
  useUIStore.getState().setTransformProgress({
    tableId,
    tableName: table?.name || 'Unknown',
    commandLabel: command.label,
    commandType: command.type,
    phase,
    progress: pct,
    message,
    startTime: executionStartTime,
  })
}
```

### 5. Clear Progress on Completion/Error

**File:** `src/lib/commands/executor.ts`

On success path (~line 676):
```typescript
progress('complete', 100, 'Complete')
setTimeout(() => {
  useUIStore.getState().setTransformProgress(null)
}, 1500)  // Brief "complete" display before clearing
```

On error path (~line 692):
```typescript
useUIStore.getState().setTransformProgress(null)
```

### 6. Centralized Mutex + Auto-Close in useExecuteWithConfirmation Hook

**File:** `src/hooks/useExecuteWithConfirmation.ts`

This is the central point where all panels execute commands. Add mutex check and `onStart` callback here.

**Update ExecuteOptions type** (in `src/lib/commands/types.ts`):
```typescript
export interface ExecuteOptions {
  onProgress?: (progress: ExecutorProgress) => void
  skipAudit?: boolean
  onStart?: () => void  // NEW: Called when execution actually begins (after confirmation)
}
```

**In executeWithConfirmation (~line 90):**
```typescript
const executeWithConfirmation = useCallback(
  (command: Command, tableId: string, options?: ExecuteOptions): Promise<ExecutorResult | undefined> => {
    return new Promise((resolve) => {
      // MUTEX CHECK: Prevent concurrent transformations
      if (useUIStore.getState().isTransformRunning()) {
        toast.error('Transformation in progress', {
          description: 'Please wait for the current operation to complete.'
        })
        resolve(undefined)
        return
      }

      const executor = getCommandExecutor()
      const count = executor.getFutureStatesCount(tableId)

      // If no future states, call onStart and execute immediately
      if (count === 0) {
        options?.onStart?.()  // Close panel before execution
        executor.execute(command, options).then(resolve)
        return
      }

      // Store pending execution and show dialog
      pendingRef.current = { command, options, resolve }
      setFutureCount(count)
      setDialogOpen(true)
    })
  },
  []
)
```

**In handleConfirm (~line 110):**
```typescript
const handleConfirm = useCallback(() => {
  const pending = pendingRef.current
  if (pending) {
    const executor = getCommandExecutor()
    isIntentionalCloseRef.current = true
    pendingRef.current = null
    setDialogOpen(false)

    // Call onStart AFTER dialog closes, BEFORE execution
    pending.options?.onStart?.()

    executor
      .execute(pending.command, pending.options)
      .then(pending.resolve)
      // ...
  }
}, [])
```

### 7. Update Panels to Pass onStart Callback

Each panel passes `onStart` to close itself when execution begins.

**CleanPanel.tsx (~line 178):**
```typescript
const result = await executeWithConfirmation(command, activeTable.id, {
  onStart: () => setActivePanel(null),  // Close panel
})
```

**StandardizeView.tsx (~line 145):**
```typescript
const result = await executeWithConfirmation(command, tableId, {
  onStart: () => onClose(),  // Close overlay
})
```

**MatchView.tsx (~line 283):**
```typescript
const result = await executeWithConfirmation(command, tableId, {
  onStart: () => onClose(),  // Close overlay
})
```

**CombinePanel.tsx (~line 118, 245):**
```typescript
const result = await executeWithConfirmation(command, tableA.id, {
  skipAudit: true,
  onStart: () => setActivePanel(null),  // Close panel
})
```

**ScrubPanel.tsx (~line 165):**
```typescript
// First rule uses confirmation hook
const result = await executeWithConfirmation(command, tableId, {
  onStart: () => setActivePanel(null),  // Close panel on first command
})
```

## Files Changed

| File | Change |
|------|--------|
| `src/stores/uiStore.ts` | Add `TransformProgress` interface, state, actions |
| `src/lib/commands/types.ts` | Add `onStart` to `ExecuteOptions` |
| `src/hooks/useExecuteWithConfirmation.ts` | Add mutex check + call `onStart` callback |
| `src/components/common/TransformationProgressIndicator.tsx` | **NEW** - StatusBar component |
| `src/components/layout/StatusBar.tsx` | Import and add indicator |
| `src/lib/commands/executor.ts` | Wire progress to global store |
| `src/components/panels/CleanPanel.tsx` | Pass `onStart` callback to close panel |
| `src/features/standardizer/StandardizeView.tsx` | Pass `onStart` callback to close overlay |
| `src/features/matcher/MatchView.tsx` | Pass `onStart` callback to close overlay |
| `src/components/panels/CombinePanel.tsx` | Pass `onStart` callback to close panel |
| `src/components/panels/ScrubPanel.tsx` | Pass `onStart` callback to close panel |

## Test Plan

### Basic Flow
1. Upload large CSV (1M+ rows)
2. Open Clean panel, apply a Tier 3 transform (e.g., standardize_date)
3. Verify: Clean panel closes automatically when execution starts
4. Verify: StatusBar shows progress: `[spinner] Standardize Date 45% [===---]`
5. Hover over indicator → tooltip shows table name, phase, elapsed time
6. Wait for completion → indicator shows "Complete ✓" briefly, then clears

### Mutex Test (Cross-Panel)
7. Start a transform from Clean panel (auto-closes)
8. While running, open Standardize panel and try to apply → should show "Transformation in progress" toast
9. While running, open Match panel and try to merge → should show toast
10. While running, open Combine panel and try to stack → should show toast
11. After transform completes (indicator clears), try again → should work

### Error Handling
12. Trigger an error during transform (e.g., invalid column)
13. Verify: indicator clears immediately, mutex unlocks
14. Verify: subsequent transforms can proceed

### ScrubPanel Multi-Command
15. Configure 3 scrub rules, apply all
16. Verify: panel closes on first rule execution
17. Verify: progress shows for each rule in sequence
18. Verify: indicator clears after all rules complete

## Verification

```bash
npm run dev
# Test scenarios above with large dataset
```

---

# Issue 2: Redundant Save Bug

## Problem

After a transform completes, the same table is being saved to Parquet TWICE:

```
[Persistence] Saving Raw_Data_HF_V6...
... 5 chunks exported ...
[Persistence] Raw_Data_HF_V6 saved
[Persistence] Raw_Data_HF_V6 has pending changes, re-saving...  <-- BUG
[Persistence] Saving Raw_Data_HF_V6...
... 5 chunks exported again ...
```

This wastes time and resources, especially for large tables (1M+ rows = ~27MB Parquet export twice).

## Root Cause

In `usePersistence.ts`, the subscription callback can fire multiple times in quick succession:

1. Transform completes → `requestPrioritySave()` called → subscription fires (call A)
2. Call A: finds priority save flag, triggers `executeSave()` with "Priority save" reason
3. Call A: **clears priority flag BEFORE save completes** (lines 985-987)
4. While save is in progress, another state change triggers subscription (call B)
5. Call B: priority flag is now CLEARED, falls through to debounced save path
6. Call B: schedules/triggers `executeSave()` with "Debounced save" for same table
7. `saveTable()` sees `saveInProgress.has(tableName) = true`, sets `pendingSave`
8. First save completes → checks `pendingSave` → triggers redundant second save

Result: **3 full Parquet exports per transform** (timeline snapshot + 2x table save) instead of 2.

## Fix

**File:** `src/hooks/usePersistence.ts`

### Solution: Skip tables currently being saved in subscription

The cleanest fix is to check `saveInProgress` in the subscription callback BEFORE adding to `tablesToSave`. This prevents the same table from being scheduled for save while already saving.

**In subscription callback (around line 930):**

```typescript
// Add check: skip tables currently being saved
if (saveInProgress.has(table.name)) {
  // Table is already being saved - skip to avoid duplicate save
  // Update tracking so we don't re-trigger on next subscription call
  knownTableIds.add(table.id)
  lastDataVersions.set(table.id, currentVersion)
  continue
}

if (isNewTable || hasDataChanged) {
  tablesToSave.push({ id: table.id, name: table.name, rowCount: table.rowCount })
  knownTableIds.add(table.id)
  lastDataVersions.set(table.id, currentVersion)
  // ...
}
```

This is simpler and more direct than:
- ~~Tracking dataVersion at save start~~ (complex, still has races)
- ~~Delaying priority flag clear~~ (changes existing behavior)

## Files Changed (Issue 2)

| File | Change |
|------|--------|
| `src/hooks/usePersistence.ts` | Track dataVersion to prevent redundant saves |

## Test Plan (Issue 2)

1. Upload large CSV (1M+ rows)
2. Apply a Tier 3 transform
3. Watch console - should see ONLY ONE save cycle
4. Verify no "[Persistence] ... has pending changes, re-saving..." message
5. Verify data is correctly persisted (refresh page, check data)
