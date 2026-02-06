# Plan: Matcher Review Workflow Overhaul

## Problem
The merge review workflow is confusing:
1. **Button labels mislead** — "Merge Selected" / "Keep Separate" sound like final actions, but they only stage items into the Reviewed tab
2. **No bulk revert** — in the Reviewed tab, users can only revert one pair at a time (undo icon per row)
3. **Apply destroys state** — after "Apply Merges", `reset()` clears ALL pairs and closes the panel, losing any remaining pending work
4. **No batch workflow** — users can't review/apply in batches; it's all-or-nothing

## Solution

### A. Tab-Aware Bottom Bar with Clearer Labels

**Pending tabs** (All / Definite / Maybe / Not Match) — when items selected:
```
[27 selected]                    [→ Review to Keep]  [→ Review to Merge]
```

**Reviewed tab** — when items selected:
```
[5 selected]                                         [↩ Revert to Pending]
```

**Any tab** — when nothing selected + reviewed items exist (unchanged layout, dynamic count):
```
[3 to merge · 2 kept · 25 remaining]                [✓ Apply 3 Merges]
```

### B. Batch-Mode Apply
After successful apply:
- Remove only finalized pairs (merged + kept_separate) from the list
- Keep all pending pairs intact
- If pending pairs remain → stay open, auto-switch to "All" tab if currently on "Reviewed"
- If no pending pairs remain → `reset()` + close (existing behavior)

### C. Tooltip Clarity on Per-Row Buttons
Update tooltips on individual row buttons:
- ✓ tooltip: "Merge (M)" → "Review as merge (M)"
- ✕ tooltip: "Keep Separate (K)" → "Review as keep (K)"

---

## Files to Modify

### 1. `src/stores/matcherStore.ts`
**Add 2 new actions to interface (~line 100):**
- `revertSelectedToPending: () => void` — bulk revert for Reviewed tab
- `removeReviewedPairs: () => void` — remove finalized pairs after apply

**Add implementations (after `revertPairToPending` at line 392):**

```typescript
revertSelectedToPending: () => {
  const { pairs, definiteThreshold, maybeThreshold, selectedIds } = get()
  const updatedPairs = pairs.map((p) =>
    selectedIds.has(p.id) ? { ...p, status: 'pending' as const } : p
  )
  set({
    pairs: updatedPairs,
    selectedIds: new Set(),
    stats: calculateStats(updatedPairs, definiteThreshold, maybeThreshold),
  })
},

removeReviewedPairs: () => {
  const { pairs, definiteThreshold, maybeThreshold } = get()
  const remainingPairs = pairs.filter((p) => p.status === 'pending')
  set({
    pairs: remainingPairs,
    selectedIds: new Set(),
    expandedId: null,
    stats: calculateStats(remainingPairs, definiteThreshold, maybeThreshold),
  })
},
```

### 2. `src/features/matcher/MatchView.tsx`

**a) Add imports (line 3):**
- Add `ArrowRight`, `Undo2` to lucide imports

**b) Destructure new store actions (line 73-115):**
- Add `revertSelectedToPending`, `removeReviewedPairs`

**c) Replace bottom bar (lines 722-771):**
Three conditional blocks based on tab + selection state:

1. `selectedIds.size > 0 && filter !== 'reviewed'` → "Review to Keep" / "Review to Merge"
2. `selectedIds.size > 0 && filter === 'reviewed'` → "Revert to Pending"
3. `hasReviewed && selectedIds.size === 0` → "Apply N Merges" (dynamic count)

**d) Modify `handleApplyMerges` success path (lines 408-413):**

Replace:
```typescript
reset()
onClose()
```

With:
```typescript
removeReviewedPairs()
saveAppStateNow()

const remaining = useMatcherStore.getState().pairs.length
if (remaining === 0) {
  reset()
  onClose()
} else {
  // If on Reviewed tab (now empty), switch to All
  if (filter === 'reviewed') {
    setFilter('all')
  }
}
```

**e) Update `handleApplyMerges` dependency array:**
- Add `removeReviewedPairs`, `setFilter`, `filter`
- Remove `reset`, `onClose` from deps (conditionally used now, still in scope)

### 3. `src/features/matcher/components/MatchRow.tsx`

**Update tooltips (lines 239, 248):**
- Line 239: `title="Merge (M)"` → `title="Review as merge (M)"`
- Line 248: `title="Keep Separate (K)"` → `title="Review as keep (K)"`

### No changes needed:
- `src/lib/commands/match/merge.ts` — already filters to `status === 'merged'` pairs
- `src/features/matcher/components/CategoryFilter.tsx` — tab logic unchanged
- `src/lib/persistence/state-persistence.ts` — fingerprint subscription auto-saves after pair removal

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Apply when all pairs are reviewed | `removeReviewedPairs()` empties array → `reset()` + `onClose()` (existing behavior) |
| Apply when pending pairs remain | Panel stays open, pending pairs shown, stats updated |
| On Reviewed tab after apply | Auto-switch to "All" tab (Reviewed is now empty) |
| New Search after partial apply | No reviewed items remain → skips confirmation, clears directly |
| Undo after partial apply | Data restored via Tier 3 snapshot; matcher state not synced (user runs new search) |
| Persistence after partial apply | Fingerprint changes → debounced save + explicit `saveAppStateNow()` |
| Empty fingerprint guard | `removeReviewedPairs()` may empty pairs → fingerprint = '' → guard prevents save; explicit `saveAppStateNow()` handles this |

---

## Verification

1. **Bulk staging**: Select items in Definite tab → click "Review to Merge" → items appear in Reviewed tab with "Merged" badge
2. **Bulk revert**: In Reviewed tab, select items → click "Revert to Pending" → items return to their original category
3. **Batch apply**: Review 5 of 30 pairs → Apply → 5 removed, 25 remain in panel
4. **Full apply**: Review all 30 → Apply → panel closes (existing behavior preserved)
5. **Persistence**: After partial apply, refresh page → remaining pending pairs restored
6. **Button labels**: Verify "Review to Merge" / "Review to Keep" appear in pending tabs, "Revert to Pending" in Reviewed tab
