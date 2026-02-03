# Plan: Standardization Command Idempotency

## Problem

Standardization commands (Apply Standardization, Standardize Date) are creating audit log entries even when they don't change any data. This causes:
1. **Audit log noise** - Duplicate "Apply Standardization" and "Standardize Date" entries
2. **Broken undo/redo** - Users cycle through no-op operations that didn't change anything

## Root Cause

The executor already skips audit logging when `affected === 0` (lines 519-538 in `executor.ts`):
```typescript
const hasAffectedRows = executionResult.affected !== undefined && executionResult.affected > 0
if (!skipAudit && hasAffectedRows) {
  // record audit
} else if (!hasAffectedRows) {
  console.log(`[EXECUTOR] Skipping audit log - no rows affected (idempotent operation)`)
}
```

**But the commands aren't returning `affected: 0` when no rows actually change:**

1. **StandardizeApplyCommand** (`src/lib/commands/standardize/apply.ts`):
   - No pre-check before calling `applyStandardization()`
   - `applyStandardization()` calculates `rowsAffected` by summing `mapping.rowCount` (line 356-359), not from actual changed rows

2. **StandardizeDateCommand** (`src/lib/commands/transform/tier3/standardize-date.ts`):
   - Always returns `affected: rowCount` (line 137) - the total row count, not actual changed rows
   - No pre-check for whether dates are already in target format

## Solution

Apply the same idempotency pattern used by Tier 1 transforms:
1. Add pre-check using `IS DISTINCT FROM` before executing
2. Return `affected: 0` early if no rows need changing

### Fix 1: `applyStandardization()` in `standardizer-engine.ts`

**File:** `src/lib/standardizer-engine.ts` (lines 302-379)

Change the UPDATE to use `IS DISTINCT FROM` pattern and count actual changes:

```typescript
// Before (line 344-351):
const sql = `
  UPDATE "${tableName}"
  SET "${columnName}" = CASE
  ${caseWhenClauses}
  ELSE "${columnName}"
  END
  WHERE CAST("${columnName}" AS VARCHAR) IN (${whereValues})
`

// After:
const sql = `
  UPDATE "${tableName}"
  SET "${columnName}" = CASE
  ${caseWhenClauses}
  END
  WHERE CAST("${columnName}" AS VARCHAR) IN (${whereValues})
    AND "${columnName}" IS DISTINCT FROM (CASE
      ${caseWhenClauses}
      ELSE "${columnName}"
      END)
`
```

