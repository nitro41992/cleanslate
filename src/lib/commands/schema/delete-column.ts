/**
 * Delete Column Command
 *
 * Removes a column from a table.
 * Tier 3 - Requires snapshot for undo (column data is lost).
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

export interface DeleteColumnParams {
  tableId: string
  tableName: string
  columnName: string
}

export class DeleteColumnCommand implements Command<DeleteColumnParams> {
  readonly id: string
  readonly type: CommandType = 'schema:delete_column'
  readonly label: string = 'Delete Column'
  readonly params: DeleteColumnParams

  constructor(id: string | undefined, params: DeleteColumnParams) {
    this.id = id || generateId()
    this.params = params
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

    // Check column exists
    const columnExists = ctx.table.columns.some((c) => c.name === this.params.columnName)
    if (!columnExists) {
      return {
        isValid: false,
        errors: [
          {
            code: 'COLUMN_NOT_FOUND',
            message: `Column "${this.params.columnName}" not found`,
            field: 'columnName',
          },
        ],
        warnings: [],
      }
    }

    // Prevent deleting _cs_id (internal row identifier)
    if (this.params.columnName === '_cs_id') {
      return {
        isValid: false,
        errors: [
          {
            code: 'CANNOT_DELETE_INTERNAL',
            message: 'Cannot delete internal row identifier column',
            field: 'columnName',
          },
        ],
        warnings: [],
      }
    }

    // Warn if this is the last user column (excluding _cs_id)
    const userColumns = ctx.table.columns.filter((c) => c.name !== '_cs_id')
    if (userColumns.length === 1) {
      return {
        isValid: true,
        errors: [],
        warnings: [
          {
            code: 'LAST_COLUMN',
            message: 'This is the last column. Deleting it will leave an empty table.',
            requiresConfirmation: true,
          },
        ],
      }
    }

    return { isValid: true, errors: [], warnings: [] }
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const columnName = this.params.columnName

    try {
      // DuckDB supports ALTER TABLE DROP COLUMN
      await ctx.db.execute(
        `ALTER TABLE ${quoteTable(tableName)} DROP COLUMN ${quoteColumn(columnName)}`
      )

      // Get updated columns
      const columns = await ctx.db.getTableColumns(tableName)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: 0, // No rows modified, just schema
        newColumnNames: [],
        droppedColumnNames: [columnName],
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
      undoStrategy: 'Snapshot restore - column data will be recovered on undo',
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // No rows affected, just schema change
    return null
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const details: TransformAuditDetails = {
      type: 'transform',
      transformationType: 'delete_column',
      column: this.params.columnName,
      params: {},
    }

    return {
      action: 'Delete Column',
      details,
      affectedColumns: [this.params.columnName],
      rowsAffected: result.affected,
      hasRowDetails: false,
      auditEntryId: this.id,
      isCapped: false,
    }
  }
}
