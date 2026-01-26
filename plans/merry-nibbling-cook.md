# Plan: Complete Confirmation Dialog Integration for Branching History

## Problem Summary

Commit ce2837a ("feat: branching history support with confirmation dialog (Phase 8)") only integrated the confirmation dialog into `CleanPanel.tsx`. The dialog should appear when a user performs a new action while having undone operations that would be permanently discarded, but **5 other command execution points bypass the confirmation hook entirely**.

## Root Cause

The `useExecuteWithConfirmation` hook and `ConfirmDiscardDialog` component exist but aren't used in:

| File | Function | Line | Current Code |
|------|----------|------|--------------|
| `MatchView.tsx` | `handleApplyMerges` | ~278 | `executor.execute(command)` |
| `ScrubPanel.tsx` | `handleApply` | ~153 | `executor.execute(command)` (in loop) |
| `CombinePanel.tsx` | `handleStack` | ~114 | `executor.execute(command, { skipAudit: true })` |
| `CombinePanel.tsx` | `handleJoin` | ~236 | `executor.execute(command, { skipAudit: true })` |
| `StandardizeView.tsx` | `handleApply` | ~141 | `executor.execute(command)` |
| `DataGrid.tsx` | `onCellEdited` | ~424 | `executor.execute(command, { skipAudit: true })` |

## Solution

Integrate the `useExecuteWithConfirmation` hook into each component following the `CleanPanel.tsx` pattern:

### Pattern (from CleanPanel.tsx)

```tsx
// 1. Import
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'

// 2. Initialize hook
const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()

// 3. Replace executor.execute() with executeWithConfirmation()
const result = await executeWithConfirmation(command, tableId, options)

// 4. Handle user cancellation
if (!result) return  // User cancelled

// 5. Render dialog
<ConfirmDiscardDialog {...confirmDialogProps} />
```

## Files to Modify

### 1. `src/features/matcher/MatchView.tsx`

**Location:** `handleApplyMerges` callback (~line 264-318)

**Changes:**
- Import hook and dialog component
- Add `useExecuteWithConfirmation()` call
- Replace `executor.execute(command)` with `executeWithConfirmation(command, tableId)`
- Add early return if result is undefined
- Render `ConfirmDiscardDialog` in JSX

### 2. `src/components/panels/ScrubPanel.tsx`

**Location:** `handleApply` function (~line 98-192)

**Changes:**
- Import hook and dialog component
- Add `useExecuteWithConfirmation()` call
- **Special case:** Loop executes multiple commands. Check for future states ONCE before the loop, not per-command
- Replace `executor.execute(command)` with `executeWithConfirmation(command, tableId)`
- Add early return if user cancels first command
- Render `ConfirmDiscardDialog` in JSX

### 3. `src/components/panels/CombinePanel.tsx`

**Location:** `handleStack` (~line 96-182) and `handleJoin` (~line 220-298)

**Changes:**
- Import hook and dialog component
- Add `useExecuteWithConfirmation()` call
- Replace both `executor.execute(command, { skipAudit: true })` calls with `executeWithConfirmation(command, tableId, { skipAudit: true })`
- Add early returns if result is undefined
- Render `ConfirmDiscardDialog` in JSX

### 4. `src/features/standardizer/StandardizeView.tsx`

**Location:** `handleApply` callback (~line 113-177)

**Changes:**
- Import hook and dialog component
- Add `useExecuteWithConfirmation()` call
- Replace `executor.execute(command)` with `executeWithConfirmation(command, tableId)`
- Add early return if result is undefined
- Render `ConfirmDiscardDialog` in JSX

### 5. `src/components/grid/DataGrid.tsx`

**Location:** `onCellEdited` callback (~line 342-450)

**Changes:**
- Import hook and dialog component
- Add `useExecuteWithConfirmation()` call at component level
- Replace `executor.execute(command, { skipAudit: true })` with `executeWithConfirmation(command, tableId, { skipAudit: true })`
- Add early return if result is undefined
- Render `ConfirmDiscardDialog` at component level (dialog state managed by hook)

## Design Principle

The confirmation dialog should appear for **ANY** action that would discard undone operations, regardless of action type. This includes transformations, merges, scrubs, standardizations, cell edits, stack/join operations, etc.

## Implementation Order

1. **StandardizeView.tsx** - User-reported test case
2. **MatchView.tsx** - Matcher merges
3. **CombinePanel.tsx** - Two execution points (stack + join)
4. **ScrubPanel.tsx** - Loop case, needs confirmation before loop starts
5. **DataGrid.tsx** - Cell edits

## Verification

After each file modification:
1. Start dev server: `npm run dev`
2. Load a table and apply some transformations
3. Undo 1-2 operations (should show redo count in UI)
4. Perform new action via that panel/view
5. **Expected:** Confirmation dialog appears showing number of undone operations
6. **Cancel test:** Click Cancel - no action should occur, redo operations preserved
7. **Confirm test:** Click "Discard & Continue" - action executes, redo operations discarded

## Regression Testing

```bash
npm run test
```

Existing tests should pass. Consider adding E2E test for confirmation dialog behavior if time permits.