Then count actual affected rows via a separate query (DuckDB doesn't return affected count from UPDATE):

```typescript
// Before counting with mapping.rowCount (line 356-359):
let totalRowsAffected = 0
for (const mapping of mappings) {
  totalRowsAffected += mapping.rowCount
}

// After: Query actual affected count based on current values matching target values
// (These are rows that were just changed)
const actualAffectedResult = await query<{ count: number }>(`
  SELECT COUNT(*) as count FROM "${tableName}"
  WHERE CAST("${columnName}" AS VARCHAR) IN (${targetValues})
`)
const totalRowsAffected = Number(actualAffectedResult[0]?.count ?? 0)
```

### Fix 2: Add pre-check to `StandardizeApplyCommand`

**File:** `src/lib/commands/standardize/apply.ts`

Add pre-check at the start of `execute()`:

```typescript
async execute(ctx: CommandContext): Promise<ExecutionResult> {
  const tableName = ctx.table.name
  const { column, mappings } = this.params

  try {
    // PRE-CHECK: Use LIMIT 1 to quickly check if ANY row needs changing
    const predicate = await this.getAffectedRowsPredicate(ctx)
    if (predicate) {
      // Also check that the value would actually change (not already the target value)
      const fromValues = mappings.map(m => `'${m.fromValue.replace(/'/g, "''")}'`).join(', ')
      const checkResult = await ctx.db.query<{ exists: number }>(
        `SELECT 1 as exists FROM "${tableName}"
         WHERE CAST("${column}" AS VARCHAR) IN (${fromValues})
         LIMIT 1`
      )

      if (checkResult.length === 0) {
        // No rows match the from-values - idempotent
        return {
          success: true,
          rowCount: ctx.table.rowCount,
          columns: ctx.table.columns,
          affected: 0,
          newColumnNames: [],
          droppedColumnNames: [],
        }
      }
    }

    // ... rest of existing execute logic
  }
}
```

### Fix 3: Add pre-check to `StandardizeDateCommand`

**File:** `src/lib/commands/transform/tier3/standardize-date.ts`

Add pre-check at the start of `execute()`:

```typescript
async execute(ctx: CommandContext): Promise<ExecutionResult> {
  const col = this.params.column
  const tableName = ctx.table.name
  const format = this.params.format ?? 'YYYY-MM-DD'

  // Detect timestamp type early
  const detectedTimestampType = await this.detectTimestampType(ctx)
  const dateExpr = buildDateFormatExpression(col, format, 'text', detectedTimestampType)

  // PRE-CHECK: Use LIMIT 1 to check if ANY row would change
  // Compare current value to what it would become after transformation
  try {
    const checkResult = await ctx.db.query<{ exists: number }>(
      `SELECT 1 as exists FROM ${quoteTable(tableName)}
       WHERE ${quoteColumn(col)} IS NOT NULL
         AND CAST(${quoteColumn(col)} AS VARCHAR) IS DISTINCT FROM (${dateExpr})
       LIMIT 1`
    )

    if (checkResult.length === 0) {
      // All values already in target format - idempotent
      return {
        success: true,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected: 0,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    }
  } catch (err) {
    // If pre-check fails (e.g., complex expression), proceed with transformation
    console.warn('[StandardizeDate] Pre-check failed, proceeding:', err)
  }

  // ... rest of existing execute logic
}
```

Also fix the affected count at the end (line 137):

```typescript
// Before:
affected: rowCount,

// After: Count actual changed rows
const affectedResult = await ctx.db.query<{ count: number }>(
  `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}
   WHERE ${quoteColumn(col)} IS NOT NULL`
)
// For date standardization, affected = non-null values that could be parsed
// But for idempotency, we've already returned early if no changes needed
affected: Number(affectedResult[0]?.count ?? 0),
```

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/standardizer-engine.ts` | Update `applyStandardization()` to use `IS DISTINCT FROM` and count actual changes |
| `src/lib/commands/standardize/apply.ts` | Add pre-check in `execute()` to return `affected: 0` early |
| `src/lib/commands/transform/tier3/standardize-date.ts` | Add pre-check in `execute()` to return `affected: 0` early |

## User Feedback

When a transform is skipped due to idempotency, the user should see:
- **Toast notification**: "No rows affected - values already standardized" (or similar)
- **No audit entry** (existing behavior when `affected: 0`)
- **No timeline entry** (existing behavior when `affected: 0`)

The toast is already shown by the executor - need to verify the message is appropriate.

## Testing

### Manual Testing
1. Apply "Standardize Date" to a date column with format YYYY-MM-DD
2. Apply "Standardize Date" again with same format → Should show "0 rows affected", no audit entry
3. Apply "Apply Standardization" with mappings
4. Apply same standardization again → Should show "0 rows affected", no audit entry

### E2E Test
Add test in `e2e/tests/` to verify idempotency:
```typescript
test('standardize date is idempotent', async () => {
  // Apply standardize date
  // Get audit count
  // Apply standardize date again
  // Verify audit count unchanged
  // Verify "0 rows affected" in result
})
```

## Implementation Order

1. **standardizer-engine.ts** - Fix `applyStandardization()` to use `IS DISTINCT FROM` and count actual changes
2. **apply.ts** - Add pre-check for StandardizeApplyCommand
3. **standardize-date.ts** - Add pre-check for StandardizeDateCommand
4. **Verify** toast message is appropriate for "0 rows affected" case
