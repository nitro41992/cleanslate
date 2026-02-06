# Fuzzy Matcher UX Improvements

## Summary
7 improvements to the Matcher panel, organized into 3 phases by complexity.

---

## Phase 1: Quick Wins (3 items)

### 1.1 Fix histogram re-bucketing bug (#6)
**Problem:** Dragging the threshold slider updates tab counts but cards don't re-filter until you click away and back.

**Root cause:** `filteredPairs` useMemo depends on `classifyPair` (a stable Zustand function ref) but NOT on `definiteThreshold`/`maybeThreshold`. Thresholds change, stats recalculate, but the useMemo never re-triggers.

**Fix in `MatchView.tsx` (~10 lines):**
- Subscribe to `definiteThreshold` and `maybeThreshold` from the store
- Add them to the `filteredPairs` useMemo dependency array
- Inline the classification logic instead of calling `classifyPair`

**Performance:** The filtering is O(n) simple numeric comparisons — negligible even for thousands of pairs. The virtualizer only renders ~15 visible items regardless of list size, keeping reconciliation cheap. To guarantee the slider stays smooth during rapid dragging, wrap the list update in `React.startTransition`:

```tsx
// Threshold state used for low-priority list updates
const [deferredThresholds, setDeferredThresholds] = useState({ definiteThreshold, maybeThreshold })

// Update deferred thresholds via startTransition on every slider tick
useEffect(() => {
  startTransition(() => {
    setDeferredThresholds({ definiteThreshold, maybeThreshold })
  })
}, [definiteThreshold, maybeThreshold])

const filteredPairs = useMemo(() => {
  const { definiteThreshold: dt, maybeThreshold: mt } = deferredThresholds
  return pairs.filter((pair) => {
    if (filter === 'reviewed') return pair.status !== 'pending'
    if (pair.status !== 'pending') return false
    if (filter === 'all') return true
    const cl = pair.similarity >= dt ? 'definite'
             : pair.similarity >= mt ? 'maybe' : 'not_match'
    return cl === filter
  })
}, [pairs, filter, deferredThresholds])
```

This keeps the slider buttery smooth (high priority) while the card list catches up as a low-priority transition. In practice both update on the same frame for typical pair counts.

### 1.2 Fix bottom bar counter confusion (#1)
**Problem:** Clicking "Keep Separate" shows bottom bar saying "Ready to apply 0 merges" — confusing because the action is acknowledged only in the header.

**Fix in `MatchView.tsx` lines 665-677 (~15 lines):**
- Replace single merge count with a progress summary:
  `"3 to merge · 1 kept · 29 remaining"`
- Disable "Apply Merges" button when `stats.merged === 0`
- Use muted style when no merges queued (instead of green background)

### 1.3 Replace ADYMNK with keyboard shortcut tooltip (#2)
**Problem:** `A D Y N M K` on the header row is cryptic. User didn't know what it meant.

**Fix in `MatchView.tsx` lines 578-579 (~15 lines):**
- Replace text with a small `<Keyboard>` icon wrapped in a Tooltip
- Tooltip content shows the full shortcut legend:
  ```
  A = All  D = Definite  Y = Maybe
  N = Not Match  M = Merge  K = Keep
  ```
- `TooltipProvider` already wraps the app from `AppLayout.tsx`

---

## Phase 2: Medium Scope (3 items)

### 2.1 Keep indicator on collapsed cards (#7)
**Problem:** Can't tell which record will be kept without expanding the card.

**Fix in `MatchRow.tsx` (~25 lines):**
- **Keep name:** full brightness `font-medium text-foreground`
- **Remove name:** dimmed `text-muted-foreground/60`
- Replace static "vs" with a clickable `<ArrowLeftRight>` swap icon (already imported)
  - `onClick` calls `onSwapKeepRow()` with `e.stopPropagation()` to avoid expanding
  - Small hover effect: `hover:bg-muted rounded p-0.5`

### 2.2 Collapsible left sidebar (#4)
**Problem:** Config sidebar (320px) is always visible, wastes space after setup.

**Fix in `MatchView.tsx` (~50 lines):**
- Add local state: `const [configCollapsed, setConfigCollapsed] = useState(false)`
- Sidebar width: `w-80` when open, `w-12` when collapsed, with `transition-all duration-200`
- Collapse toggle: circular button on the sidebar border edge (`translate-x-1/2`)
  - Uses `ChevronsLeft` / `ChevronsRight` icons
