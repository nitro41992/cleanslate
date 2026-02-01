/**
 * Delete Row Command
 *
 * Deletes one or more rows from a table.
 * Tier 3 - Requires snapshot for undo (row data is lost).
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
import { quoteTable } from '../utils/sql'

export interface DeleteRowParams {
  tableId: string
  tableName: string
  /** Row identifiers (_cs_id) to delete */
  csIds: string[]
}

export class DeleteRowCommand implements Command<DeleteRowParams> {
  readonly id: string
  readonly type: CommandType = 'data:delete_row'
  readonly label: string = 'Delete Row'
  readonly params: DeleteRowParams

  constructor(id: string | undefined, params: DeleteRowParams) {
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

    // Check at least one row to delete
    if (!this.params.csIds || this.params.csIds.length === 0) {
      return {
        isValid: false,
        errors: [{ code: 'NO_ROWS_SELECTED', message: 'No rows selected for deletion', field: 'csIds' }],
        warnings: [],
      }
    }

    // Check all rows exist
    const idList = this.params.csIds.map((id) => `'${id}'`).join(', ')
    const existingRows = await ctx.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${quoteTable(ctx.table.name)} WHERE "_cs_id" IN (${idList})`
    )
    const existingCount = Number(existingRows[0]?.count ?? 0)

    if (existingCount !== this.params.csIds.length) {
      return {
        isValid: false,
        errors: [
          {
            code: 'ROWS_NOT_FOUND',
            message: `Some rows do not exist (found ${existingCount} of ${this.params.csIds.length})`,
            field: 'csIds',
          },
        ],
        warnings: [],
      }
    }

    // Warn if deleting all rows
    if (this.params.csIds.length === ctx.table.rowCount) {
      return {
        isValid: true,
        errors: [],
        warnings: [
          {
            code: 'DELETE_ALL_ROWS',
            message: 'This will delete all rows in the table.',
            requiresConfirmation: true,
          },
        ],
      }
    }

    return { isValid: true, errors: [], warnings: [] }
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name

    try {
      // Build IN clause for deletion
      const idList = this.params.csIds.map((id) => `'${id}'`).join(', ')

      // Delete the rows
      await ctx.db.execute(
        `DELETE FROM ${quoteTable(tableName)} WHERE "_cs_id" IN (${idList})`
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
        affected: this.params.csIds.length,
        newColumnNames: [],
        droppedColumnNames: [],
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
      undoStrategy: 'Snapshot restore - deleted rows will be recovered on undo',
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // Rows are deleted, so no predicate makes sense for highlighting
    // The predicate would be used before execution to identify affected rows
    const idList = this.params.csIds.map((id) => `'${id}'`).join(', ')
    return `"_cs_id" IN (${idList})`
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const details: TransformAuditDetails = {
      type: 'transform',
      transformationType: 'delete_row',
      params: {
        rowCount: this.params.csIds.length,
        csIds: this.params.csIds,
      },
    }

    return {
      action: this.params.csIds.length === 1 ? 'Delete Row' : `Delete ${this.params.csIds.length} Rows`,
      details,
      affectedColumns: [],
      rowsAffected: result.affected,
      hasRowDetails: false,
      auditEntryId: this.id,
      isCapped: false,
    }
  }
}
