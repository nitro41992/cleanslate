# Plan: Dynamic Row Numbers in Diff Grid

## Problem

The diff grid displays **stale row numbers** captured at diff creation time. When the table is modified after the diff is created (rows inserted/deleted), the displayed row numbers become incorrect.

**Example:**
- Modify row 20, then insert a row at position 10 → diff shows "20" but should show "21"
- Delete a row above row 20 → diff shows "20" but should show "19"

## Solution

Compute current row numbers **at display time** by adding a CTE to the pagination queries. The diff already JOINs to the target table during pagination, so we add one more JOIN to get fresh row positions.

**For deleted rows:** Show "-" (no current position exists)

## Implementation

### File: `src/lib/diff-engine.ts`

#### 1. Update `fetchDiffPage()` - In-memory path (lines 1092-1104)

```sql
-- Before (stale)
SELECT d.diff_status, d.row_id, d.b_row_num, ...

-- After (current)
WITH b_current_rows AS (
  SELECT "_cs_id", ROW_NUMBER() OVER () as current_row_num
  FROM "${targetTableName}"
)
SELECT
  d.diff_status,
  d.row_id,
  b_nums.current_row_num as b_row_num,
  ${selectCols}
FROM "${tempTableName}" d
LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
LEFT JOIN b_current_rows b_nums ON d.b_row_id = b_nums."_cs_id"
WHERE d.diff_status IN ('added', 'removed', 'modified')
ORDER BY d.sort_key
LIMIT ${limit} OFFSET ${offset}
```

#### 2. Update `fetchDiffPage()` - Chunked Parquet path (lines 1029-1041)

Same CTE pattern as above, with `read_parquet('${tempTableName}_part_*.parquet')` as the source.

#### 3. Update `fetchDiffPage()` - Single Parquet path (lines 1068-1080)

Same CTE pattern as above, with `read_parquet('${tempTableName}.parquet')` as the source.

#### 4. Update `fetchDiffPageWithKeyset()` (lines 1266-1278)

```sql
WITH b_current_rows AS (
  SELECT "_cs_id", ROW_NUMBER() OVER () as current_row_num
  FROM "${targetTableName}"
)
SELECT
  d.diff_status,
  d.row_id,
  d.sort_key,
  b_nums.current_row_num as b_row_num,
  ${selectCols}
FROM "${tempTableName}" d
LEFT JOIN ${sourceTableExpr} a ON d.a_row_id = a."_cs_id"
LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
LEFT JOIN b_current_rows b_nums ON d.b_row_id = b_nums."_cs_id"
WHERE ${whereClause}
ORDER BY d.sort_key ${orderDirection}
LIMIT ${limit}
```

#### 5. Update `materializeDiffForPagination()` view (lines 1510-1521)

```sql
CREATE VIEW "${viewTableName}" AS
WITH b_current_rows AS (
  SELECT "_cs_id", ROW_NUMBER() OVER () as current_row_num
  FROM "${targetTableName}"
)
SELECT
  idx.diff_status,
  idx.row_id,
  idx.sort_key,
  b_nums.current_row_num as b_row_num,
  ${selectCols}
FROM "${indexTableName}" idx
LEFT JOIN ${sourceTableExpr} a ON idx.a_row_id = a."_cs_id"
LEFT JOIN "${targetTableName}" b ON idx.b_row_id = b."_cs_id"
LEFT JOIN b_current_rows b_nums ON idx.b_row_id = b_nums."_cs_id"
```

### No Changes Needed

- **`VirtualizedDiffGrid.tsx`** - Already handles `b_row_num` correctly (shows "-" when null)
- **`DiffRow` interface** - Field type unchanged (`number | null`)

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Row deleted after diff created | `b_row_num` = NULL → shows "-" |
| Row inserted above a modified row | Row number increases by 1 |
| Row deleted above a modified row | Row number decreases by 1 |
| Target table completely replaced | All rows show "-" (no matches) |

## Verification

1. **Manual test:**
   - Open a CSV, make some edits
   - Open diff view, note row numbers
   - Insert a row at row 5
   - Verify all rows below 5 show +1 in their row numbers

2. **E2E test** (optional, can be added later):
   - Create diff after modification
   - Insert row
   - Verify diff row numbers updated