- Collapsed state shows a single icon button to re-expand
- **Auto-collapse** after "Find Duplicates" completes (reclaim space for results)
- **Auto-expand** when "New Search" is clicked

### 2.3 Undo keep/merge decisions (#3)
**Problem:** No way to undo individual decisions. "New Search" discards ALL.

**Changes across 4 files (~80 lines):**

**a) `matcherStore.ts`:**
- Add `revertPairToPending(pairId)` action — sets pair status back to `'pending'`
- Extend `MatchFilter` type to include `'reviewed'`

**b) `CategoryFilter.tsx`:**
- Add a "Reviewed" tab showing count of `stats.merged + stats.keptSeparate`
- Tab appears after `All | Definite | Maybe | Not Match` with a divider

**c) `MatchView.tsx`:**
- Update `filteredPairs` to handle `filter === 'reviewed'` (show non-pending pairs)
- Pass `reviewed` count to CategoryFilter
- Wire `revertPairToPending` through to MatchRow

**d) `MatchRow.tsx`:**
- Add `onRevertToPending` prop
- When `pair.status !== 'pending'`: replace Merge/Keep buttons with:
  - A status badge ("Merged" in green, "Kept" in gray)
  - An undo button (`Undo2` icon) that calls `onRevertToPending`

---

## Phase 3: Large Scope (1 item)

### 3.1 Merge queue persistence across refresh (#5)
**Problem:** All match decisions lost on page refresh.

**Scope:** Current table only (single set of results). Switching tables still clears.

**Changes across 4-5 files (~150 lines):**

**a) `types/index.ts`:**
- Add `SerializedMatcherState` interface (tableId, tableName, matchColumn, blockingStrategy, thresholds, pairs, tableRowCount, savedAt)

**b) `state-persistence.ts`:**
- Bump schema to V5, add `matcherState: SerializedMatcherState | null`
- V4 -> V5 migration: set `matcherState: null`
- Update `saveAppState` to include matcher state (read lazily from matcherStore if not provided)
- Update `restoreAppState` to return matcher state

**c) `matcherStore.ts`:**
- Add `restoreFromPersisted(state)` action
- Add `getSerializedState()` getter for serialization
- Add save subscription (2s debounce) that piggybacks on existing `saveAppState` pattern

**d) `usePersistence.ts` or `useDuckDB.ts`:**
- On restoration flow: if `matcherState` exists in saved state, call `restoreFromPersisted`

**e) `MatchView.tsx`:**
- Staleness detection: if stored `tableRowCount !== current rowCount`, show warning toast suggesting user re-run the search

---

## Files Modified

| File | Phase | Changes |
|------|-------|---------|
| `src/features/matcher/MatchView.tsx` | 1,2,3 | Re-bucketing fix, bottom bar, tooltip, sidebar collapse, reviewed filter, staleness |
| `src/features/matcher/components/MatchRow.tsx` | 2 | Keep indicator, reviewed state + undo button |
| `src/stores/matcherStore.ts` | 2,3 | `revertPairToPending`, reviewed filter, persistence actions |
| `src/features/matcher/components/CategoryFilter.tsx` | 2 | Reviewed tab |
| `src/lib/persistence/state-persistence.ts` | 3 | V5 schema, matcher save/restore |
| `src/types/index.ts` | 3 | `SerializedMatcherState` interface |

## Verification

1. **Bug fix (#6):** Drag threshold slider while on "Maybe" tab — cards should appear/disappear in real-time
2. **Bottom bar (#1):** Click "Keep Separate" on a card — bottom bar should show "0 to merge · 1 kept · N remaining"
3. **Tooltip (#2):** Hover keyboard icon — should show full shortcut legend
4. **Keep indicator (#7):** Collapsed cards show one name bright, one dimmed. Click swap icon — they swap
5. **Sidebar (#4):** After "Find Duplicates", sidebar auto-collapses. Click edge button to expand. "New Search" auto-expands
6. **Undo (#3):** Click "Keep" on a card, switch to "Reviewed" tab, see the card with "Kept" badge and undo button. Click undo — card returns to its similarity tab
7. **Persistence (#5):** Mark some pairs as merged/kept, refresh page, reopen matcher — decisions restored. If table was modified, see staleness warning
