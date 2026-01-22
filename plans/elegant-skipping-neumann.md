# Implementation Plan: Fix Audit Capture & Undo/Redo Issues

## Overview

Four issues to fix:
1. **New Value shows `<null>`** - Audit capture uses simpler date parsing than actual transformation
2. **Slow for 100k rows** - JS-based row fetching + batch inserts instead of native SQL
3. **filter_empty has no drill-down** - No case in `captureRowDetails()` for deleted rows
4. **Undo replays previous transforms** - Undoing `filter_empty` re-runs `standardize_date`

---

## Issue 1: Null Values in Audit Details

### Root Cause

The `captureRowDetails()` function for `standardize_date` uses:
```sql
strftime(TRY_CAST(column AS DATE), '%Y-%m-%d')
```

But the actual transformation uses COALESCE with 10 different date formats:
```sql
strftime(COALESCE(
  TRY_STRPTIME(column, '%Y-%m-%d'),
  TRY_STRPTIME(column, '%Y%m%d'),     -- User's format: 20250704
  TRY_STRPTIME(column, '%m/%d/%Y'),
  ... 7 more formats ...
), '%Y-%m-%d')
```

For dates like `20250704`, `TRY_CAST` fails (returns NULL), but `TRY_STRPTIME('%Y%m%d')` succeeds.

### Affected Transformations

| Transform | Audit Expression | Problem |
|-----------|------------------|---------|
| `standardize_date` | `TRY_CAST(col AS DATE)` | Misses YYYYMMDD and other formats |
| `calculate_age` | `TRY_CAST(col AS DATE)` | Same issue |

### Fix

Update audit capture expressions to match the actual transformation logic.

**File:** `src/lib/transformations.ts`, lines 552-568

---

## Issue 2: Performance (100k rows slow)

### Root Cause

Current approach (lines 594-615):
```typescript
// 1. SELECT all affected rows into JS array (100k rows)
const rows = await query<...>(
  `SELECT rowid, prev_val, new_val FROM table WHERE ...`
)

// 2. Loop in JS, batch insert 500 rows at a time (200 INSERTs for 100k)
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE)
  await execute(`INSERT INTO _audit_details VALUES ${batch}`)
}
```

This has two bottlenecks:
1. **Data transfer**: 100k rows from DuckDB WASM → JS memory
2. **200 separate INSERT statements**: Each has parsing/execution overhead

### Optimized Approach

Use native `INSERT INTO ... SELECT`:
```sql
INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
SELECT
  gen_random_uuid(),
  'audit-entry-id',
  rowid,
  'column_name',
  column AS previous_value,
  transform_expression AS new_value,
  CURRENT_TIMESTAMP
FROM table
WHERE affected_condition
LIMIT 100000
```

**Benefits:**
- Single SQL statement (no JS round-trips)
- DuckDB handles all data internally
- ~10x faster per [DuckDB benchmarks](https://duckdb.org/docs/stable/data/insert)

---

## Implementation

### Fix 1: Update `standardize_date` audit expression

**File:** `src/lib/transformations.ts` (around line 552-562)

```typescript
case 'standardize_date': {
  const format = (step.params?.format as string) || 'YYYY-MM-DD'
  const formatMap: Record<string, string> = {
    'YYYY-MM-DD': '%Y-%m-%d',
    'MM/DD/YYYY': '%m/%d/%Y',
    'DD/MM/YYYY': '%d/%m/%Y',
  }
  const strftimeFormat = formatMap[format] || '%Y-%m-%d'
  whereClause = `${column} IS NOT NULL AND TRIM(CAST(${column} AS VARCHAR)) != ''`
  // Use same COALESCE pattern as actual transformation
  newValueExpression = `strftime(
    COALESCE(
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y-%m-%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y%m%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%m/%d/%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%d/%m/%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y/%m/%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%d-%m-%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%m-%d-%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y.%m.%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%d.%m.%Y'),
      TRY_CAST(${column} AS DATE)
    ),
    '${strftimeFormat}'
  )`
  break
}
```

### Fix 2: Update `calculate_age` audit expression

**File:** `src/lib/transformations.ts` (around line 565-568)

```typescript
case 'calculate_age': {
  whereClause = `${column} IS NOT NULL`
  // Use same COALESCE pattern for date parsing
  newValueExpression = `CAST(DATE_DIFF('year',
    COALESCE(
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y-%m-%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y%m%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%m/%d/%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%d/%m/%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y/%m/%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%d-%m-%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%m-%d-%Y'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%Y.%m.%d'),
      TRY_STRPTIME(CAST(${column} AS VARCHAR), '%d.%m.%Y'),
      TRY_CAST(${column} AS DATE)
    ),
    CURRENT_DATE
  ) AS VARCHAR)`
  break
}
```

