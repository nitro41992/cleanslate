# Undo Performance & Cast Type Validation Fixes

## User-Reported Issues

1. **Undo is slow for Rename Column** - After doing Standardize Date → Calculate Age → Rename Column, undoing Rename Column takes a long time because it replays Calculate Age
2. **Cast Type allows invalid operations** - Casting "dish_name" (text like "Frying") to INTEGER makes all values NULL without warning

---

## Issue 1: Slow Undo for Table-Recreation Transforms

### Root Cause Analysis

The undo system works by:
1. Finding the nearest snapshot BEFORE the target position
2. Restoring from that snapshot
3. Replaying all commands from that snapshot to the target position

Currently, only these operations are marked as "expensive" (trigger snapshot creation):
- `remove_duplicates`
- `merge`
- `join`
- `stack`

**The problem:** These transforms use `CREATE TABLE AS SELECT` (table recreation) but are NOT marked as expensive:
- `calculate_age` - Creates new `age` column
- `standardize_date` - Recreates table with formatted dates
- `cast_type` - Changes column type
- `unformat_currency` - Converts strings to doubles
- `fix_negatives` - Converts accounting format to numbers
- `pad_zeros` - Pads column values
- `fill_down` - Window function on entire table
- `split_column` - Creates new columns

**Example scenario:**
```
Position 0: Standardize Date (table recreation)
Position 1: Calculate Age (table recreation)
Position 2: Rename Column (metadata-only ALTER)
```

When user undoes position 2 → 1:
- No snapshot exists at position 1 (calculate_age not expensive)
- System restores from original snapshot at position -1
- Replays: Standardize Date + Calculate Age
- Result: 2 slow table-recreation transforms just to undo 1 fast metadata change

### Solution: Mark Table-Recreation Transforms as Expensive

Add these transforms to the expensive operations list so snapshots are created AFTER them:

```typescript
// In timeline-engine.ts - isExpensiveOperation()
const expensiveTransforms = new Set([
  'remove_duplicates',
  'calculate_age',
  'standardize_date',
  'cast_type',
  'unformat_currency',
  'fix_negatives',
  'pad_zeros',
  'fill_down',
  'split_column',
])
```

**After fix:**
- User does: Standardize Date → Calculate Age → Rename Column
- Snapshot created after Standardize Date (position 0)
- Snapshot created after Calculate Age (position 1)
- When undoing Rename Column: Restore from snapshot at position 1 (instant!)

---

## Issue 2: Cast Type Validation

### Problem

`TRY_CAST` silently returns NULL when conversion fails. User casts "dish_name" (text) to INTEGER → entire column becomes NULL.

Current code (`transformations.ts` line 838-849):
```typescript
case 'cast_type': {
  const targetType = (step.params?.targetType as string) || 'VARCHAR'
  sql = `
    CREATE OR REPLACE TABLE "${tempTable}" AS
    SELECT * EXCLUDE ("${step.column}"),
           TRY_CAST("${step.column}" AS ${targetType}) as "${step.column}"
    FROM "${tableName}"
  `
}
```

### Solution: Pre-Validation with Warning

Add a validation step before applying Cast Type that:
1. Samples values from the column
2. Counts how many would become NULL after cast
3. Shows warning dialog if ANY values would become NULL (failCount > 0)
4. Let user confirm or cancel

**New function in `transformations.ts`:**

