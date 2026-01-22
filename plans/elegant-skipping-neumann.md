# Comprehensive Clean Transforms Audit & Fixes

## User Request

Audit all clean transforms with fine-tooth comb:
1. Does the transform ask the user for the expected input values?
2. Does the transform work as expected?
3. Is the transformation performant at scale?
4. Does the audit log show the change?
5. Is the audit item clickable to show row-level changes?
6. Can I undo/redo the transformation at scale?

**User-reported issues:**
- Filter Empty deletes rows but user wants to **replace** null/empty values
- Rename Column undo leaves the column empty (values missing after undo)

---

## 5-Point Validation Checklist

For each transform, verified:
1. **Inputs** - Does UI prompt for correct parameters?
2. **Logic** - Does SQL produce correct result (including edge cases)?
3. **Performance** - Uses native DuckDB SQL (no data in JS)?
4. **Audit Log** - Human-readable summary via `getTransformationLabel()`?
5. **Drill-Down** - Before/after values via `captureRowDetails()`?

---

## Detailed Transform Audit

### 1. Trim Whitespace
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only (`requiresColumn: true`, no params) |
| Logic | ✅ | `UPDATE SET col = TRIM(col)` - handles nulls |
| Performance | ✅ | Native SQL UPDATE |
| Audit | ✅ | "Trim Whitespace on 'column'" |
| Drill-Down | ✅ | `WHERE col != TRIM(col)`, shows before/after |

### 2. Lowercase
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `UPDATE SET col = LOWER(col)` |
| Performance | ✅ | Native SQL UPDATE |
| Audit | ✅ | "Lowercase on 'column'" |
| Drill-Down | ✅ | `WHERE col != LOWER(col)` |

### 3. Uppercase
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `UPDATE SET col = UPPER(col)` |
| Performance | ✅ | Native SQL UPDATE |
| Audit | ✅ | "Uppercase on 'column'" |
| Drill-Down | ✅ | `WHERE col != UPPER(col)` |

### 4. Find & Replace
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column + `find`, `replace`, `caseSensitive`, `matchType` |
| Logic | ✅ | Handles 4 combinations: exact/contains × case-sensitive/insensitive |
| Performance | ✅ | Native SQL UPDATE with REPLACE/REGEXP_REPLACE |
| Audit | ✅ | "Find & Replace on 'col' (find: X, replace: Y, ...)" |
| Drill-Down | ✅ | Complex WHERE clause per match type |

### 5. Remove Duplicates
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | None - operates on entire table (`requiresColumn: false`) |
| Logic | ✅ | `SELECT DISTINCT` excluding `_cs_id`, regenerates UUIDs |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Remove Duplicates" + affected row count |
| Drill-Down | ❌ | Falls through to `default` in `captureRowDetails()` |

### 6. Filter Empty ⚠️ REPLACING
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `DELETE WHERE col IS NULL OR TRIM(col) = ''` |
| Performance | ✅ | Native SQL DELETE |
| Audit | ✅ | "Filter Empty on 'column'" |
| Drill-Down | ✅ | Shows `<deleted>` for removed rows |
| **ISSUE** | ⚠️ | User wants REPLACE behavior, not DELETE |

### 7. Rename Column ⚠️ UNDO BUG
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column + `newName` (text) |
| Logic | ✅ | `ALTER TABLE RENAME COLUMN` |
| Performance | ✅ | Native SQL ALTER |
| Audit | ✅ | "Rename Column on 'col' (newName: X)" |
| Drill-Down | ❌ | Falls through to `default` (metadata-only, expected) |
| **BUG** | 🐛 | Undo doesn't refresh columns in UI |

### 8. Cast Type
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column + `targetType` (VARCHAR/INTEGER/DOUBLE/DATE/BOOLEAN) |
| Logic | ✅ | `TRY_CAST` - returns NULL on failure |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Cast Type on 'col' (targetType: INTEGER)" |
| Drill-Down | ✅ | All rows captured with casted values |

