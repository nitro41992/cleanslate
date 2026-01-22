# Plan: Robust Audit Logging & Custom SQL - Final Architecture

## Executive Summary

- **Performance**: Replace slow JavaScript loops with single SQL Bulk Insert (UNION ALL)
- **Data Policy**: Implement "Cap, Don't Skip" - always capture up to 50k rows instead of skipping entirely
- **Export**: Export CSV dumps full stored records; UI uses pagination
- **Consistency**: Apply "Cap, Don't Skip" logic to ALL transformations (Standard & Custom SQL)

---

## Problems

1. Custom SQL has no row-level audit ("0 rows affected")
2. Large transforms (>10k rows) currently skip audit generation entirely
3. Performance risk: Looping through diff results in JS causes UI freezes

---

## Solution

### 1. Custom SQL Engine (Snapshot + Diff)

- **Mechanism**: Create snapshot → Execute SQL → Run Diff Engine
- **Capture**: Single Bulk SQL Insert to populate `_audit_details` from diff table

### 2. "Cap, Don't Skip" Strategy (All Transforms)

- **Threshold**: Increase `ROW_DETAIL_THRESHOLD` to 50,000
- **Logic**:
  - Custom SQL: Insert all diffs `LIMIT 50000`
  - Standard Transforms: Run `INSERT INTO ... SELECT ... LIMIT 50000`
- **Benefit**: Users always get sample data, even for massive changes

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | 1. Add single quote hint 2. Update threshold to 50k 3. Implement `captureCustomSqlDetails` with Bulk Insert 4. Remove "Skip > 10k" logic from `captureRowDetails` 5. Add LIMIT to all standard audit inserts 6. Add `isCapped` to return type |
| `src/components/common/AuditDetailModal.tsx` | Add banner when audit is capped ("50k rows for performance") |

---

## Implementation

### Step 1: Update Constants & Add Single Quote Hint

**File:** `src/lib/transformations.ts`

```typescript
// Increase limit to 50k (store more data for export)
const ROW_DETAIL_THRESHOLD = 50_000

// Update custom_sql hints (~line 165)
hints: [
  'Column names must be double-quoted: "column_name"',
  'String values use single quotes: \'value\'',
  'Use DuckDB SQL syntax (not MySQL/PostgreSQL)',
  'Click column badges below to copy names',
],
```

### Step 2: Optimized Custom SQL Capture (Bulk Insert)

Add new function after `captureRowDetails()`:

