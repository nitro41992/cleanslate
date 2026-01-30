# Plan: Manual Text Replacement for Unique Values in Value Standardizer

## Summary
Add the ability for users to manually replace unique values (single-value clusters) with custom text in the Standardize feature. Currently, unique values are read-only. This change enables users to click a unique value, type a replacement, and have it included in the standardization apply flow.

## Files to Modify

| File | Changes |
|------|---------|
| `src/types/index.ts` | Add `customReplacement?: string` to `ClusterValue` interface |
| `src/stores/standardizerStore.ts` | Add `setCustomReplacement` action, update `getSelectedMappings()` and `calculateStats()` |
| `src/features/standardizer/components/ClusterCard.tsx` | Rewrite `UniqueValueCard` with edit functionality (popover + input) |
| `src/features/standardizer/components/ClusterList.tsx` | Wire up `onSetReplacement` prop |
| `src/features/standardizer/StandardizeView.tsx` | Extract and pass `setCustomReplacement` to ClusterList |

## Implementation Steps

### 1. Extend Types (`src/types/index.ts`)
Add optional `customReplacement` field to `ClusterValue` (line ~276-282):
```typescript
export interface ClusterValue {
  id: string
  value: string
  count: number
  isSelected: boolean
  isMaster: boolean
  customReplacement?: string  // NEW
}
```

### 2. Update Store (`src/stores/standardizerStore.ts`)

**Add action to interface:**
```typescript
setCustomReplacement: (clusterId: string, valueId: string, replacement: string | null) => void
```

**Implement action:**
- Set `customReplacement` on the value
- Auto-set `isSelected: true` when replacement is set (cleared when null)
- Recalculate `selectedCount` and stats

**Update `getSelectedMappings()`:**
- For single-value clusters, check if `customReplacement` is set and differs from original
- Add mapping `{ fromValue: original, toValue: customReplacement, rowCount }`

**Update `calculateStats()`:**
- Count unique values with custom replacements as `selectedValues`

### 3. Rewrite `UniqueValueCard` (`src/features/standardizer/components/ClusterCard.tsx`)

**New UI pattern:**
- Click value text to open Popover with Input field
- Pencil icon appears on hover as edit affordance
- When replacement is set:
  - Show strikethrough original + arrow + replacement text
  - Checkbox replaces green checkmark (selected state)
  - X button to clear replacement
- Press Enter to confirm, Escape to cancel

**Visual treatment:**
```
Without replacement:  [✓] "Value"                      123 rows
With replacement:     [☑] "Original" → "Replacement" [X] 123 rows
```

### 4. Wire Up Props

**ClusterList.tsx:**
- Add `onSetReplacement` to props interface
- Pass to ClusterCard: `onSetReplacement={(valueId, replacement) => onSetReplacement(cluster.id, valueId, replacement)}`

**StandardizeView.tsx:**
- Extract `setCustomReplacement` from store
- Pass to ClusterList as `onSetReplacement={setCustomReplacement}`

## Data Flow

```
User clicks edit → Popover opens → User types replacement → Enter
         ↓
setCustomReplacement(clusterId, valueId, "new value")
         ↓
Store updates: customReplacement set, isSelected = true, stats recalculated
         ↓
UI shows replacement indicator
         ↓
Apply Standardization clicked
         ↓
getSelectedMappings() includes { fromValue, toValue: customReplacement, rowCount }
         ↓
standardize:apply command executes
```

## Edge Cases

| Case | Behavior |
|------|----------|
| Replacement same as original | Don't add to mappings |
| Empty replacement | Clear replacement, deselect |
| Special characters | Pass through (SQL escaping handled in engine) |
| Page refresh before apply | Custom replacements lost (in-memory) - acceptable |

## Verification

1. **Manual test:**
   - Open Value Standardizer, analyze a column with unique values
   - Switch to "Unique" tab
   - Click a unique value, type replacement, press Enter
   - Verify card shows strikethrough + arrow + replacement
   - Verify stats update (header shows "N selected")
   - Click "Apply Standardization"
   - Verify data changed in grid

2. **Edge cases to verify:**
   - Clear replacement with X button
   - Cancel edit with Escape
   - Apply with only unique value replacements
   - Apply with mixed unique + actionable selections
