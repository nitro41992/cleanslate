# Fix: data:insert_row replay failure after page refresh

## Problem
When a user adds a row and refreshes the page, the timeline replay fails with:
```
Unknown transformation: data:insert_row
```

### Root Cause
The `data:insert_row` command is not properly handled during timeline replay:

1. **Mapping issue**: In `executor.ts`, `mapToLegacyCommandType()` maps `data:insert_row` to `'transform'` (default case)
2. **Replay failure**: In `timeline-engine.ts`, `applyCommand()` routes it to `applyTransformCommand()` → `applyTransformation()`
3. **Missing case**: `transformations.ts` has no case for `'data:insert_row'`, throwing "Unknown transformation"

Same issue affects `data:delete_row`.

## Solution
Add proper handling for `data:*` commands in the timeline system.

### Files to Modify

#### 1. `src/types/index.ts`
Add `'data'` to `TimelineCommandType` union:
```typescript
export type TimelineCommandType =
  | 'transform'
  | 'manual_edit'
  | 'merge'
  | 'standardize'
  | 'stack'
  | 'join'
  | 'batch_edit'
  | 'scrub'
  | 'data'  // NEW: for insert_row, delete_row
```

Add `DataParams` interface:
```typescript
export interface DataParams {
  type: 'data'
  dataOperation: 'insert_row' | 'delete_row'
  insertAfterCsId?: string | null  // for insert_row
  newCsId?: string                  // for insert_row (captured after execution)
  csIds?: string[]                  // for delete_row
}
```

Update `TimelineParams` union to include `DataParams`.

#### 2. `src/lib/commands/executor.ts`
Update `mapToLegacyCommandType()` (~line 1393):
```typescript
if (commandType.startsWith('data:')) return 'data'
```

Update `syncExecuteToTimelineStore()` (~line 1650) to handle `data:*` commands:
```typescript
} else if (command.type === 'data:insert_row') {
  const insertParams = command.params as InsertRowParams & { newCsId?: string }
  timelineParams = {
    type: 'data',
    dataOperation: 'insert_row',
    insertAfterCsId: insertParams.insertAfterCsId,
    newCsId: (command as InsertRowCommand).getNewCsId?.() || insertParams.newCsId,
  } as DataParams
} else if (command.type === 'data:delete_row') {
  const deleteParams = command.params as DeleteRowParams
  timelineParams = {
    type: 'data',
    dataOperation: 'delete_row',
    csIds: deleteParams.csIds,
  } as DataParams
}
```

#### 3. `src/lib/commands/data/insert-row.ts`
Add getter for the generated `newCsId` (for replay):
```typescript
getNewCsId(): string | null {
  return this.newCsId
}
```

#### 4. `src/lib/timeline-engine.ts`
Add case in `applyCommand()` (~line 622):
```typescript
case 'data':
  await applyDataCommand(tableName, params as DataParams)
  break
```

Add `applyDataCommand()` function:
```typescript
async function applyDataCommand(
  tableName: string,
  params: DataParams
): Promise<void> {
  const conn = await getConnection()

  if (params.dataOperation === 'insert_row') {
    // Re-execute insert row logic
    const { insertAfterCsId, newCsId } = params

    if (insertAfterCsId === null || insertAfterCsId === undefined) {
      // Insert at beginning: shift all rows
      await conn.query(`UPDATE "${tableName}" SET "_cs_id" = CAST(CAST("_cs_id" AS INTEGER) + 1 AS VARCHAR)`)
    } else {
      // Insert after specified row
      const afterIdNum = parseInt(insertAfterCsId, 10)
      await conn.query(`UPDATE "${tableName}" SET "_cs_id" = CAST(CAST("_cs_id" AS INTEGER) + 1 AS VARCHAR) WHERE CAST("_cs_id" AS INTEGER) > ${afterIdNum}`)
    }

    // Insert new row with NULL values
    // Get columns from table schema
    const cols = await conn.query(`DESCRIBE "${tableName}"`)
    const userColumns = cols.filter(c => c.column_name !== '_cs_id' && c.column_name !== '_cs_origin_id')
    const hasOriginId = cols.some(c => c.column_name === '_cs_origin_id')

    const columnNames = hasOriginId
      ? ['_cs_id', '_cs_origin_id', ...userColumns.map(c => c.column_name)]
      : ['_cs_id', ...userColumns.map(c => c.column_name)]

    const columnValues = hasOriginId
      ? [`'${newCsId}'`, `'${crypto.randomUUID()}'`, ...userColumns.map(() => 'NULL')]
      : [`'${newCsId}'`, ...userColumns.map(() => 'NULL')]

    await conn.query(`INSERT INTO "${tableName}" (${columnNames.map(c => `"${c}"`).join(', ')}) VALUES (${columnValues.join(', ')})`)

  } else if (params.dataOperation === 'delete_row') {
    const { csIds } = params
    if (csIds && csIds.length > 0) {
      const idList = csIds.map(id => `'${id}'`).join(', ')
      await conn.query(`DELETE FROM "${tableName}" WHERE "_cs_id" IN (${idList})`)
    }
  }
}
```

### Verification
1. Upload a CSV file
2. Add a row using the insert row feature
3. Refresh the page
4. Verify the row persists after refresh
5. Use timeline scrubber to undo/redo the insert row operation
6. Repeat for delete row command

### Test Coverage
Consider adding test in `e2e/tests/tier-3-undo-param-preservation.spec.ts` for:
- Insert row → refresh → verify row persists
- Insert row → other Tier 3 op → undo → verify replay works
