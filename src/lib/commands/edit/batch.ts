/**
 * Batch Edit Command
 *
 * Handles multiple cell edits in a single command.
 * Tier 2 - Invertible SQL (no snapshot needed, undo via inverse UPDATEs).
 *
 * Used when users make rapid edits that are batched together to reduce
 * audit log clutter and improve performance.
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

export interface BatchEditChange {
  csId: string
  columnName: string
  previousValue: unknown
  newValue: unknown
}

export interface BatchEditParams {
  tableId: string
  tableName: string
  /** Array of cell changes */
  changes: BatchEditChange[]
}

export class BatchEditCommand implements Command<BatchEditParams> {
  readonly id: string
  readonly type: CommandType = 'edit:batch'
  readonly label: string
  readonly params: BatchEditParams
  private csOriginIdMap: Map<string, string> = new Map()

  constructor(id: string | undefined, params: BatchEditParams) {
    this.id = id || generateId()
    this.params = params
    const count = params.changes.length
    this.label = count === 1 ? 'Manual Edit' : `Batch Edit (${count} cells)`
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

    // Check all columns exist
    const invalidColumns: string[] = []
    for (const change of this.params.changes) {
      const colExists = ctx.table.columns.some((c) => c.name === change.columnName)
      if (!colExists && !invalidColumns.includes(change.columnName)) {
        invalidColumns.push(change.columnName)
      }
    }

    if (invalidColumns.length > 0) {
      return {
        isValid: false,
        errors: [
          {
            code: 'COLUMN_NOT_FOUND',
            message: `Columns not found: ${invalidColumns.join(', ')}`,
            field: 'columnName',
          },
        ],
        warnings: [],
      }
    }

    // Check all csIds are provided
    const missingCsIds = this.params.changes.filter((c) => !c.csId)
    if (missingCsIds.length > 0) {
      return {
        isValid: false,
        errors: [{ code: 'CSID_REQUIRED', message: 'Row identifier (csId) is required for all changes' }],
        warnings: [],
      }
    }

    return { isValid: true, errors: [], warnings: [] }
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = quoteTable(ctx.table.name)

    try {
      // Capture _cs_origin_id for all affected rows before updates (stable identity for audit drill-down)
      const uniqueCsIds = [...new Set(this.params.changes.map(c => c.csId))]
      const csIdList = uniqueCsIds.map(id => `'${id}'`).join(', ')
      const originIdResults = await ctx.db.query<{ _cs_id: string; _cs_origin_id: string }>(
        `SELECT CAST("_cs_id" AS VARCHAR) as "_cs_id", "_cs_origin_id" FROM ${tableName} WHERE "_cs_id" IN (${csIdList})`
      )
      for (const row of originIdResults) {
        this.csOriginIdMap.set(String(row._cs_id), row._cs_origin_id)
      }

      // Execute all updates
      let affected = 0
      for (const change of this.params.changes) {
        const columnName = quoteColumn(change.columnName)
        const newValue = toSqlValue(change.newValue)

        await ctx.db.execute(
          `UPDATE ${tableName} SET ${columnName} = ${newValue} WHERE "_cs_id" = '${change.csId}'`
        )
        affected++
      }

      return {
        success: true,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected,
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

    // Generate inverse UPDATEs for all changes
    const inverseStatements = this.params.changes.map((change) => {
      const columnName = quoteColumn(change.columnName)
      const previousValue = toSqlValue(change.previousValue)
      return `UPDATE ${tableName} SET ${columnName} = ${previousValue} WHERE "_cs_id" = '${change.csId}'`
    })

    return inverseStatements.join(';\n')
  }

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 2,
      undoStrategy: `Restore previous values via ${this.params.changes.length} UPDATE statements`,
      inverseSql: undefined, // Will be set from context during execution
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const csIds = this.params.changes.map((c) => `'${c.csId}'`).join(', ')
    return `"_cs_id" IN (${csIds})`
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const changes = this.params.changes
    const details: EditAuditDetails = {
      type: 'edit',
      cellCount: changes.length,
      changes: changes.map((c) => ({
        rowId: c.csId,
        column: c.columnName,
        before: c.previousValue,
        after: c.newValue,
      })),
    }

    // Get unique columns affected
    const affectedColumns = [...new Set(changes.map((c) => c.columnName))]

    return {
      action: changes.length === 1 ? 'Edit Cell' : `Batch Edit (${changes.length} cells)`,
      details,
      affectedColumns,
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
    return this.params.changes.map((c) => ({
      csId: c.csId,
      csOriginId: this.csOriginIdMap.get(c.csId),
      columnName: c.columnName,
      previousValue: c.previousValue,
      newValue: c.newValue,
    }))
  }
}
