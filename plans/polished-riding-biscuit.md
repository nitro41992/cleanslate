# Fix: Matcher merge data persists after "New Search" + refresh

## Root Cause

In `src/stores/matcherStore.ts:506-523`, the subscription that auto-saves matcher state skips persistence when `pairs` is cleared:

```typescript
useMatcherStore.subscribe((state) => {
  const fingerprint = computeDecisionFingerprint(state.pairs)
  if (fingerprint === prevDecisionFingerprint) return
  prevDecisionFingerprint = fingerprint

  if (fingerprint === '') return  // ← BUG: skips save when user clears pairs
  // ... debounced saveAppStateNow()
})
```

When `clearPairs()` sets `pairs = []`, the fingerprint becomes `''` and the save is skipped. So `app-state.json` retains the old `matcherState`. On refresh, the stale data is restored.

The guard exists to avoid saving empty state during initial page load — we can't remove it.

## Fix

**File: `src/features/matcher/MatchView.tsx`** (only file modified)

Add an explicit `saveAppStateNow()` call after `clearPairs()` in both New Search paths. This follows the existing pattern in `tableStore.ts` (lines 113-120, 147-156) where critical state mutations immediately trigger persistence.

### Change 1: `handleNewSearch()` else-branch (~line 431)

After `clearPairs()`, add:
```typescript
saveAppStateNow()
```

### Change 2: `handleConfirmDiscard()` (~line 437)

After `clearPairs()`, add:
```typescript
saveAppStateNow()
```

### Import

Add `saveAppStateNow` to the imports at the top of the file:
```typescript
import { saveAppStateNow } from '@/lib/persistence/state-persistence'
```

### Why not fix `handleApply` too?

After a successful merge, `reset()` also clears pairs. But the merge modifies table data → bumps `dataVersion` → triggers persistence through the normal table save path, which serializes `matcherState: null` (since pairs is empty). So the apply path is already self-healing.

## Verification

1. Upload CSV, open matcher, run duplicate search, mark some pairs as merged/kept
2. Click "New Search" → confirm discard
3. Refresh the page
4. Verify matcher panel does not show stale merge decisions
5. Also test: run search with no decisions made → click "New Search" → refresh → verify clean state