```typescript
export async function validateCastType(
  tableName: string,
  column: string,
  targetType: string
): Promise<{
  totalRows: number
  successCount: number
  failCount: number
  failurePercentage: number
  sampleFailures: string[]  // Up to 5 example values that would fail
}> {
  const quotedCol = `"${column}"`

  // Count total and successful casts
  const result = await query<{
    total: number
    success_count: number
    fail_count: number
  }>(`
    SELECT
      COUNT(*) as total,
      COUNT(TRY_CAST(${quotedCol} AS ${targetType})) as success_count,
      COUNT(*) - COUNT(TRY_CAST(${quotedCol} AS ${targetType})) as fail_count
    FROM "${tableName}"
    WHERE ${quotedCol} IS NOT NULL
  `)

  const { total, success_count, fail_count } = result[0]

  // Get sample failures
  const samples = await query<{ val: string }>(`
    SELECT CAST(${quotedCol} AS VARCHAR) as val
    FROM "${tableName}"
    WHERE ${quotedCol} IS NOT NULL
      AND TRY_CAST(${quotedCol} AS ${targetType}) IS NULL
    LIMIT 5
  `)

  return {
    totalRows: Number(total),
    successCount: Number(success_count),
    failCount: Number(fail_count),
    failurePercentage: total > 0 ? (fail_count / total) * 100 : 0,
    sampleFailures: samples.map(s => s.val)
  }
}
```

**Update CleanPanel.tsx to show warning:**

```typescript
const handleApply = async () => {
  // ... existing code ...

  // Pre-validation for cast_type
  if (selectedTransform.id === 'cast_type' && selectedColumn) {
    const targetType = params.targetType || 'VARCHAR'
    const validation = await validateCastType(
      activeTable.name,
      selectedColumn,
      targetType
    )

    if (validation.failCount > 0) {  // Warn on ANY data loss
      // Show confirmation dialog
      const confirmed = await showCastTypeWarning({
        column: selectedColumn,
        targetType,
        failCount: validation.failCount,
        totalRows: validation.totalRows,
        failurePercentage: validation.failurePercentage,
        sampleFailures: validation.sampleFailures
      })

      if (!confirmed) {
        setIsApplying(false)
        return
      }
    }
  }

  // ... rest of handleApply ...
}
```

**Warning dialog content:**
```
⚠️ Cast Type Warning

Converting "${column}" to ${targetType} will result in NULL values for
${failCount} out of ${totalRows} rows (${failurePercentage}%).

Sample values that cannot be converted:
• "Frying"
• "boiled"
• "Pan-frying"
...

[Cancel] [Apply Anyway]
```

---

## Implementation Plan

### Step 1: Define EXPENSIVE_TRANSFORMS in Single Location

**File:** `src/lib/transformations.ts` (Single Source of Truth)

Add new export at the top of the file:

```typescript
/**
 * Transforms that are expensive to replay (table recreation or full-table updates).
 * Snapshots are created AFTER these transforms for fast undo.
 *
 * Table Recreation (CREATE TABLE AS SELECT):
 * - calculate_age, standardize_date, cast_type, unformat_currency, fill_down, split_column
 *
 * Full-table Updates (UPDATE all rows):
 * - fix_negatives, pad_zeros
 */
export const EXPENSIVE_TRANSFORMS = new Set([
  'remove_duplicates',
  'calculate_age',
  'standardize_date',
  'cast_type',
  'unformat_currency',
  'fix_negatives',
  'pad_zeros',
  'fill_down',
  'split_column',
])
```

**File:** `src/lib/timeline-engine.ts`

Import and use the shared set:

```typescript
import { EXPENSIVE_TRANSFORMS } from '@/lib/transformations'

function isExpensiveOperation(
  commandType: TimelineCommand['commandType'],
  params: TimelineParams
): boolean {
  // These operations are always expensive
  if (['merge', 'join', 'stack'].includes(commandType)) {
    return true
  }

  // Check for expensive transformations
  if (commandType === 'transform' && params.type === 'transform') {
    return EXPENSIVE_TRANSFORMS.has(params.transformationType)
  }

  return false
}
```

**File:** `src/stores/timelineStore.ts`

Import and use the shared set (replace local EXPENSIVE_OPERATIONS):

```typescript
import { EXPENSIVE_TRANSFORMS } from '@/lib/transformations'

function isExpensiveCommand(commandType: TimelineCommandType, params: TimelineParams): boolean {
  if (commandType === 'merge' || commandType === 'join' || commandType === 'stack') {
    return true
  }
  if (commandType === 'transform' && params.type === 'transform') {
    return EXPENSIVE_TRANSFORMS.has(params.transformationType)
  }
  return false
}
```

