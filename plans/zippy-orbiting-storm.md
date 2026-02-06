# Plan: Fuzzy Matcher / Merge UI Refinement

## Summary
Refine the Matcher UI across 4 axes: harmonize dark-mode colors, improve histogram readability, reduce detail-card visual noise, and deduplicate same-value pairs.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/index.css` | Add `--matcher-*` CSS variables (light + dark) |
| `src/components/ui/dual-range-slider.tsx` | Update thumb/range colors to CSS vars |
| `src/features/matcher/components/SimilaritySpectrum.tsx` | 10 buckets, split bars at thresholds, vertical threshold lines, simpler legend |
| `src/features/matcher/components/CategoryFilter.tsx` | Neutral tab backgrounds, underline accent on active |
| `src/features/matcher/components/MatchRow.tsx` | Neutral card backgrounds w/ left-border accent, neutral detail cards, field dots instead of thick borders, opacity hierarchy |
| `src/features/matcher/MatchView.tsx` | Dedup logic, header stats colors, apply-bar color |

---

## Issue 1: Dark Mode Color Harmonization

**Problem:** Saturated red/green/yellow clash against the warm gray dark background.

**Approach:** Define a desaturated matcher palette via CSS variables. Use teal (hue 152) instead of green, warm amber (hue 40) instead of yellow, and neutral gray instead of red for "not match." Reserve hue for badges only; cards get neutral backgrounds with small accent borders.

### Step 1A: CSS Variables in `src/index.css`

Add inside `:root` (light) and `.dark` blocks:

```css
/* Dark mode */
--matcher-definite: 152 40% 45%;
--matcher-definite-bg: 152 20% 14%;
--matcher-maybe: 40 50% 50%;
--matcher-maybe-bg: 40 20% 14%;
--matcher-not-match: 0 0% 50%;
--matcher-not-match-bg: 0 0% 14%;
--matcher-field-exact: 152 35% 40%;
--matcher-field-similar: 40 45% 50%;
--matcher-field-different: 350 45% 55%;

/* Light mode */
--matcher-definite: 152 55% 35%;
--matcher-definite-bg: 152 40% 95%;
--matcher-maybe: 40 70% 45%;
--matcher-maybe-bg: 40 50% 95%;
--matcher-not-match: 220 10% 55%;
--matcher-not-match-bg: 220 10% 96%;
--matcher-field-exact: 152 50% 35%;
--matcher-field-similar: 40 60% 45%;
--matcher-field-different: 350 55% 50%;
```

### Step 1B: MatchRow card backgrounds

Replace saturated card backgrounds with neutral bg + left-border accent:
- **Definite/Maybe:** `bg-card border border-border border-l-[3px] border-l-[hsl(var(--matcher-*))]`
- **Not Match:** `bg-card border border-border` (no accent — neutral)

### Step 1C: Similarity badges

Use CSS variables at 15% opacity background + full color text. Not-match badge uses `bg-muted text-muted-foreground`.

### Step 1D: CategoryFilter tabs

Remove colored backgrounds from tabs. Active tab gets `bg-background shadow-sm` + bottom border accent in zone color. Inactive tabs are plain `text-muted-foreground`.

### Step 1E: DualRangeSlider

- Left thumb border: `border-[hsl(var(--matcher-maybe))]`
- Right thumb border: `border-[hsl(var(--matcher-definite))]`
- Range fill: `bg-[hsl(var(--matcher-maybe)/0.3)]`

### Step 1F: Legend, header stats, apply bar

- Zone legend: small dots + plain text (remove colored pill backgrounds)
- Header stats: merged uses `--matcher-definite`, kept uses `text-muted-foreground`
- Apply bar: `bg-[hsl(var(--matcher-definite-bg))]`

---

## Issue 2: Histogram Readability

**Problem:** 20 bars + midpoint-based coloring = confusing when thresholds fall between bars.

### Step 2A: Reduce to 10 buckets (10% each)

Change `bucketCount` from 20 to 10 in `SimilaritySpectrum.tsx`.

### Step 2B: Split bars at threshold boundaries

When a bar spans a threshold, render it as two sub-divs with proportional widths:

```
Bar [80-90%] with definiteThreshold=85:
  → Left 50% colored as "maybe"
  → Right 50% colored as "definite"
