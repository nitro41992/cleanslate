/**
 * Insert Row Command
 *
 * Inserts a new empty row into a table.
 * Tier 3 - Requires snapshot for undo.
 */

import type {
  Command,
  CommandContext,
  CommandType,
  ValidationResult,
  ExecutionResult,
  AuditInfo,
  InvertibilityInfo,
  TransformAuditDetails,
} from '../types'
import { generateId } from '@/lib/utils'
import { quoteColumn, quoteTable } from '../utils/sql'
import { getConnection, CS_ORIGIN_ID_COLUMN } from '@/lib/duckdb'

export interface InsertRowParams {
  tableId: string
  tableName: string
  /** Insert after this row's _cs_id, or null for end of table */
  insertAfterCsId?: string | null
}

export class InsertRowCommand implements Command<InsertRowParams> {
  readonly id: string
  readonly type: CommandType = 'data:insert_row'
  readonly label: string = 'Insert Row'
  readonly params: InsertRowParams
  private newCsId: string | null = null

  constructor(id: string | undefined, params: InsertRowParams) {
    this.id = id || generateId()
    this.params = params
  }

  /**
   * Get the generated _cs_id for the inserted row.
   * Only available after execute() has been called.
   */
  getNewCsId(): string | null {
    return this.newCsId
  }

  async validate(ctx: CommandContext): Promise<ValidationResult> {
    // Check table exists
    const exists = await ctx.db.tableExists(ctx.table.name)
    if (!exists) {
      return {
        isValid: false,
        errors: [{ code: 'TABLE_NOT_FOUND', message: `Table ${ctx.table.name} not found` }],
        warnings: [],
      }
    }

    // If insertAfterCsId is specified, verify it exists
    if (this.params.insertAfterCsId) {
      const rowExists = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(ctx.table.name)} WHERE "_cs_id" = '${this.params.insertAfterCsId}'`
      )
      if (Number(rowExists[0]?.count ?? 0) === 0) {
        return {
          isValid: false,
          errors: [
            {
              code: 'ROW_NOT_FOUND',
              message: `Row with _cs_id "${this.params.insertAfterCsId}" not found`,
              field: 'insertAfterCsId',
            },
          ],
          warnings: [],
        }
      }
    }

    return { isValid: true, errors: [], warnings: [] }
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name

    try {
      const conn = await getConnection()
      const { insertAfterCsId } = this.params

      // Determine the position for the new row
      // Row order is determined by _cs_id when displaying (ORDER BY _cs_id)
      let newCsIdNum: number

      if (insertAfterCsId === null || insertAfterCsId === undefined) {
        // Insert at the beginning: shift all rows and use _cs_id = 1
        await conn.query(
          `UPDATE ${quoteTable(tableName)} SET "_cs_id" = CAST(CAST("_cs_id" AS INTEGER) + 1 AS VARCHAR)`
        )
        newCsIdNum = 1
      } else {
        // Insert after the specified row
        // First, get the _cs_id as integer
        const afterIdNum = parseInt(insertAfterCsId, 10)

        // Shift all rows with _cs_id > afterIdNum to make room
        await conn.query(
          `UPDATE ${quoteTable(tableName)} SET "_cs_id" = CAST(CAST("_cs_id" AS INTEGER) + 1 AS VARCHAR) WHERE CAST("_cs_id" AS INTEGER) > ${afterIdNum}`
        )

        // New row goes right after the reference row
        newCsIdNum = afterIdNum + 1
      }

      this.newCsId = String(newCsIdNum)

      // Generate a new UUID for the origin ID (stable identity for diff tracking)
      const newOriginId = crypto.randomUUID()

      // Get all user columns (excluding internal columns) for the INSERT
      // NOTE: We do NOT modify existing rows' _cs_origin_id - only set it for the new row
      const userColumns = ctx.table.columns.filter((c) =>
        c.name !== '_cs_id' && c.name !== CS_ORIGIN_ID_COLUMN
      )

      // Check if table has _cs_origin_id column by querying the database directly
      // (ctx.table.columns excludes internal columns, so we can't rely on it)
      const originIdCheck = await ctx.db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM information_schema.columns
         WHERE table_name = '${tableName}' AND column_name = '${CS_ORIGIN_ID_COLUMN}'`
      )
      const hasOriginId = Number(originIdCheck[0]?.cnt ?? 0) > 0

      const columnNames = hasOriginId
        ? ['_cs_id', CS_ORIGIN_ID_COLUMN, ...userColumns.map((c) => c.name)]
        : ['_cs_id', ...userColumns.map((c) => c.name)]

      const columnValues = hasOriginId
        ? [`'${this.newCsId}'`, `'${newOriginId}'`, ...userColumns.map(() => 'NULL')]
        : [`'${this.newCsId}'`, ...userColumns.map(() => 'NULL')]

      // Insert the new row with its own _cs_origin_id
      // CRITICAL: Existing rows' _cs_origin_id are NOT modified (they keep their original UUIDs)
      await ctx.db.execute(
        `INSERT INTO ${quoteTable(tableName)} (${columnNames.map(quoteColumn).join(', ')}) VALUES (${columnValues.join(', ')})`
      )

      // Get updated row count
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns: ctx.table.columns,
        affected: 1,
        newColumnNames: [],
        droppedColumnNames: [],
        // Return inserted row info for local state injection (no reload needed)
        insertedRow: {
          csId: this.newCsId!,
          rowIndex: newCsIdNum - 1, // 0-based index
        },
      }
    } catch (error) {
      return {
        success: false,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected: 0,
        newColumnNames: [],
        droppedColumnNames: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 3,
      undoStrategy: 'Snapshot restore - row will be removed on undo',
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    if (this.newCsId) {
      return `"_cs_id" = '${this.newCsId}'`
    }
    return null
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const details: TransformAuditDetails = {
      type: 'transform',
      transformationType: 'insert_row',
      params: {
        insertAfterCsId: this.params.insertAfterCsId,
        newCsId: this.newCsId,
      },
    }

    return {
      action: 'Insert Row',
      details,
      affectedColumns: [],
      rowsAffected: result.affected,
      hasRowDetails: false,
      auditEntryId: this.id,
      isCapped: false,
    }
  }
}