Remove the local `EXPENSIVE_OPERATIONS` set definition.

### Step 2: Add Cast Type Validation

**File:** `src/lib/transformations.ts`

Add new export function `validateCastType()` (after `applyTransformation`):

```typescript
export async function validateCastType(
  tableName: string,
  column: string,
  targetType: string
): Promise<{
  totalRows: number
  successCount: number
  failCount: number
  failurePercentage: number
  sampleFailures: string[]
}>
```

**File:** `src/components/panels/CleanPanel.tsx`

1. Import `validateCastType` from transformations
2. Add state for confirmation dialog
3. Update `handleApply` to call validation before cast_type
4. Add confirmation dialog component (use existing Radix AlertDialog)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | 1. Add `EXPENSIVE_TRANSFORMS` export (single source of truth)<br>2. Add new `validateCastType()` export function |
| `src/lib/timeline-engine.ts` | Import `EXPENSIVE_TRANSFORMS` and use in `isExpensiveOperation()` |
| `src/stores/timelineStore.ts` | Import `EXPENSIVE_TRANSFORMS`, remove local `EXPENSIVE_OPERATIONS` set, update `isExpensiveCommand()` |
| `src/components/panels/CleanPanel.tsx` | Add pre-validation for cast_type with confirmation dialog (warn if failCount > 0) |

---

## Verification

### Test 1: Undo Performance for Rename Column
1. Upload large CSV (100k rows)
2. Apply Standardize Date on a date column
3. Apply Calculate Age on the same column
4. Apply Rename Column on "age" → "food_age"
5. Click Undo
6. **Verify:** Undo completes quickly (< 1 second) instead of replaying Calculate Age

### Test 2: Cast Type Validation Warning (ANY Data Loss)
1. Upload CSV with text column (e.g., "dish_name" with values like "Frying", "Baked")
2. Select Cast Type transformation
3. Select the text column
4. Choose "INTEGER" as target type
5. Click Apply
6. **Verify:** Warning dialog appears showing:
   - Number of rows that will become NULL (e.g., "100,000 values will become NULL")
   - Sample values that cannot be converted
7. Click Cancel → transformation not applied
8. Click Apply Anyway → transformation applied (column becomes NULL as expected)

### Test 3: Cast Type No Warning for Valid Casts
1. Upload CSV with numeric string column (e.g., "123", "456", no text values)
2. Select Cast Type → INTEGER
3. Click Apply
4. **Verify:** No warning shown (failCount = 0), transformation applied successfully

### Test 4: Cast Type Warning Even for Low Failure Rates
1. Upload CSV with mostly numeric values but 1 text value (e.g., "123", "456", "N/A")
2. Select Cast Type → INTEGER
3. Click Apply
4. **Verify:** Warning dialog appears (even though only 1 value fails)

```bash
npm run lint
npm test -- --grep "cast_type"
npm test -- --grep "undo"
```

---

## Trade-offs Considered

### Snapshot Strategy

| Alternative | Pros | Cons | Decision |
|-------------|------|------|----------|
| Fixed intervals | Simple, predictable | Wastes storage, may miss expensive ops | Rejected |
| Before EVERY transform | Instant undo always | Massive storage overhead | Rejected |
| **Mark expensive transforms** | Targeted, efficient storage | Slightly more logic | **Chosen** |

### Cast Type Warning Threshold

| Threshold | Pros | Cons | Decision |
|-----------|------|------|----------|
| 50%+ failures | Fewer interruptions | 40% data loss proceeds silently | Rejected |
| 25%+ failures | Balance warning/UX | Still allows data loss | Rejected |
| **failCount > 0** | No silent data loss | More dialogs for edge cases | **Chosen** |

The user emphasized that even 1% data loss is critical in regulated industries. The dialog clearly shows what will happen and lets users proceed if intended.
