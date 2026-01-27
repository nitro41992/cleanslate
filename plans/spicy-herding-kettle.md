# Plan: Dirty/Unsaved Changes Indicator

## Problem Statement
1. Users have no way of knowing if data persisted after making a change - refreshing too quickly loses transforms but keeps audit entries (out of sync)
2. No visual indicator that autosave is in progress or complete

## Root Cause Analysis

**Current persistence timing:**
```
T+0ms     Command executes in DuckDB memory, audit recorded
T+0-2000ms  UI shows "Ready" but data NOT persisted (BLIND SPOT)
T+2000ms   usePersistence triggers Parquet export (2s debounce)
T+1000ms   flushDuckDB CHECKPOINT starts, status → 'saving'
T+3000ms   Status → 'saved', then auto-reset to 'idle' after 3s
```

The 2-second window between command execution and persistence start has no indicator.

## Solution: Add "Dirty" State

### State Machine
```
idle ──(change)──> dirty ──(save starts)──> saving ──(complete)──> saved ──(3s)──> idle
                                                │
                                                └──(error)──> error
```

## Implementation

### 1. Update PersistenceStatus Type
**File:** `src/types/index.ts`

```typescript
// Before
export type PersistenceStatus = 'idle' | 'saving' | 'saved' | 'error'

// After
export type PersistenceStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
```

### 2. Add Dirty Tracking to uiStore
**File:** `src/stores/uiStore.ts`

Add:
- `dirtyTableIds: Set<string>` - tracks which tables have unsaved changes
- `markTableDirty(tableId: string)` - called immediately when change occurs
- `markTableClean(tableId: string)` - called when Parquet export completes
- Derive `persistenceStatus` from dirty state (if any table dirty → status is 'dirty')

### 3. Set Dirty State at Command Start
**File:** `src/lib/commands/executor.ts`

At the START of `execute()`, before any async operations:
```typescript
// Immediately mark table as dirty (before debounced persistence)
useUIStore.getState().markTableDirty(tableId)
```

### 4. Clear Dirty State After Parquet Export
**File:** `src/hooks/usePersistence.ts`

After `exportTableToParquet()` succeeds:
```typescript
// Mark table clean after successful Parquet export
const table = useTableStore.getState().tables.find(t => t.name === name)
if (table) useUIStore.getState().markTableClean(table.id)
```

### 5. Update UI Indicator
**File:** `src/components/layout/AppShell.tsx` (lines 333-343)

Replace current status display with enhanced version:
- **dirty**: Amber pulsing dot + "Unsaved changes"
- **saving**: Spinner + "Saving..."
- **saved**: Green check + "Saved just now" (with relative timestamp)
- **error**: Red X + "Save failed"
- **idle**: HardDrive icon + "Ready"

### 6. Enhance beforeunload Warning
**File:** `src/hooks/useBeforeUnload.ts`

Show browser warning when `persistenceStatus === 'dirty' || 'saving'`:
```typescript
if (persistenceStatus === 'dirty' || persistenceStatus === 'saving') {
  event.preventDefault()
  event.returnValue = '' // Triggers browser's "Leave site?" dialog
}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/types/index.ts` | Add 'dirty' to PersistenceStatus |
| `src/stores/uiStore.ts` | Add dirtyTableIds, markTableDirty/Clean |
| `src/lib/commands/executor.ts` | Set dirty at command start |
| `src/hooks/usePersistence.ts` | Clear dirty after Parquet export |
| `src/components/layout/AppShell.tsx` | Update status indicator UI |
| `src/hooks/useBeforeUnload.ts` | Add warning dialog when dirty |

## Verification

1. Make an edit → immediately see "Unsaved changes" (amber indicator)
2. Wait 2-3 seconds → see "Saving..." then "Saved just now"
3. Refresh immediately after edit → see browser warning dialog
4. After "Saved" shows → refresh works without warning
5. Audit log entries match actual table data after refresh

## Design Decisions
- **beforeunload warning**: Yes - show browser dialog when dirty/saving
- **Indicator location**: Sidebar footer only (current location)

## Out of Scope (Future Enhancements)
- Per-table dirty dots in sidebar
- Header-level save indicator (more prominent than sidebar)
- Sync verification on hydration (detect audit/data mismatch)
