# Plan: Value Standardizer UI Redesign

## Problem Statement

The current Value Standardizer view is visually overstimulating with:
1. Confusing metrics ("4 rows, 8 variations" - what do these mean?)
2. Broken progress indicator (shows "9/8" due to counting bug)
3. Unnecessary double quotes around all values
4. Redundant information between collapsed/expanded states
5. No way to review associated records with all column values

## Goals

1. **Reduce visual noise** - Remove redundant info, quotes, fix metrics
2. **Clarify information architecture** - Make metrics self-explanatory
3. **Add record preview** - Bottom drawer to compare records across values
4. **Maintain functionality** - Keep all existing selection/standardization features

---

## Part 1: Bug Fix & Visual Cleanup (ClusterCard.tsx)

### 1.1 Fix Progress Indicator Bug

**Root cause:** Line 34 counts master in `selectedCount` but line 35 excludes it from `selectableCount`.

```typescript
// Line 34 - BEFORE:
const selectedCount = cluster.values.filter((v) => v.isSelected).length

// Line 34 - AFTER:
const selectedCount = cluster.values.filter((v) => v.isSelected && !v.isMaster).length
```

### 1.2 Remove Quotes

| Location | Line | Before | After |
|----------|------|--------|-------|
| Master display | 71 | `"{cluster.masterValue}"` | `{cluster.masterValue}` |
| Value rows | 383 | `"{value.value}"` | `{value.value}` |

### 1.3 Simplify Badge Notation

**Current (lines 74-88):** Two badges `[9 values]` `[8 to change]`

**Proposed:** Single compact badge with tooltip

```tsx
<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild>
      <Badge variant="secondary" className="shrink-0 tabular-nums">
        {masterRowCount} → {selectedVariationCount}
      </Badge>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-[250px]">
      {masterRowCount} rows remain as "{cluster.masterValue}"
      <br />
      {selectedVariationCount} variations will be standardized
    </TooltipContent>
  </Tooltip>
</TooltipProvider>
```

### 1.4 Clarify Summary Text (lines 92-102)

**Current:** `4 rows · 8 variations`

**Proposed:** Remove this line entirely - the badge now conveys this info. Or simplify to just show total affected rows: `12 rows in cluster`

### 1.5 Add Review Button

Add Eye icon button in collapsed header to open record preview drawer.

---

## Part 2: Record Preview Drawer

### 2.1 Component: RecordPreviewDrawer.tsx (new file)

**Approach:** Use shadcn Sheet with `side="bottom"` + custom resize handle

```
┌─────────────────────────────────────────────────────────────┐
│ Records for "Mary Hill" cluster              [Collapse] [×] │
│─────────────────────────────────────────────────────────────│ ← Drag handle (4px)
│ ┌───────────────────────────────────────────────────────────┐
│ │ Value      │ Name    │ Email         │ Phone   │ ...     │ ← Horizontal scroll
│ ├────────────┼─────────┼───────────────┼─────────┼─────────┤
│ │★ Mary Hill │ M. Hill │ mh@test.com   │ 555-123 │         │ ← Master (amber bg)
│ │★ Mary Hill │ Mary H. │ mary@test.com │ 555-456 │         │
│ ├────────────┼─────────┼───────────────┼─────────┼─────────┤ ← Group separator
│ │  Mary Hale │ M. Hale │ hale@test.com │ 555-789 │         │ ← Variation
│ └───────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Fixed heights: 200px collapsed, 400px expanded (toggle button)
- Optional: CSS drag-to-resize (min 200px, max 60vh)
- Records grouped by value with visual separators
- Master value rows have amber background
- Horizontal scrolling for all columns
- View-only (no editing)

### 2.2 Data Query Strategy

**Paginated loading** (follow VirtualizedDiffGrid pattern):

```sql
SELECT * FROM "{tableName}"
WHERE "{columnName}" IN ({quotedValues})
ORDER BY
  CASE "{columnName}" WHEN '{masterValue}' THEN 0 ELSE 1 END,
  "{columnName}",
  "_cs_id"
LIMIT 100
```

- Page size: 100 rows
- Prefetch buffer: 50 rows
- Use keyset pagination for subsequent pages

### 2.3 State Changes (standardizerStore.ts)

Add to store:
```typescript
previewClusterId: string | null
previewRecords: Record<string, unknown>[] | null
previewLoading: boolean
setPreviewCluster: (clusterId: string | null) => void
fetchPreviewRecords: (clusterId: string) => Promise<void>
```

### 2.4 Integration (StandardizeView.tsx)

- Import and render `RecordPreviewDrawer` after ClusterList
- Pass `previewClusterId`, `previewRecords`, `onClose` props
- Drawer renders at bottom of results area

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/features/standardizer/components/ClusterCard.tsx` | Bug fix (line 34), remove quotes (71, 383), badge redesign (74-88), add Review button |
| `src/stores/standardizerStore.ts` | Add preview state and actions |
| `src/features/standardizer/StandardizeView.tsx` | Integrate RecordPreviewDrawer |
| `src/features/standardizer/components/RecordPreviewDrawer.tsx` | **New file** |

---

## Implementation Sequence

1. **Fix bug** - Line 34 selectedCount calculation
2. **Remove quotes** - Lines 71, 383
3. **Redesign badges** - Replace dual badges with single `[N → M]` + tooltip
4. **Remove/simplify summary text** - Lines 92-102
5. **Add preview state** - standardizerStore.ts
6. **Create drawer component** - RecordPreviewDrawer.tsx
7. **Add Review button** - ClusterCard header
8. **Integrate drawer** - StandardizeView.tsx

---

## Verification

1. **Progress indicator:** Expand a cluster, verify X/Y where X ≤ Y
2. **Quotes removed:** Values display without surrounding quotes
3. **Badge tooltip:** Hover shows explanation
4. **Review button:** Click opens drawer
5. **Drawer data:** Shows records grouped by value, master highlighted
6. **E2E tests:** Run existing standardizer tests to ensure no regression
