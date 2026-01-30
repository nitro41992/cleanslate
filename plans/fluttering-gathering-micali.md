# Live Preview System for CleanSlate Pro Transformation Panel

## Overview

Add real-time sample previews to the transformation picker panel, showing users how their data will transform before applying. This improves confidence and reduces errors by letting users see actual data changes.

## Design Decisions

| Choice | Decision | Rationale |
|--------|----------|-----------|
| Sample count | 10 rows | Comprehensive preview for confidence |
| Preview trigger | Debounced (300ms) | Live updates as user types |
| Preview location | Above params in right panel | User sees data context first |
| Panel width | 340px (from 280px) | Show full descriptions |

## Design Aesthetic

**Direction: Technical Precision + Data Confidence**
- Clean, utilitarian dark UI that feels like a professional data tool
- Preview panel uses subtle container differentiation (not flashy)
- Before/After presentation with monospace typography for data clarity
- Amber/gold accent for "preview" state to differentiate from green "applied" state
- Smooth fade transitions (not jarring reloads)

## Key Changes

### 1. Panel Width Increase

**Current:** Left picker column is `w-[280px]`
**New:** Increase to `w-[340px]` to show descriptions without truncation

**File:** `src/components/panels/CleanPanel.tsx` line 343

```tsx
// Change from:
<div className="w-[280px] border-r border-border/50 flex flex-col">

// Change to:
<div className="w-[340px] border-r border-border/50 flex flex-col">
```

### 2. New Multi-Select Column Combobox

Create a new component for multi-select column selection (for Combine Columns).

**New File:** `src/components/ui/multi-column-combobox.tsx`

```tsx
interface MultiColumnComboboxProps {
  columns: string[]
  value: string[]
  onValueChange: (values: string[]) => void
  placeholder?: string
  disabled?: boolean
}
```

Features:
- Built on shadcn Command + Popover primitives
- Badge chips showing selected columns (removable with X)
- Search/filter functionality
- Maintains selection order (important for combine)

### 3. New Preview Component

**New File:** `src/components/clean/TransformPreview.tsx`

A self-contained preview component that:
- Fetches sample data when params change (debounced 300ms)
- Shows loading skeleton during fetch
- Displays before/after comparison for 3-5 sample rows
- Handles errors gracefully

```tsx
interface TransformPreviewProps {
  tableName: string
  column?: string
  transformType: TransformationType
  params: Record<string, string>
  enabled: boolean  // Only fetch when all required params are filled
}
```

**Preview Location:** Above the params section (after transform info header, before column selector)

**Preview Layout:**
```
┌─────────────────────────────────────────────────┐
│ 📊 Live Preview (10 samples)                    │
├─────────────────────────────────────────────────┤
│  Original              →   Result               │
│  ─────────────────────────────────────────────  │
│  "  john doe  "        →   "john doe"          │
│  " Jane Smith "        →   "Jane Smith"        │
│  "BOB   JONES"         →   "BOB   JONES"       │
│  "  alice  "           →   "alice"             │
│  ...                                            │
└─────────────────────────────────────────────────┘
```

### 4. Preview Logic Per Transformation

Each transformation needs custom preview SQL. Create a utility:

**New File:** `src/lib/preview/transform-preview.ts`

```tsx
export async function generatePreview(
  tableName: string,
  column: string | undefined,
  transformType: TransformationType,
  params: Record<string, string>,
  limit: number = 10  // Show 10 samples
): Promise<{ rows: PreviewRow[]; totalMatching: number }>
```

**Preview SQL by Transform:**

| Transform | Preview SQL | Trigger Condition |
|-----------|-------------|-------------------|
| Find & Replace | `SELECT "{col}" AS original, REPLACE(...) AS result FROM "{table}" WHERE "{col}" LIKE '%{find}%' LIMIT 5` | `find` param has value |
| Split Column | `SELECT "{col}" AS original, string_split(...)` | column + delimiter/mode selected |
| Combine Columns | `SELECT {cols} AS originals, CONCAT_WS(...) AS result` | 2+ columns selected |
| Cast Type | `SELECT "{col}" AS original, TRY_CAST(...) AS result` | column + targetType selected |
| Pad Zeros | `SELECT "{col}" AS original, LPAD(...) AS result` | column + length selected |
| Standardize Date | `SELECT "{col}" AS original, strftime(COALESCE(...)) AS result` | column + format selected |
| Calculate Age | `SELECT "{col}" AS original, DATE_DIFF('year', ..., CURRENT_DATE) AS result` | column selected |

### 5. Calculate Age - Float Option

Add new parameter to calculate_age transformation:

**File:** `src/lib/transformations.ts` (line ~374)

```tsx
{
  id: 'calculate_age',
  label: 'Calculate Age',
  description: 'Create age column from date of birth',
  icon: '🎂',
  requiresColumn: true,
  params: [
    {
      name: 'precision',
      type: 'select',
      label: 'Precision',
      options: [
        { value: 'years', label: 'Whole Years (34)' },
        { value: 'decimal', label: 'Decimal (34.5)' },
      ],
      default: 'years',
    },
  ],
  // ... examples, hints
}
```

**SQL for decimal age:**
```sql
ROUND(DATE_DIFF('day', parsed_date, CURRENT_DATE) / 365.25, 1)
```

### 6. Integration into CleanPanel

**File:** `src/components/panels/CleanPanel.tsx`

Add preview component **above params section** (after transform info header, before column selector):

```tsx
{/* Right Column Layout Order */}
<div className="space-y-4">
  {/* 1. Transform Info Header (icon, label, description) */}
  <div className="bg-muted/30 rounded-lg p-3">
    {/* existing header content */}
  </div>

  {/* 2. Live Preview - ABOVE params for data context first */}
  {PREVIEW_SUPPORTED_TRANSFORMS.includes(selectedTransform.id) && (
    <TransformPreview
      tableName={activeTable.name}
      column={selectedColumn}
      transformType={selectedTransform.id}
      params={params}
      enabled={isPreviewReady(selectedTransform, selectedColumn, params)}
      sampleCount={10}
    />
  )}

  {/* 3. Column Selector */}
  {/* 4. Additional Params */}
  {/* 5. Apply/Cancel Buttons */}
</div>
```

Supported transforms for preview:
- `replace` (Find & Replace)
- `split_column`
- `combine_columns`
- `cast_type`
- `pad_zeros`
- `standardize_date`
- `calculate_age`

### 7. Combine Columns UX Improvement

Replace comma-separated text input with multi-select combobox:

**File:** `src/components/panels/CleanPanel.tsx`

In the params rendering section, add special case for `combine_columns`:

```tsx
{selectedTransform.id === 'combine_columns' && param.name === 'columns' ? (
  <MultiColumnCombobox
    columns={columns}
    value={selectedColumnsArray}
    onValueChange={(vals) => setParams({ ...params, columns: vals.join(',') })}
    placeholder="Select columns to combine..."
  />
) : (
  // existing Input component
)}
```

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/components/panels/CleanPanel.tsx` | Modify | Widen panel, integrate preview, multi-select for combine |
| `src/components/ui/multi-column-combobox.tsx` | Create | Multi-select searchable column picker |
| `src/components/clean/TransformPreview.tsx` | Create | Preview component with before/after display |
| `src/lib/preview/transform-preview.ts` | Create | Preview SQL generation for each transform |
| `src/lib/transformations.ts` | Modify | Add precision param to calculate_age |
| `src/lib/commands/transforms/calculate-age.ts` | Modify | Support decimal precision in age calculation |

---

## Styling Details

### Preview Container
```tsx
<div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
      <Eye className="w-3.5 h-3.5" />
      Live Preview
    </div>
    <span className="text-[10px] text-muted-foreground">
      {samples.length} of {totalMatchingRows} matching rows
    </span>
  </div>
  <ScrollArea className="h-[180px]">  {/* Fixed height for 10 rows */}
    {/* preview content */}
  </ScrollArea>
</div>
```

### Before/After Row
```tsx
<div className="flex items-center gap-3 text-xs font-mono">
  <span className="text-muted-foreground/80 min-w-[120px] truncate">
    {row.original}
  </span>
  <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
  <span className="text-green-400/90 min-w-[120px] truncate">
    {row.result}
  </span>
</div>
```

### Multi-Select Badge
```tsx
<Badge variant="secondary" className="gap-1 pr-1">
  {column}
  <X className="w-3 h-3 cursor-pointer hover:text-destructive"
     onClick={() => removeColumn(column)} />
</Badge>
```

---

## Verification

1. **Visual Check:** Panel is wider, descriptions no longer truncate
2. **Find & Replace Preview:** Type in "find" field, see matching rows
3. **Split Column Preview:** Select column + delimiter, see split result
4. **Combine Columns:** Multi-select columns, see combined preview
5. **Cast Type Preview:** Select target type, see conversion result
6. **Pad Zeros Preview:** Set length, see padded numbers
7. **Standardize Date:** Select format, see date conversion
8. **Calculate Age:** Toggle precision, see whole vs decimal age
9. **Loading State:** Preview shows skeleton while fetching
10. **Error Handling:** Invalid params show graceful empty state