### Fix 3: Replace JS batching with native INSERT INTO SELECT

**File:** `src/lib/transformations.ts` (around line 591-615)

**Replace:**
```typescript
// Query affected rows with before/after values
const rows = await query<...>(...)
if (rows.length === 0) return false

// Batch insert into _audit_details
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE)
  const values = batch.map((row) => { ... }).join(', ')
  await execute(`INSERT INTO _audit_details (...) VALUES ${values}`)
}
return true
```

**With:**
```typescript
// Use native INSERT INTO ... SELECT for performance
const insertSql = `
  INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value, created_at)
  SELECT
    uuid(),  -- DuckDB native function (not gen_random_uuid)
    '${auditEntryId}',
    rowid,
    '${step.column}',
    CAST(${column} AS VARCHAR),
    ${newValueExpression},
    CURRENT_TIMESTAMP
  FROM "${tableName}"
  WHERE ${whereClause}
  LIMIT ${ROW_DETAIL_THRESHOLD}
`
await execute(insertSql)

// Check if any rows were inserted
const countResult = await query<{ count: number }>(
  `SELECT COUNT(*) as count FROM _audit_details WHERE audit_entry_id = '${auditEntryId}'`
)
return Number(countResult[0].count) > 0
```

---

## Impact Analysis on Other Transforms

| Transform | Current Audit Expression | Status |
|-----------|-------------------------|--------|
| trim | `TRIM(col)` | OK - matches transform |
| lowercase | `LOWER(col)` | OK - matches transform |
| uppercase | `UPPER(col)` | OK - matches transform |
| replace | Complex CASE/REPLACE | OK - matches transform |
| title_case | `list_reduce(...)` | OK - matches transform |
| remove_accents | `strip_accents(col)` | OK - matches transform |
| remove_non_printable | `regexp_replace(...)` | OK - matches transform |
| unformat_currency | `TRY_CAST(REPLACE(...))` | OK - matches transform |
| fix_negatives | `CASE WHEN ... THEN -TRY_CAST(...)` | OK - matches transform |
| pad_zeros | `LPAD(...)` | OK - matches transform |
| **standardize_date** | `TRY_CAST(col AS DATE)` | **FIX NEEDED** |
| **calculate_age** | `TRY_CAST(col AS DATE)` | **FIX NEEDED** |
| fill_down | `LAST_VALUE(...) OVER (...)` | OK - already fixed |
| cast_type | `TRY_CAST(col AS type)` | OK - matches transform |

Only `standardize_date` and `calculate_age` need fixes - both use date parsing that doesn't match the actual transformation.

---

## Issue 3: filter_empty Has No Audit Drill-Down

### Root Cause

`captureRowDetails()` has no case for `filter_empty` - it falls through to `default` which returns `false`.

The challenge: `filter_empty` **DELETES rows**, so we must capture data BEFORE deletion.

### Fix 4: Add filter_empty case to captureRowDetails()

**File:** `src/lib/transformations.ts` (add before the `default` case)

```typescript
case 'filter_empty':
  // Capture rows that WILL BE DELETED (empty/null values)
  // previous_value shows the empty value, new_value shows '<deleted>' for UI clarity
  whereClause = `${column} IS NULL OR TRIM(CAST(${column} AS VARCHAR)) = ''`
  newValueExpression = `'<deleted>'`  // String literal for clear UI display
  break
```

This captures:
- `previous_value`: The empty/null value that caused deletion
- `new_value`: `<deleted>` (clearly indicates row was removed in the UI)

---

## Issue 4: Undo Replays Previous Transformations

### Root Cause

The timeline system uses **replay-based undo**:
1. Restore from nearest snapshot BEFORE target position
2. Replay all commands from that snapshot to target position

**The problem:** When undoing to position 0 (original state), if no snapshot exists at index 0, it:
1. Falls back to the original snapshot (state before ANY transforms)
2. Replays commands[0:0] which includes `standardize_date`