```typescript
/**
 * Capture row-level details for custom SQL using snapshot + diff
 * Uses bulk SQL insert instead of JS loops for performance
 */
async function captureCustomSqlDetails(
  tableName: string,
  beforeSnapshotName: string,
  auditEntryId: string
): Promise<{ hasRowDetails: boolean; affected: number }> {
  const { runDiff, fetchDiffPage, cleanupDiffTable } = await import('./diff-engine')

  // Run diff comparing current table to before snapshot
  const diffConfig = await runDiff(tableName, beforeSnapshotName, [CS_ID_COLUMN])

  const { modified, added, removed } = diffConfig.summary
  const totalAffected = modified + added + removed

  // Skip if no changes
  if (totalAffected === 0) {
    await cleanupDiffTable(diffConfig.diffTableName)
    return { hasRowDetails: false, affected: 0 }
  }

  // Ensure audit details table exists
  await ensureAuditDetailsTable()

  // Get user columns (exclude _cs_id)
  const userCols = diffConfig.allColumns.filter(c => c !== CS_ID_COLUMN)

  // Chunk columns to avoid SQL parser limits (max ~20 per query)
  const chunkSize = 20
  const columnChunks: string[][] = []
  for (let i = 0; i < userCols.length; i += chunkSize) {
    columnChunks.push(userCols.slice(i, i + chunkSize))
  }

  // Bulk insert for each column chunk
  // NOTE: _cs_id is UUID type, but row_index is INTEGER
  // We use row_number() OVER () to generate sequential indices
  for (const chunkCols of columnChunks) {
    const unionParts = chunkCols.map(col => {
      const safeCol = col.replace(/'/g, "''")
      // Select changed rows for this specific column
      return `
        SELECT
          uuid() as id,
          '${auditEntryId}' as audit_entry_id,
          row_number() OVER () as row_index,
          '${safeCol}' as column_name,
          CAST("b_${col}" AS VARCHAR) as previous_value,
          CAST("a_${col}" AS VARCHAR) as new_value,
          CURRENT_TIMESTAMP as created_at
        FROM "${diffConfig.diffTableName}"
        WHERE CAST("a_${col}" AS VARCHAR) IS DISTINCT FROM CAST("b_${col}" AS VARCHAR)
      `
    })

    const bulkSql = `
      INSERT INTO _audit_details
      (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
      ${unionParts.join(' UNION ALL ')}
      LIMIT ${ROW_DETAIL_THRESHOLD}
    `

    await execute(bulkSql)
  }

  // Cleanup diff table
  await cleanupDiffTable(diffConfig.diffTableName)

  // Check how many were actually inserted
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM _audit_details WHERE audit_entry_id = '${auditEntryId}'`
  )
  const insertedCount = Number(countResult[0].count)

  return { hasRowDetails: insertedCount > 0, affected: totalAffected }
}
```

### Step 3: Update custom_sql Case in applyTransformation()

Replace the simple case (~line 1148):

```typescript
case 'custom_sql': {
  const customSql = (step.params?.sql as string) || ''
  if (!customSql.trim()) break

  // Create before-snapshot for diff tracking
  const beforeSnapshotName = `_custom_sql_before_${Date.now()}`
  const { duplicateTable, dropTable } = await import('./duckdb')
  await duplicateTable(tableName, beforeSnapshotName, true)

  try {
    // Execute the custom SQL
    await execute(customSql)

    // Capture changes using diff engine (bulk insert)
    const auditResult = await captureCustomSqlDetails(
      tableName,
      beforeSnapshotName,
      auditEntryId
    )
    hasRowDetails = auditResult.hasRowDetails
    customSqlAffected = auditResult.affected
  } finally {
    // Always cleanup snapshot
    await dropTable(beforeSnapshotName)
  }
  break
}
```

Add variable at start of `applyTransformation()`:
```typescript
let customSqlAffected: number | undefined
```

### Step 4: Update Standard Transforms ("Cap, Don't Skip")

In `captureRowDetails()`, remove the early return that skips large datasets:

```typescript
async function captureRowDetails(
  tableName: string,
  step: TransformationStep,
  auditEntryId: string,
  affectedCount: number
): Promise<boolean> {
  // REMOVE THIS CHECK - we now cap instead of skip:
  // if (affectedCount > ROW_DETAIL_THRESHOLD || affectedCount <= 0 || !step.column) {
  //   return false
  // }

  // NEW: Only skip if truly nothing to capture
  if (affectedCount <= 0 || !step.column) {
    return false
  }

  // ... rest of switch statement ...

  // UPDATE: Add LIMIT to the insert SQL (around line 826)
  const insertSql = `
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
    SELECT
      uuid(),
      '${auditEntryId}',
      rowid,
      '${escapedColumn}',
      CAST(${column} AS VARCHAR),
      ${newValueExpression},
      CURRENT_TIMESTAMP
    FROM "${tableName}"
    WHERE ${whereClause}
    LIMIT ${ROW_DETAIL_THRESHOLD}
  `
  await execute(insertSql)

  // ... rest of function
}
```

### Step 5: Handle Custom SQL Affected Count in Result

After the switch statement, update affected calculation:

```typescript
// Calculate affected rows
let affected: number
if (step.type === 'custom_sql' && customSqlAffected !== undefined) {
  // Use diff-based count for custom SQL
  affected = customSqlAffected
} else if (preCountAffected >= 0) {
  affected = preCountAffected
} else {
  affected = Math.abs(countBefore - countAfter)
}