```

Helper function `getBarSegments(bucketMin, bucketMax, maybe, definite)` returns segments with zone classification. Each bar uses `flex` to render segments proportionally.

### Step 2C: Overlay vertical threshold lines

Two absolute-positioned 1px lines at `left: {threshold}%` using zone colors. `pointer-events-none` to not block slider interaction.

### Step 2D: Scale labels

Keep 0/25/50/75/100 (5 labels is sufficient with 10 buckets).

---

## Issue 3: Row Detail Visual Noise

**Problem:** Green KEEPING + Red REMOVING cards with green/amber/red field borders = overstimulating.

### Step 3A: Neutral detail card backgrounds

Both KEEPING and REMOVING cards get `bg-muted/50 border-border`. Same background for both.

### Step 3B: Refined header badges

- KEEPING: small teal check icon + "KEEPING" text in `--matcher-definite` color
- REMOVING: small muted X icon + "REMOVING" text in `text-muted-foreground`
- No colored icon backgrounds or full-width colored headers

### Step 3C: Field indicators — dots + opacity hierarchy

Replace thick left borders with small inline dots (1.5px). Key change: **exact fields visually recede, different fields pop forward**.

| Status | Dot | Text |
|--------|-----|------|
| exact | `--matcher-field-exact` at 50% opacity | `text-foreground/50` (recede) |
| similar | `--matcher-field-similar` full | `text-foreground/75` (moderate) |
| different | `--matcher-field-different` full | `text-foreground font-medium` (pop) |

This inverts the current equal-weight approach: the user's eye is drawn to what's *different* — the fields requiring judgment.

### Step 3D: Field legend

Update bottom legend dots to match new `--matcher-field-*` colors and smaller 1.5px size.

---

## Issue 4: Deduplicate Same-Value Pairs

**Problem:** Multiple physical rows with identical match-column values produce pairs like "Erica Dean vs Eric Dunn" and "Eric Dunn vs Erica Dean" that look like duplicates.

### Step 4A: Add dedup utility

In `MatchView.tsx`, add `deduplicateByMatchValues(pairs, matchColumn)`:
1. Sort pairs by similarity descending (keep highest-scoring occurrence)
2. Build canonical key: `sorted [valueA.lower, valueB.lower].join('|||')`
3. Keep first occurrence per canonical key

### Step 4B: Wire into handleFindDuplicates

After `startMatching()` returns and before `setPairs()`, apply dedup:

```typescript
const result = await startMatching(...)
let pairs = result.pairs
if (matchColumn) {
  pairs = deduplicateByMatchValues(pairs, matchColumn)
}
setPairs(pairs)
```

Toast message shows dedup count if any were collapsed.

### Step 4C: Edge cases

- Case-insensitive comparison (`.toLowerCase()`)
- Whitespace normalization (`.trim()`)
- Null handling (`String(null)` → `'null'`)
- Performance: O(n) with Map, fine for max 10k pairs

---

## Implementation Order

1. `src/index.css` — CSS variables (foundation)
2. `src/components/ui/dual-range-slider.tsx` — slider colors
3. `src/features/matcher/components/SimilaritySpectrum.tsx` — histogram overhaul
4. `src/features/matcher/components/CategoryFilter.tsx` — tab styling
5. `src/features/matcher/components/MatchRow.tsx` — card + detail refinement
6. `src/features/matcher/MatchView.tsx` — dedup + misc colors

## Verification

1. `npm run dev` → Open Merge panel with the fuzzy_duplicate_claims_dataset fixture
2. Verify dark mode: cards have neutral backgrounds, left-border accents, desaturated badges
3. Verify histogram: bars split at thresholds, vertical threshold lines visible, 10 buckets
4. Verify expanded detail: neutral card backgrounds, dots instead of thick borders, exact fields recede, different fields stand out
5. Verify dedup: no "A vs B" + "B vs A" cards for same match-column values
6. Verify light mode: colors remain readable and harmonious
7. `npm run build` — TypeScript + production build passes
