/**
 * Edit Cell Command
 *
 * Handles single cell edits in the data grid.
 * Tier 2 - Invertible SQL (no snapshot needed, undo via inverse UPDATE).
 */

import type {
  Command,
  CommandContext,
  CommandType,
  ValidationResult,
  ExecutionResult,
  AuditInfo,
  InvertibilityInfo,
  EditAuditDetails,
  CellChange,
} from '../types'
import { generateId } from '@/lib/utils'
import { toSqlValue, quoteColumn, quoteTable } from '../utils/sql'

export interface EditCellParams {
  tableId: string
  tableName: string
  /** Row identifier (_cs_id) */
  csId: string
  /** Column name */
  columnName: string
  /** Value before the edit */
  previousValue: unknown
  /** New value after the edit */
  newValue: unknown
}

export class EditCellCommand implements Command<EditCellParams> {
  readonly id: string
  readonly type: CommandType = 'edit:cell'
  readonly label: string
  readonly params: EditCellParams
  private csOriginId: string | null = null

  constructor(id: string | undefined, params: EditCellParams) {
    this.id = id || generateId()
    this.params = params
    this.label = 'Manual Edit'
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
    const colExists = ctx.table.columns.some((c) => c.name === this.params.columnName)
    if (!colExists) {
      return {
        isValid: false,
        errors: [
          {
            code: 'COLUMN_NOT_FOUND',
            message: `Column ${this.params.columnName} not found`,
            field: 'columnName',
          },
        ],
        warnings: [],
      }
    }

    // Check csId is provided
    if (!this.params.csId) {
      return {
        isValid: false,
        errors: [{ code: 'CSID_REQUIRED', message: 'Row identifier (csId) is required' }],
        warnings: [],
      }
    }

    return { isValid: true, errors: [], warnings: [] }
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = quoteTable(ctx.table.name)
    const columnName = quoteColumn(this.params.columnName)
    const newValue = toSqlValue(this.params.newValue)

    try {
      // Capture _cs_origin_id before the update (stable identity for audit drill-down)
      const originIdResult = await ctx.db.query<{ _cs_origin_id: string }>(
        `SELECT "_cs_origin_id" FROM ${tableName} WHERE "_cs_id" = '${this.params.csId}'`
      )
      this.csOriginId = originIdResult[0]?._cs_origin_id ?? null

      // Execute the update
      await ctx.db.execute(
        `UPDATE ${tableName} SET ${columnName} = ${newValue} WHERE "_cs_id" = '${this.params.csId}'`
      )

      return {
        success: true,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected: 1,
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

  getInverseSql(ctx: CommandContext): string {
    const tableName = quoteTable(ctx.table.name)
    const columnName = quoteColumn(this.params.columnName)
    const previousValue = toSqlValue(this.params.previousValue)
    return `UPDATE ${tableName} SET ${columnName} = ${previousValue} WHERE "_cs_id" = '${this.params.csId}'`
  }

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 2,
      undoStrategy: 'Restore previous value via UPDATE',
      inverseSql: undefined, // Will be set from context during execution
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    return `"_cs_id" = '${this.params.csId}'`
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const details: EditAuditDetails = {
      type: 'edit',
      cellCount: 1,
      changes: [
        {
          rowId: this.params.csId,
          column: this.params.columnName,
          before: this.params.previousValue,
          after: this.params.newValue,
        },
      ],
    }

    return {
      action: 'Edit Cell',
      details,
      affectedColumns: [this.params.columnName],
      rowsAffected: result.affected,
      hasRowDetails: true,
      auditEntryId: this.id,
      isCapped: false,
    }
  }

  /**
   * Get cell changes for dirty cell tracking
   */
  getCellChanges(): CellChange[] {
    return [
      {
        csId: this.params.csId,
        csOriginId: this.csOriginId ?? undefined,
        columnName: this.params.columnName,
        previousValue: this.params.previousValue,
        newValue: this.params.newValue,
      },
    ]
  }
}
