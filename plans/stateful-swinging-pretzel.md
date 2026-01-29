# Fix: Combined Stack/Join Tables Missing `_cs_id` Column

## Problem Summary

When using the Combiner to stack or join tables, the resulting table is missing the `_cs_id` column. This causes the DataGrid to fail with:

```
Binder Error: Referenced column "_cs_id" not found in FROM clause!
```

The DataGrid uses `_cs_id` for:
- Keyset pagination (`ORDER BY "_cs_id"`)
- Cell editing (locating rows by stable ID)
- Row highlighting

## Root Cause

Both `stackTables()` and `joinTables()` in `src/lib/combiner-engine.ts` create result tables without generating the `_cs_id` column using `ROW_NUMBER()`.

**Current stackTables (lines 82-87):**
```sql
CREATE OR REPLACE TABLE "result" AS
SELECT col1, col2, ... FROM "tableA"
UNION ALL
SELECT col1, col2, ... FROM "tableB"
```

**Expected:**
```sql
CREATE OR REPLACE TABLE "result" AS
SELECT ROW_NUMBER() OVER () as "_cs_id", *
FROM (
  SELECT col1, col2, ... FROM "tableA"
  UNION ALL
  SELECT col1, col2, ... FROM "tableB"
)
```

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/combiner-engine.ts` | Fix `stackTables()` and `joinTables()` to add `_cs_id` |
| `src/features/combiner/components/StackPanel.tsx` | Validate button stays visible, turns green |
| `src/features/combiner/components/JoinPanel.tsx` | Same validate button fix |
| `e2e/tests/combiner-csid.spec.ts` | New test file for `_cs_id` regression |

## Implementation Plan

### 1. Create Failing E2E Test

Create `e2e/tests/combiner-csid.spec.ts`:

```typescript
test.describe('Combiner _cs_id column', () => {
  test('stack operation should include _cs_id column', async () => {
    // Upload two small CSV files
    // Open combiner panel
    // Stack the tables
    // Verify _cs_id column exists via SQL query
    // Verify grid displays correctly (no gray/error state)
  })

  test('join operation should include _cs_id column', async () => {
    // Similar test for join
  })
})
```

### 2. Fix `stackTables()` in combiner-engine.ts

```typescript
export async function stackTables(
  tableA: string,
  tableB: string,
  resultName: string
): Promise<{ rowCount: number }> {
  return withDuckDBLock(async () => {
    const colsA = await getTableColumns(tableA)
    const colsB = await getTableColumns(tableB)

    // Get all unique column names, excluding _cs_id
    const allColNames = [
      ...new Set([...colsA.map((c) => c.name), ...colsB.map((c) => c.name)]),
    ].filter(col => col !== CS_ID_COLUMN)

    const namesA = new Set(colsA.map((c) => c.name))
    const namesB = new Set(colsB.map((c) => c.name))

    // Build SELECT for table A (user columns only)
    const selectA = allColNames
      .map((col) => (namesA.has(col) ? `"${col}"` : `NULL as "${col}"`))
      .join(', ')

    // Build SELECT for table B (user columns only)
    const selectB = allColNames
      .map((col) => (namesB.has(col) ? `"${col}"` : `NULL as "${col}"`))
      .join(', ')

    // Execute UNION ALL with regenerated _cs_id
    await execute(`
      CREATE OR REPLACE TABLE "${resultName}" AS
      SELECT ROW_NUMBER() OVER () as "${CS_ID_COLUMN}", ${allColNames.map(c => `"${c}"`).join(', ')}
      FROM (
        SELECT ${selectA} FROM "${tableA}"
        UNION ALL
        SELECT ${selectB} FROM "${tableB}"
      )
    `)

    // Get row count
    const countResult = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${resultName}"`
    )
    const rowCount = Number(countResult[0].count)

    return { rowCount }
  })
}
```

### 3. Fix `joinTables()` in combiner-engine.ts

```typescript
export async function joinTables(
  leftTable: string,
  rightTable: string,
  keyColumn: string,
  joinType: JoinType,
  resultName: string
): Promise<{ rowCount: number }> {
  return withDuckDBLock(async () => {
    const colsL = await getTableColumns(leftTable)
    const colsR = await getTableColumns(rightTable)

    // Get non-key, non-internal columns from right table
    const leftColNames = new Set(colsL.map((c) => c.name))
    const rightOnlyCols = colsR.filter(
      (c) => c.name !== keyColumn &&
             !leftColNames.has(c.name) &&
             c.name !== CS_ID_COLUMN
    )

    // Build SELECT clause (exclude _cs_id from source tables)
    const leftSelect = colsL
      .filter(c => c.name !== CS_ID_COLUMN)
      .map((c) => `l."${c.name}"`)
      .join(', ')
    const rightSelect = rightOnlyCols.map((c) => `r."${c.name}"`).join(', ')
    const selectClause =
      rightSelect.length > 0 ? `${leftSelect}, ${rightSelect}` : leftSelect

    // Map join type to SQL
    const joinTypeMap: Record<JoinType, string> = {
      left: 'LEFT JOIN',
      inner: 'INNER JOIN',
      full_outer: 'FULL OUTER JOIN',
    }
    const sqlJoinType = joinTypeMap[joinType]

    // Execute join with regenerated _cs_id
    await execute(`
      CREATE OR REPLACE TABLE "${resultName}" AS
      SELECT ROW_NUMBER() OVER () as "${CS_ID_COLUMN}", *
      FROM (
        SELECT ${selectClause}
        FROM "${leftTable}" l
        ${sqlJoinType} "${rightTable}" r ON l."${keyColumn}" = r."${keyColumn}"
      )
    `)

    // Get row count
    const countResult = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${resultName}"`
    )
    const rowCount = Number(countResult[0].count)

    return { rowCount }
  })
}
```

### 4. Import `CS_ID_COLUMN` constant

Add import at top of `combiner-engine.ts`:
```typescript
import { query, execute, getTableColumns, CS_ID_COLUMN } from '@/lib/duckdb'
```

## UX Fix: Validate Button Behavior

**Problem:** The validate button disappears after clicking. User wants it to stay visible and turn green.

**Current behavior (StackPanel.tsx:195-199):**
```tsx
{stackTableIds.length === 2 && !stackValidation && (
  <Button variant="outline" onClick={handleValidate}>
    Validate Compatibility
  </Button>
)}
```

**New behavior:**
- Button stays visible after validation
- Changes to green with checkmark icon when validated
- Reverts to default state when user changes table selection

### Files to Modify

| File | Change |
|------|--------|
| `src/features/combiner/components/StackPanel.tsx` | Keep button visible, change style on validation |
| `src/features/combiner/components/JoinPanel.tsx` | Same fix for consistency |

### Implementation

**StackPanel.tsx (around line 195):**
```tsx
{/* Validate Button - stays visible, changes style when validated */}
{stackTableIds.length === 2 && (
  <Button
    variant={stackValidation ? 'default' : 'outline'}
    className={stackValidation ? 'bg-green-600 hover:bg-green-700' : ''}
    onClick={handleValidate}
  >
    {stackValidation ? (
      <>
        <Check className="w-4 h-4 mr-2" />
        Validated
      </>
    ) : (
      'Validate Compatibility'
    )}
  </Button>
)}
```

Add `Check` import from lucide-react at top of file.

**JoinPanel.tsx (around line 276):**
Same pattern for the "Validate Join" button.

## Verification

1. **Run failing test first:**
   ```bash
   npm run test -- --grep "combiner-csid"
   ```

2. **Apply fix and re-run test:**
   ```bash
   npm run test -- --grep "combiner-csid"
   ```

3. **Manual verification - Bug fix:**
   - Load two CSV files
   - Open Combiner panel
   - Stack the tables
   - Verify grid displays data (not gray)
   - Verify you can scroll, edit cells, and use pagination

4. **Manual verification - UX fix:**
   - Open Combiner panel with two tables
   - Click "Validate Compatibility"
   - Verify button turns green and shows "Validated" with checkmark
   - Change table selection
   - Verify button reverts to default "Validate Compatibility"

5. **Run full test suite:**
   ```bash
   npm run test
   ```
