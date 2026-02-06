# Smart Replace — Unique Tab Visual Refinement

## Goal
Refine the Smart Replace "Unique" tab: remove dated check icon, elevate the edit popover, rename tabs, and polish card styling. Pure visual changes — no structural/behavioral modifications.

## Files to Modify

| File | Change |
|------|--------|
| `src/features/standardizer/components/ClusterCard.tsx` | Rework `UniqueValueCard`: remove check/checkbox, add left-border status, elevate popover, refine text + row count styling |
| `src/features/standardizer/components/ClusterList.tsx` | Rename tab labels from "Unique"/"Actionable" to "Distinct"/"Clusters" |

No new files. No dependency changes. No store/type changes.

## Changes

### 1. Rename Tabs (ClusterList.tsx)

**Lines 111, 124** — Change visible label text only. `data-testid` and `ClusterFilter` type stay unchanged.

```
"Unique ({uniqueCount})"      →  "Distinct ({uniqueCount})"
"Actionable ({actionableCount})" →  "Clusters ({actionableCount})"
```

- "Distinct" maps to the SQL concept data workers know (`SELECT DISTINCT`). These are already-clean single values.
- "Clusters" accurately describes grouped variants. Neutral and descriptive vs the vague "Actionable."

Also update the keyboard shortcut comment in `StandardizeView.tsx` (line 120-125) — the comment references the old names.

### 2. Remove Check Icon / Checkbox from UniqueValueCard (ClusterCard.tsx)

**Lines 267-278** — Delete the entire status indicator block (the `{hasReplacement ? <Checkbox> : <div><Check></div>}` conditional).

Replace card status signaling with a **left border accent**:

```tsx
// Card container — replace current className logic
<div
  className={cn(
    'rounded-lg overflow-hidden transition-all duration-200',
    hasReplacement
      ? 'bg-primary/5 border border-primary/20 border-l-2 border-l-primary'
      : 'bg-transparent border border-border/40 hover:border-border',
  )}
>
  <div className="px-3 py-2 flex items-center gap-2.5">
    {/* No status icon — left border IS the status */}
    ...
  </div>
</div>
```

- **No replacement:** Transparent bg, subtle border. Just a value in the list.
- **Has replacement:** Tinted bg + 2px left border in primary blue. Clear visual change without dated iconography.

Remove `Check` and `Checkbox` from imports if no longer used in this component (they're still used in `ClusterValueRow` for Checkbox, so keep Checkbox; remove Check).

### 3. Elevate Edit Popover (ClusterCard.tsx)

**Line 319** — Upgrade `PopoverContent` styling:

```tsx
// Before
<PopoverContent className="w-64 p-3" align="start">

// After
<PopoverContent
  className="w-72 p-4 shadow-lg shadow-primary/5 ring-1 ring-primary/20"
  align="start"
  sideOffset={8}
>
```

Changes:
- `w-64` → `w-72` — more breathing room
- `p-3` → `p-4` — more internal padding
- `shadow-lg shadow-primary/5` — deeper shadow with subtle blue tint for separation
- `ring-1 ring-primary/20` — subtle blue ring to visually lift from background cards
- `sideOffset={8}` — more gap from trigger element

**Lines 320-351** — Refine popover interior:

- Label: Change from plain `<label>` to centered divider style:
  ```tsx
  <div className="flex items-center gap-2">
    <div className="h-px flex-1 bg-border" />
    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
      Replace with
    </span>
    <div className="h-px flex-1 bg-border" />
  </div>
  ```
- Input: Add `bg-background` for depth against popover surface, increase to `h-9`
- Cancel button: `variant="outline"` → `variant="ghost"` with `text-muted-foreground` — de-emphasize cancel
- Buttons: `h-7` → `h-8` for better touch targets
- `space-y-2` → `space-y-3` for more internal spacing

### 4. Value Text Hierarchy (ClusterCard.tsx)

**Lines 307-315** (no-replacement state):

```tsx
// Before
<span className="text-sm text-muted-foreground truncate">
// After
<span className="text-sm text-foreground/80 truncate group-hover:text-foreground transition-colors">
```

Values are data — they should read more prominently than labels. The hover brightening reinforces clickability.

Pencil icon: `text-muted-foreground/40` → `text-muted-foreground/30` — even more subtle until hover.

### 5. Row Count Styling (ClusterCard.tsx)

**Lines 369-371:**

```tsx
// Before
<span className="text-xs text-muted-foreground/70 tabular-nums shrink-0">
  {value?.count.toLocaleString() ?? 0} rows
</span>

// After
<span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0 font-mono">
  {value?.count.toLocaleString() ?? 0} rows
</span>
```

- Slightly smaller (`text-[11px]`) — more ledger-like
- `font-mono` — tabular data reads better monospaced
- Further de-emphasized (`/50`) since it's secondary info

## E2E Test Impact

**No test changes required.** Verified:
- `e2e/page-objects/standardize-view.page.ts:142` — `filterBy()` uses `data-testid` selectors (`filter-all`, `filter-actionable`), not text matching
- `e2e/tests/value-standardization.spec.ts` — All filter interactions go through the page object
- `data-testid="cluster-card"` stays unchanged
- `data-testid="unique-value-replacement-input"` and `data-testid="unique-value-replacement-confirm"` stay unchanged
- Removed `data-testid="unique-value-checkbox-*"` — not referenced in any e2e test

## Verification

1. `npm run build` — TypeScript check passes
2. `npm run dev` — Visual inspection:
   - Load a table, open Smart Replace, analyze a text column
   - Confirm "Distinct" / "Clusters" tabs render correctly with counts
   - Confirm unique value cards have no check icon, show left-border accent when replacement is set
   - Click a value → confirm popover has visible ring/shadow separation from cards
   - Set a replacement → confirm strikethrough → arrow → new value pattern still works
   - Clear a replacement → confirm card reverts to transparent state
3. `npx playwright test "value-standardization.spec.ts" --timeout=90000 --retries=0 --reporter=line` — All existing tests pass
