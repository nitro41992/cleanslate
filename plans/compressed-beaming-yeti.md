# UI Refinement Plan: Modernize Standardize & Match Views

## Status: ✅ READY FOR REVIEW

## Objective
Refine the Standardize main results area and Match expanded cards to align with the Clean panel's modern design language, incorporating 2026 UI trends.

---

## Problem Statement

Based on review of the current implementation:

1. **StandardizeView Results Area** (after analysis runs):
   - `ClusterCard.tsx` uses basic border/bg styling that feels dated
   - `ClusterList.tsx` filter tabs are plain buttons without modern glass-morphic treatment
   - Value rows lack visual hierarchy and micro-interactions
   - Master value selection needs stronger visual distinction

2. **MatchRow Expanded State**:
   - Side-by-side comparison uses basic `border-l-4` styling
   - Field-by-field comparison lacks clear diff visualization
   - Swap button is functional but not visually refined
   - Expanded content doesn't use frosted glass effects

---

## Design Direction: "Refined Glass Data"

Inspired by 2025-2026 UI trends ([Muzli](https://muz.li/blog/best-dashboard-design-examples-inspirations-for-2026/), [BootstrapDash](https://www.bootstrapdash.com/blog/ui-ux-design-trends)):

- **Liquid Glass UI**: Translucent layers with `backdrop-blur-sm`, gradient borders
- **Subtle Glow States**: Selection/hover states with `ring` + `shadow-primary/10`
- **Micro-visualizations**: Progress bars for selection ratios, similarity scores
- **Staggered Animations**: `animate-in` with `animation-delay` for list items
- **Clean Typography Hierarchy**: Clear distinction between labels, values, metadata

### Design Tokens (aligning with CleanPanel)

| Element | Current | Modernized |
|---------|---------|------------|
| Card base | `border rounded-lg bg-card` | `rounded-xl bg-gradient-to-br from-card/80 to-card/60 backdrop-blur-sm ring-1 ring-border/30` |
| Selected state | `ring-1 ring-primary/30` | `ring-1 ring-primary/40 shadow-lg shadow-primary/5` |
| Section divider | `border-t` | `border-t border-border/20` with `bg-muted/20` |
| Master badge | `bg-amber-500/20` | `bg-transparent border-amber-500/50 text-amber-500` (outlined minimal) |
| Field diff | Solid colored borders | Color-coded left border: `border-l-2 border-l-green-500` (exact), `border-l-amber-500` (similar), `border-l-red-500` (different) |
| Expanded panels | Solid backgrounds | `backdrop-blur-sm bg-muted/10` for glass depth |

### User Design Choices
- **Master Badge**: Outlined with accent (minimal, transparent with amber border)
- **Diff Visualization**: Color-coded left borders per field row
- **Glass Effect**: Yes - subtle `backdrop-blur-sm` for modern depth

---

## Files to Modify

### 1. ClusterCard.tsx
**Path:** `src/features/standardizer/components/ClusterCard.tsx`

**Changes:**
- Add glass-morphic card wrapper with gradient border
- Improve header with icon container and better badge placement
- Add selection progress micro-visualization (thin progress bar)
- Stagger animation on value rows when expanding
- Master value row with gradient background and glow
- Show-on-hover "Set Master" button with smooth transition
- Better visual hierarchy for row counts

### 2. ClusterList.tsx
**Path:** `src/features/standardizer/components/ClusterList.tsx`

**Changes:**
- Modernize filter tabs to pill-style glass buttons
- Add subtle backdrop blur to filter bar
- Improve search input styling with icon treatment
- Better empty state with icon in rounded container

### 3. MatchRow.tsx
**Path:** `src/features/matcher/components/MatchRow.tsx`

**Changes:**
- **Summary row**: Keep current structure, refine badge styling
- **Expanded comparison**:
  - Frosted glass container (`bg-muted/10 backdrop-blur-sm rounded-lg`)
  - Field-by-field rows with **color-coded left borders**:
    - `border-l-2 border-l-green-500/60` - Exact match
    - `border-l-2 border-l-amber-500/60` - Similar (>70% but not exact)
    - `border-l-2 border-l-red-500/60` - Different (<70%)
  - Modern swap button (circular, glass effect, hover glow)
  - Better KEEPING/REMOVING labels with icons
  - Clean typography: field names in `text-muted-foreground text-xs`, values in `text-sm`
  - Stagger animation on field rows when expanding

### 4. SimilaritySpectrum.tsx (minor enhancement)
**Path:** `src/features/matcher/components/SimilaritySpectrum.tsx`

**Changes:**
- Ensure gradient bar uses modern color stops
- Add subtle glow under threshold handles

---

## Implementation Order

1. **ClusterCard.tsx** - Core standardize results card
2. **ClusterList.tsx** - Filter bar and container
3. **MatchRow.tsx** - Expanded duplicate comparison
4. **SimilaritySpectrum.tsx** - Minor polish

---

## Visual Reference

### ClusterCard Expanded State
```
┌───────────────────────────────────────────────────────────────┐
│ ▶  [◇]  "john smith"  +2 variations                           │  ← Glass card
│         1,247 rows · 892 in master                    [3] [2] │     with blur
├───────────────────────────────────────────────────────────────┤
│  Select all  │  Clear                            ████░░░ 2/3  │  ← Progress bar
├───────────────────────────────────────────────────────────────┤
│ ☑  "john smith"                              892  [☆ Master]  │  ← Outlined badge
│ ☑  "John Smith"                              234    Set Mstr  │     amber border
│ ☐  "JOHN SMITH"                              121    Set Mstr  │
└───────────────────────────────────────────────────────────────┘
```

### MatchRow Expanded State
```
┌───────────────────────────────────────────────────────────────┐
│ ☐  John Smith vs Jon Smith                  [87% Similar]  ▼  │
├───────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────┐      ┌─────────────────────────┐  │
│ │  ✓ KEEPING              │  ⇄   │  ✗ REMOVING             │  │  ← Frosted glass
│ │                         │      │                         │  │     backdrop-blur
│ │ ▌name: John Smith       │      │ ▌name: Jon Smith        │  │  ← Red left border
│ │ ▌email: j@co.com        │      │ ▌email: j@co.com        │  │  ← Green left border
│ │ ▌phone: 555-1234        │      │ ▌phone: 555-1235        │  │  ← Red left border
│ └─────────────────────────┘      └─────────────────────────┘  │
│                    2 exact · 2 different                      │
└───────────────────────────────────────────────────────────────┘
Legend: ▌green = exact match, ▌amber = similar, ▌red = different
```

---

## Testing Plan

**Visual Verification:**
1. Open Standardize view → run analysis → verify cluster cards
2. Expand clusters → check animation, hover states, master selection
3. Open Match view → find duplicates → expand pairs
4. Verify field comparison styling, swap button, responsive layout

**E2E Tests (existing should pass):**
```bash
npx playwright test "standardize" --timeout=60000 --retries=0 --reporter=line
npx playwright test "matcher" --timeout=60000 --retries=0 --reporter=line
```

---

## Design Inspiration Sources

- [Muzli: Best Dashboard Design Examples for 2026](https://muz.li/blog/best-dashboard-design-examples-inspirations-for-2026/)
- [BootstrapDash: UI/UX Design Trends 2025](https://www.bootstrapdash.com/blog/ui-ux-design-trends)
- [UITop: Dashboard Design Trends for SaaS](https://uitop.design/blog/design/top-dashboard-design-trends/)
- [MuseMind: UI Design Trends 2026](https://musemind.agency/blog/ui-design-trends)