// Determine if audit was capped
const isCapped = affected > ROW_DETAIL_THRESHOLD
```

### Step 6: Update Return Type and Value

Update `TransformationResult` interface:
```typescript
export interface TransformationResult {
  rowCount: number
  affected: number
  hasRowDetails: boolean
  auditEntryId?: string
  isCapped?: boolean  // NEW: true if affected > threshold
}
```

Update return statement:
```typescript
return {
  rowCount: countAfter,
  affected,
  hasRowDetails,
  auditEntryId: hasRowDetails ? auditEntryId : undefined,
  isCapped,  // NEW
}
```

---

## Verification Checklist

1. **Custom SQL Test**: Run `UPDATE "table" SET "col" = 'test'`
   - Verify drill-down works
   - Verify hints include single quote guidance

2. **Bulk Test**: Run a transform on 20k rows
   - Old behavior: Audit log would be empty
   - New behavior: Audit log should have 20k entries
   - Drill-down should load fast (paginated)
   - Export should have 20k rows

3. **Overflow Test**: Run a transform on 100k rows
   - Result: Audit log has 50k entries (capped)
   - Export has 50k entries
   - UI is responsive

4. Run `npm run lint` to verify no errors

---

## Critical Safeguards

### 1. Snapshot Hygiene (Prevent Disk Quota Exhaustion)
The `finally` block MUST wrap the entire custom SQL logic to ensure snapshot cleanup even on errors:

```typescript
try {
  await execute(customSql)
  const auditResult = await captureCustomSqlDetails(...)
} finally {
  // ALWAYS cleanup - even if captureCustomSqlDetails throws OOM
  try {
    await dropTable(beforeSnapshotName)
  } catch {
    // Ignore cleanup errors, but log them
    console.warn(`Failed to cleanup snapshot: ${beforeSnapshotName}`)
  }
}
```

### 2. UI Pagination Discipline
The `AuditDetailPanel` MUST use SQL-level pagination (LIMIT/OFFSET), not client-side:

```typescript
// In getAuditRowDetails() - already uses LIMIT/OFFSET:
const rows = await query<...>(
  `SELECT ... FROM _audit_details
   WHERE audit_entry_id = '${auditEntryId}'
   ORDER BY row_index
   LIMIT ${limit} OFFSET ${offset}`  // ← SQL pagination, not JS
)
```

**Verify**: Check `src/lib/transformations.ts:getAuditRowDetails()` - it already has pagination. The UI component should call this with reasonable page sizes (e.g., 100 rows per page).

### 3. Communicate the Cap to Users
When audit is capped, show a banner in the UI:

**File:** Update `TransformationResult` interface:
```typescript
export interface TransformationResult {
  rowCount: number
  affected: number
  hasRowDetails: boolean
  auditEntryId?: string
  isCapped?: boolean  // NEW: true if affected > ROW_DETAIL_THRESHOLD
}
```

**File:** In `AuditDetailModal` or similar, show banner:
```tsx
{result.isCapped && (
  <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-2 mb-3">
    <p className="text-xs text-amber-400">
      Audit log capped at 50,000 rows for performance.
      Total affected: {result.affected.toLocaleString()}
    </p>
  </div>
)}
```

---

## Edge Cases Handled

- **No changes**: Returns `affected: 0`, `hasRowDetails: false`
- **Capped changes** (>50k): Captures first 50k, sets `isCapped: true`, returns actual total
- **Schema changes** (ADD/DROP COLUMN): Diff engine handles automatically
- **Row additions/deletions**: Captured via diff `added`/`removed` status
- **Many columns**: Chunked into batches of 20 to avoid SQL parser limits
- **Snapshot cleanup**: Always runs via `finally` block (with nested try/catch)
- **UI freeze prevention**: SQL pagination enforced, never render 50k DOM nodes
- **Type safety**: Uses `row_number() OVER ()` instead of UUID for `row_index INTEGER` column

## Implementation Flow

**Standard Transform** (fast path):
```
UPDATE → INSERT INTO _audit (LIMIT 50k) → Done
```

**Custom SQL** (heavier path - UI busy state required):
```
Snapshot → Execute SQL → Diff → Bulk INSERT (LIMIT 50k) → Cleanup
```

Note: The existing `isApplying` state in CleanPanel already shows a loading spinner during transformation, which covers the Custom SQL path.