### 9. Custom SQL
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | `sql` (text) - no column required |
| Logic | ⚠️ | Executes user SQL as-is (no validation) |
| Performance | ✅ | User-provided SQL runs natively |
| Audit | ✅ | "Custom SQL (sql: ...)" |
| Drill-Down | ❌ | Falls through to `default` (can't predict changes) |

### 10. Title Case
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `list_transform` + `list_reduce` for word capitalization |
| Performance | ✅ | Native SQL UPDATE |
| Audit | ✅ | "Title Case on 'column'" |
| Drill-Down | ✅ | Captures transformed values |

### 11. Remove Accents
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `strip_accents(col)` |
| Performance | ✅ | Native SQL UPDATE |
| Audit | ✅ | "Remove Accents on 'column'" |
| Drill-Down | ✅ | `WHERE col != strip_accents(col)` |

### 12. Remove Non-Printable
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `regexp_replace(col, '[\\x00-\\x1F\\x7F]', '', 'g')` |
| Performance | ✅ | Native SQL UPDATE |
| Audit | ✅ | "Remove Non-Printable on 'column'" |
| Drill-Down | ✅ | Same regex comparison |

### 13. Unformat Currency
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | Removes `$`, `,`, space → `TRY_CAST AS DOUBLE` |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Unformat Currency on 'column'" |
| Drill-Down | ✅ | Shows numeric result |

### 14. Fix Negatives
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | `(500.00)` → `-500.00`, handles `$` and `,` |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Fix Negatives on 'column'" |
| Drill-Down | ✅ | Shows negative values |

### 15. Pad Zeros
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column + `length` (number, default: 5) |
| Logic | ✅ | `LPAD(col, length, '0')` only if shorter |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Pad Zeros on 'col' (length: 5)" |
| Drill-Down | ✅ | Shows padded values |

### 16. Standardize Date
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column + `format` (YYYY-MM-DD/MM/DD/YYYY/DD/MM/YYYY) |
| Logic | ✅ | COALESCE with 10 TRY_STRPTIME formats |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Standardize Date on 'col' (format: YYYY-MM-DD)" |
| Drill-Down | ✅ | Same COALESCE pattern for before/after |

### 17. Calculate Age
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only (DOB column) |
| Logic | ⚠️ | Creates `age` column, but uses simple `TRY_CAST` not COALESCE |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Calculate Age on 'column'" |
| Drill-Down | ✅ | Uses COALESCE (fixed in captureRowDetails) |
| **NOTE** | ⚠️ | `applyTransformation` uses `TRY_CAST` while `captureRowDetails` uses COALESCE - may produce different ages for some dates |

### 18. Split Column
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column + `delimiter` (text, default: space) |
| Logic | ✅ | `string_split` with collision handling for column names |
| Performance | ⚠️ | One `query()` to get max parts (small overhead) |
| Audit | ✅ | "Split Column on 'col' (delimiter: ,)" |
| Drill-Down | ❌ | Falls through to `default` (creates new columns) |

### 19. Fill Down
| Check | Status | Details |
|-------|--------|---------|
| Inputs | ✅ | Column only |
| Logic | ✅ | Window function `LAST_VALUE IGNORE NULLS` |
| Performance | ✅ | Native SQL CREATE TABLE AS SELECT |
| Audit | ✅ | "Fill Down on 'column'" |
| Drill-Down | ✅ | Shows filled values |

---

## Summary

| # | Transform | Inputs | Logic | Perf | Audit | Drill-Down | Undo |
|---|-----------|--------|-------|------|-------|------------|------|
| 1 | Trim | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 | Lowercase | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 | Uppercase | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 | Find & Replace | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 | Remove Duplicates | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 6 | **Filter Empty** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | → **Replace with replace_empty** |
| 7 | **Rename Column** | ✅ | ✅ | ✅ | ✅ | ❌ | 🐛 | → **Fix undo to refresh columns** |
| 8 | Cast Type | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 9 | Custom SQL | ✅ | ⚠️ | ✅ | ✅ | ❌ | ✅ |
| 10 | Title Case | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 11 | Remove Accents | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 12 | Remove Non-Printable | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 13 | Unformat Currency | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 14 | Fix Negatives | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 15 | Pad Zeros | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 16 | Standardize Date | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 17 | Calculate Age | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| 18 | Split Column | ✅ | ✅ | ⚠️ | ✅ | ❌ | ✅ |
| 19 | Fill Down | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Legend:** ✅ = Pass, ⚠️ = Minor issue, ❌ = Not applicable / by design, 🐛 = Bug

---

## Critical Issues to Fix

### Issue 1: Rename Column Undo Bug

**Symptom:** After renaming "age" to "food_age" and clicking Undo, the column is empty.

**Root Cause:** Found in `src/components/grid/TimelineScrubber.tsx` lines 44-50:

```typescript
const handleUndo = useCallback(async () => {
  if (!tableId || isReplaying) return
  const newRowCount = await undoTimeline(tableId)
  if (typeof newRowCount === 'number') {
    updateTable(tableId, { rowCount: newRowCount })  // <-- BUG: Only updates rowCount!
  }
}, [tableId, isReplaying, updateTable])
```

**What happens:**
1. User renames "age" → "food_age"
2. DuckDB table now has column "food_age"
3. tableStore.columns = ["food_age", ...]
4. User clicks Undo
5. `undoTimeline()` restores snapshot → DuckDB table now has column "age"
6. BUT: `updateTable({ rowCount })` only updates row count, NOT columns!
7. tableStore.columns still = ["food_age", ...]
8. Grid tries to fetch data for column "food_age" from table that only has "age"
9. Result: Empty column in UI

**Fix:** After undo/redo, also refresh the columns from DuckDB.

**Files to modify:**
- `src/components/grid/TimelineScrubber.tsx` - Update handleUndo/handleRedo/handleReset/handleStepClick
- `src/lib/timeline-engine.ts` - Return columns along with rowCount

---

### Issue 2: Filter Empty Should Replace Values Instead

**Current behavior:** Deletes rows where column is NULL or empty string.

**User wants:** Replace empty/null values with a user-specified value (e.g., "N/A", "Unknown", 0).

**Proposed solution:**
- Rename `filter_empty` to `replace_empty` (or add new transform)
- Add parameter for replacement value
- Use UPDATE instead of DELETE

---

### Issue 3: Calculate Age Logic Mismatch

**Found during audit:** `applyTransformation` uses simple `TRY_CAST` while `captureRowDetails` uses COALESCE with 10 date formats.

**Location:** `src/lib/transformations.ts` lines 972-982

**Current (applyTransformation):**
```sql
DATE_DIFF('year', TRY_CAST("${step.column}" AS DATE), CURRENT_DATE) as age
```

**Should match (like captureRowDetails):**
```sql
DATE_DIFF('year',
  COALESCE(
    TRY_STRPTIME(...'%Y-%m-%d'),
    TRY_STRPTIME(...'%Y%m%d'),
    ... 8 more formats ...
  ),
  CURRENT_DATE) as age
```

**Impact:** Dates like `20250704` will fail `TRY_CAST` but succeed with COALESCE. Audit shows calculated age, but actual column may have NULL.

---

### Issue 4: Transforms Missing Audit Drill-Down (By Design)

These transforms have NO row-level drill-down:

| Transform | Reason | Fix Needed? |
|-----------|--------|-------------|
| remove_duplicates | Deletes rows (which to show?) | NO - by design |
| rename_column | Metadata-only (no row values change) | NO - not applicable |
| custom_sql | Unknown transformation | NO - can't predict |
| split_column | Creates new columns | NO - structural change |

---

## Implementation Plan

### Fix 1: Rename Column Undo Bug (HIGH PRIORITY)

**Architecture Principle:** Make UI a "pure function" of database state. After any undo/redo, refresh columns from DuckDB to ensure UI matches actual table schema.

**Bonus:** This also fixes potential bugs with:
- Split Column (adds columns)
- Cast Type (changes column types)
- Any future schema-changing transforms

---

**File:** `src/lib/timeline-engine.ts`

**Step 1a:** Change `replayToPosition()` return type to include columns:

```typescript
// Change return type
export async function replayToPosition(
  tableId: string,
  targetPosition: number,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[] } | undefined>
```

At the end of `replayToPosition()`, also get columns:

```typescript
// Get row count AND columns for caller to update tableStore
const countResult = await query<{ count: number }>(`SELECT COUNT(*) as count FROM "${tableName}"`)
const columns = await getTableColumns(tableName)
const userColumns = columns.filter(c => c.name !== CS_ID_COLUMN)

return {
  rowCount: Number(countResult[0].count),
  columns: userColumns
}
```

**Step 1b:** Update `undoTimeline()` to return columns:

```typescript
export async function undoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[] } | undefined> {
  // ... existing logic ...

  // replayToPosition now returns { rowCount, columns }
  return await replayToPosition(tableId, targetPosition, onProgress)
}
```

**Step 1c:** Update `redoTimeline()` to return columns:

```typescript
export async function redoTimeline(
  tableId: string,
  onProgress?: (progress: number, message: string) => void
): Promise<{ rowCount: number; columns: ColumnInfo[] } | undefined> {
  // ... existing logic ...

  // replayToPosition now returns { rowCount, columns }
  return await replayToPosition(tableId, targetPosition, onProgress)
}
```

---

**File:** `src/components/grid/TimelineScrubber.tsx`

Update handlers to also update columns:

```typescript
const handleUndo = useCallback(async () => {
  if (!tableId || isReplaying) return
  const result = await undoTimeline(tableId)
  if (result) {
    updateTable(tableId, {
      rowCount: result.rowCount,
      columns: result.columns  // <-- ADD THIS
    })
  }
}, [tableId, isReplaying, updateTable])
```

Apply same fix to: `handleRedo`, `handleReset`, `handleStepClick`

---

### Fix 2: Replace Filter Empty with Replace Empty Transform

**Decision:** Replace `filter_empty` entirely with `replace_empty`

**Step 1:** Update `TRANSFORMATIONS` array in `src/lib/transformations.ts`:

```typescript
// REMOVE this:
{
  id: 'filter_empty',
  label: 'Filter Empty',
  description: 'Remove rows where column is empty',
  icon: '🚫',
  requiresColumn: true,
},

// ADD this:
{
  id: 'replace_empty',
  label: 'Replace Empty',
  description: 'Replace empty/null values with a specified value',
  icon: '🔄',
  requiresColumn: true,
  params: [
    { name: 'replaceWith', type: 'text', label: 'Replace with', default: '' }
  ],
}
```

**Step 2:** Update `src/types/index.ts` TransformationType:

```typescript
// Change 'filter_empty' to 'replace_empty' in the union type
```

**Step 3:** Update transformation logic in `applyTransformation()`:

```typescript
// REMOVE filter_empty case (DELETE logic)

// ADD replace_empty case:
case 'replace_empty': {
  const replaceWith = (step.params?.replaceWith as string) ?? ''
  const escaped = replaceWith.replace(/'/g, "''")
  sql = `
    UPDATE "${tableName}"
    SET "${step.column}" = '${escaped}'
    WHERE "${step.column}" IS NULL OR TRIM(CAST("${step.column}" AS VARCHAR)) = ''
  `
  await execute(sql)
  break
}
```

**Step 4:** Update `countAffectedRows()`:

```typescript
case 'replace_empty': {
  const result = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${column} IS NULL OR TRIM(CAST(${column} AS VARCHAR)) = ''`
  )
  return Number(result[0].count)
}
```

**Step 5:** Update `captureRowDetails()`:

```typescript
case 'replace_empty': {
  const replaceWith = (step.params?.replaceWith as string) ?? ''
  const escaped = replaceWith.replace(/'/g, "''")
  whereClause = `${column} IS NULL OR TRIM(CAST(${column} AS VARCHAR)) = ''`
  newValueExpression = `'${escaped}'`
  break
}
```

**Step 6:** Remove `filter_empty` from expensive operations in `timeline-engine.ts`:
- `filter_empty` was marked expensive because DELETE requires snapshot
- `replace_empty` uses UPDATE (not expensive, no snapshot needed)

---

### Fix 3: Calculate Age COALESCE Alignment

**File:** `src/lib/transformations.ts` lines 972-982

Update `calculate_age` case in `applyTransformation` to use same COALESCE pattern:

```typescript
case 'calculate_age': {
  sql = `
    CREATE OR REPLACE TABLE "${tempTable}" AS
    SELECT *,
           DATE_DIFF('year',
             COALESCE(
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y-%m-%d'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y%m%d'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%m/%d/%Y'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d/%m/%Y'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y/%m/%d'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d-%m-%Y'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%m-%d-%Y'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%Y.%m.%d'),
               TRY_STRPTIME(CAST("${step.column}" AS VARCHAR), '%d.%m.%Y'),
               TRY_CAST("${step.column}" AS DATE)
             ),
             CURRENT_DATE
           ) as age
    FROM "${tableName}"
  `
  await execute(sql)
  await execute(\`DROP TABLE "${tableName}"\`)
  await execute(\`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"\`)
  break
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/timeline-engine.ts` | 1. Change return type of `replayToPosition()` to `{ rowCount, columns }`<br>2. Update `undoTimeline()` return type and pass-through<br>3. Update `redoTimeline()` return type and pass-through<br>4. Remove `filter_empty` from expensive operations list (line ~625) |
| `src/components/grid/TimelineScrubber.tsx` | Update handleUndo/handleRedo/handleReset/handleStepClick to also update columns |
| `src/lib/transformations.ts` | 1. Replace `filter_empty` with `replace_empty` in TRANSFORMATIONS array (lines 68-73)<br>2. Update `applyTransformation()` - remove `filter_empty`, add `replace_empty` case (lines 764-770)<br>3. Update `countAffectedRows()` - change `filter_empty` to `replace_empty` (lines 320-326)<br>4. Update `captureRowDetails()` - change `filter_empty` to `replace_empty` (lines 614-619)<br>5. Fix `calculate_age` to use COALESCE pattern (lines 972-982) |
| `src/types/index.ts` | Change `filter_empty` to `replace_empty` in TransformationType union |

---

## Verification

### Test 1: Rename Column Undo (Bug Fix)
1. Upload CSV with "age" column containing values
2. Apply "Rename Column" to rename "age" → "food_age"
3. Verify column shows as "food_age" with values
4. Click Undo
5. **Verify:** Column is back to "age" WITH all original values visible
6. Click Redo
7. **Verify:** Column is "food_age" again with all values

### Test 2: Replace Empty Transform (New Feature)
1. Upload CSV with some empty values in a column
2. Open Clean panel, select the column
3. Choose "Replace Empty" transform
4. Enter replacement value (e.g., "N/A")
5. Click Apply
6. **Verify:** Empty cells now show "N/A"
7. Check audit log shows count of affected rows
8. Click audit entry for drill-down
9. **Verify:** Shows before (empty) and after ("N/A") values

### Test 3: Replace Empty Undo
1. After Test 2, click Undo
2. **Verify:** Cells are empty again (not "N/A")
3. Redo - cells show "N/A" again

### Test 4: All Other Transforms Still Work
Run through trim, lowercase, uppercase, etc. and verify undo/redo still works.

```bash
npm run lint
npm test -- --grep "FR-A3"
npm test -- --grep "undo"
```

---

## Decisions Made

1. **Filter Empty:** Replace entirely with Replace Empty transform
2. **Remove Duplicates:** No drill-down needed (current behavior is sufficient)