**Timeline state example:**
```
Commands: [0: standardize_date, 1: filter_empty]
Snapshots: { 1: "before filter_empty" }  // No snapshot at index 0!

Undo to position 0:
- getSnapshotBefore(0) → returns original (index -1)
- Replays commands[0:1] → re-runs standardize_date!
```

### Analysis of replayToPosition Logic

From `timeline-engine.ts` lines 322-354:
```typescript
const snapshotIndex = getSnapshotBefore(tableId, targetPosition)
// If snapshotIndex is -1 (original), slice from 0 to targetPosition+1
const commandsToReplay = commands.slice(snapshotIndex + 1, targetPosition + 1)
```

When `targetPosition = 0` and `snapshotIndex = -1`:
- `slice(-1 + 1, 0 + 1)` = `slice(0, 1)` = `[commands[0]]`
- This replays `standardize_date` which is wrong!

### Fix 5: Fix snapshot indexing in recordCommand()

**File:** `src/lib/timeline-engine.ts` (line 595)

**Root Cause Analysis:**
- Snapshot at index N represents state BEFORE command N = state AFTER command N-1
- `getSnapshotBefore(targetIndex)` returns snapshots with index <= targetIndex
- When undoing to position 0 (state after command 0), it looks for snapshot <= 0
- Snapshot[1] (state after command 0) has index 1 > 0, so it's NOT returned
- Falls back to original → replays command 0 (slow!)

**Current code (line 595):**
```typescript
await createStepSnapshot(tableName, timeline.id, currentPosition + 1)
```

After command 0 completes, `currentPosition = 0`. When recording expensive command 1:
- Creates snapshot at `0 + 1 = 1`
- But this represents state after command 0

**Fixed code:**
```typescript
await createStepSnapshot(tableName, timeline.id, currentPosition)
```

Now:
- Creates snapshot at index 0 (which represents current state = after command 0)
- When undoing to position 0, `getSnapshotBefore(0)` finds snapshot[0]
- Uses snapshot directly, NO REPLAY needed!

**Why this is correct:**
- `currentPosition` after command 0 = 0 (state after command 0)
- Snapshot[0] = state at position 0 = state after command 0
- `getSnapshotBefore(0)` returns snapshot[0] ✓
- Restore from snapshot[0], no commands to replay (target = snapshot index)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | 1. Update `standardize_date` audit expression<br>2. Update `calculate_age` audit expression<br>3. Replace JS batching with `INSERT INTO SELECT`<br>4. Add `filter_empty` case to `captureRowDetails()` |
| `src/lib/timeline-engine.ts` | 5. Fix undo replay by creating snapshot at position 0 for first transform |

---

## Verification

### Test 1: Null Values Fixed
1. Upload CSV with dates in YYYYMMDD format (like `20250704`)
2. Apply "Standardize Date" transformation
3. Click audit entry to view details
4. **Verify:** "New Value" shows `2025-07-04` (not `<null>`)

### Test 2: Performance Improvement
1. Upload 100k row CSV
2. Apply "Standardize Date" transformation
3. **Verify:** Transformation completes faster than before
4. Click audit entry - modal should open quickly

### Test 3: Calculate Age Works
1. Upload CSV with dates (YYYYMMDD format)
2. Apply "Calculate Age" transformation
3. Click audit entry
4. **Verify:** Shows actual age values (not `<null>`)

### Test 4: Other Transforms Unaffected
1. Apply trim, lowercase, pad_zeros on test data
2. Verify audit details still show correct before/after values

### Test 5: filter_empty Drill-Down Works
1. Upload CSV with some empty values in a column
2. Apply "Filter Empty" transformation
3. Click audit entry to view details
4. **Verify:** Shows the rows that were deleted (with their empty values)

### Test 6: Undo Does NOT Replay Previous Transforms
1. Upload 100k row CSV
2. Apply "Standardize Date" (wait for completion)
3. Apply "Filter Empty" on another column
4. Click Undo
5. **Verify:** Undo completes quickly (no 100k date re-processing)
6. **Verify:** Data is back to state after standardize_date (before filter_empty)

```bash
npm run lint
npm test -- --grep "FR-A3"
npm test -- --grep "undo"
```

---

## Sources

- [DuckDB INSERT Performance](https://duckdb.org/docs/stable/data/insert) - INSERT INTO SELECT is 10x faster than batch inserts
- [DuckDB Performance Guide](https://duckdb.org/docs/stable/guides/performance/overview)
- [DuckDB WASM Overview](https://duckdb.org/docs/stable/clients/wasm/overview) - Single-threaded by default
