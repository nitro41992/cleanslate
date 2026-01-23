# Fix Calculate Age Diff View: Complete Redesign

## Problem Summary

After applying Calculate Age (or any transform that adds a new column), the diff view should:
1. Show the new column with `(+NEW)` badge
2. Display all cells in that column with **green styling**
3. Show correct counts that match the audit log
4. Also correctly show manual cell edits as modified

Previous attempts broke the diff by incorrectly inverting table order and CASE statement semantics.

---

## Root Cause Analysis

### The Semantic Model

The diff engine has a specific semantic:
- `runDiff(tableA, tableB)` where **A = source/original**, **B = target/current**
- `a.key IS NULL` → 'added' = row exists in B (current) only = **new row**
- `b.key IS NULL` → 'removed' = row exists in A (original) only = **deleted row**
- `newColumns` = columns in A but not B = columns **removed** from current
- `removedColumns` = columns in B but not A = columns **added** to current (confusing naming!)

### What Broke

My previous changes:
1. Swapped table order: `runDiff(current, original)` instead of `runDiff(original, current)`
2. Swapped CASE conditions to "fix" #1
3. Added `buildModificationCondition()` that included new columns

This created inconsistent semantics where counts became wrong ("2 added" when nothing was added).

### The Real Issue

The naming `newColumns`/`removedColumns` is from **table A's perspective**, not the user's perspective:
- If A=original, B=current: `newColumns` = columns in original not in current = **columns REMOVED by user**
- The variable naming is backwards from user expectations!

---

## Solution Design

### Approach: Revert + Minimal Fix

1. **REVERT** all architectural changes (table order, CASE statement)
2. **KEEP** the original semantic model intact
3. **ADD** new column detection for display purposes only
4. **FIX** variable naming confusion in the code

### Key Insight

For "Compare with Preview" mode:
- `sourceTableName` = original snapshot (what we HAD)
- `targetTableName` = current table (what we HAVE now)
- `runDiff(source, target)` = `runDiff(original, current)`
- So A=original, B=current

For new columns added by Calculate Age:
- `age` exists in B (current) but not A (original)
- This means `age` is in `removedColumns` (columns in B not A)
- But semantically for the USER, `age` is a NEW column!

**Fix**: After computing, swap the perspective for display:
- `userNewColumns` = `removedColumns` (columns in current not original)
- `userRemovedColumns` = `newColumns` (columns in original not current)

---

## Implementation Plan

### Step 1: Revert diff-engine.ts

**File:** `src/lib/diff-engine.ts`

> **Note:** If uncommitted changes added `buildModificationCondition()`, remove it. If working from clean git state, skip removal and proceed with CASE modification.

1. **Remove** the `buildModificationCondition()` function if present (from uncommitted changes)
2. **Restore** the original CASE statement:
```sql
CASE
  WHEN a.key IS NULL THEN 'added'      -- row in B (current) only
  WHEN b.key IS NULL THEN 'removed'    -- row in A (original) only
  WHEN <shared_columns_differ> THEN 'modified'
  ELSE 'unchanged'
END
```

3. **Add** new column detection for rows (keep existing behavior for modification):
```typescript
// After computing newColumns/removedColumns, add condition for modification
// that includes rows where NEW columns (in current) have non-null values

// For the modification condition, add:
// - Shared columns differ (existing)
// - OR columns in B (current) but not A (original) have non-null values
if (removedColumns.length > 0) {  // Note: removedColumns = cols in B not A = user's "new columns"
  const newColCondition = removedColumns
    .map((c) => `b."${c}" IS NOT NULL`)
    .join(' OR ')
  conditions.push(`(${newColCondition})`)
}
```

### Step 2: Revert DiffView.tsx

**File:** `src/components/diff/DiffView.tsx`

Restore original call order:
```typescript
const config = await runDiff(
  sourceTableName,   // original snapshot (A)
  targetTableName,   // current table (B)
  keyColumns
)
```

### Step 3: Fix VirtualizedDiffGrid.tsx Display

**File:** `src/components/diff/VirtualizedDiffGrid.tsx`

1. **Revert** to original state first
2. **Swap perspective** for display - what the code calls `removedColumns` is actually "new columns" from user perspective:

```typescript
// IMPORTANT: Variable name swap explained
// The diff engine computes columns from tableA's perspective where A=original, B=current:
//   newColumns     = Set(A) - Set(B) = columns in original not current = USER's REMOVED columns
//   removedColumns = Set(B) - Set(A) = columns in current not original = USER's NEW columns
//
// We swap the names here to match user expectations in the UI:
const userNewColumns = removedColumns    // columns added to current (e.g., 'age' from Calculate Age)
const userRemovedColumns = newColumns    // columns removed from current
```

3. **Add green styling** for cells in `userNewColumns`:
```typescript
// In drawCell callback:
if (userNewColumns.includes(colName) && status !== 'removed') {
  // Green background and text for new column cells
  ctx.save()
  ctx.fillStyle = 'rgba(34, 197, 94, 0.15)'
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#22c55e'
  const strB = rowData[`b_${colName}`]
  ctx.fillText(strB ?? '', rect.x + 8, rect.y + rect.height / 2)
  ctx.restore()
  return
}
```

4. **Fix column header badges**:
```typescript
// Use user perspective for badges:
if (userNewColumns.includes(col)) badges.push('+NEW')
if (userRemovedColumns.includes(col)) badges.push('-DEL')
```

### Step 4: Update Row Theme

In `getRowThemeOverride`, don't show yellow for rows that are "modified" only due to new columns:
```typescript
if (status === 'modified') {
  // Check if any SHARED columns differ
  const modifiedCols = getModifiedColumns(rowData, allColumns, keyColumns, userNewColumns, userRemovedColumns)
  if (modifiedCols.length === 0) {
    // Only new/removed columns changed - no yellow row background
    return undefined
  }
  return { bgCell: 'rgba(234, 179, 8, 0.08)' }
}
```

### Step 5: Fix getCellContent Display

Update to use correct perspective:
```typescript
if (status === 'added') {
  displayValue = strB  // Show current value (B) for new rows
} else if (status === 'removed') {
  displayValue = strA  // Show original value (A) for deleted rows
} else if (userNewColumns.includes(colName)) {
  displayValue = strB  // Show current value for new columns
} else if (userRemovedColumns.includes(colName)) {
  displayValue = strA  // Show original value for removed columns
} else {
  // Modified or unchanged
  const modifiedCols = getModifiedColumns(...)
  if (modifiedCols.includes(colName)) {
    displayValue = `${strA} → ${strB}`
  } else {
    displayValue = strB  // Show current value
  }
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/diff-engine.ts` | Remove buildModificationCondition, restore CASE, add new column detection in B |
| `src/components/diff/DiffView.tsx` | Restore original runDiff call order |
| `src/components/diff/VirtualizedDiffGrid.tsx` | Swap column perspective for display, add green styling |
| `e2e/tests/audit-undo-regression.spec.ts` | Update FR-REGRESSION-10 test |

---

## Verification

### Manual Testing

1. Upload CSV with date column
2. Apply "Calculate Age" → adds `age` column
3. Open "Compare with Preview"
4. **Expected:**
   - `age` column shows `(+NEW)` badge
   - All cells in `age` column are **green**
   - Rows with age values show up (marked as modified)
   - Row background is **NOT yellow** (only new column changed)
   - Summary shows `X modified` where X = rows with non-null age

5. Make a manual cell edit (e.g., change `full_name`)
6. **Expected:**
   - That row shows yellow background
   - The edited cell shows `old → new` format
   - Summary count includes this modification

### Automated Testing

```bash
npm run build    # TypeScript check
npm run lint     # ESLint
npm test -- --grep "FR-REGRESSION"  # Regression tests
```

---

## Key Semantic Table

| Diff Engine Variable | Meaning (A=original, B=current) | User Perspective |
|---------------------|----------------------------------|------------------|
| `newColumns` | Columns in A not B | Columns REMOVED from current |
| `removedColumns` | Columns in B not A | Columns ADDED to current |
| `'added'` status | Row in B only | New row |
| `'removed'` status | Row in A only | Deleted row |
| `a_colname` | Value from original | Previous value |
| `b_colname` | Value from current | New value |

---

## Why This Works

1. **Original semantic preserved**: Table order and CASE logic unchanged
2. **New columns detected**: Rows with new column data marked as 'modified' via B column check
3. **Display layer handles perspective**: Swap newColumns↔removedColumns for user-facing UI
4. **Green styling for new**: Cells in new columns render green
5. **Yellow only for shared changes**: Row theme checks if shared columns actually changed
