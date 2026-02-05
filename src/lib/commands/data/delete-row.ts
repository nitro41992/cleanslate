/**
 * Delete Row Command
 *
 * Deletes one or more rows from a table.
 * Tier 2 (≤500 rows) - Captures row data before delete, undo = INSERT back.
 * Tier 3 (>500 rows) - Falls back to snapshot restore for undo.
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
import { saveDeleteRowToChangelog } from '@/hooks/usePersistence'

/** Threshold: above this many rows, fall back to Tier 3 snapshot */
const TIER_2_DELETE_THRESHOLD = 500

export interface DeleteRowParams {
  tableId: string
  tableName: string
  /** Row identifiers (_cs_id) to delete */
  csIds: string[]
}

/** Captured row data for Tier 2 undo (INSERT back) */
interface CapturedRow {
  /** Column name → value pairs (including _cs_id and _cs_origin_id) */
  [columnName: string]: unknown
}

export class DeleteRowCommand implements Command<DeleteRowParams> {
  readonly id: string
  readonly type: CommandType = 'data:delete_row'
  readonly label: string = 'Delete Row'
  readonly params: DeleteRowParams

  /** Captured row data for Tier 2 undo. Only populated when ≤ TIER_2_DELETE_THRESHOLD rows. */
  private capturedRows: CapturedRow[] | null = null
  /** All column names in table order (for INSERT) */
  private allColumnNames: string[] | null = null

  constructor(id: string | undefined, params: DeleteRowParams) {
    this.id = id || generateId()
    this.params = params
  }

  /** Whether this delete is small enough for Tier 2 */
  private get isTier2(): boolean {
    return this.params.csIds.length <= TIER_2_DELETE_THRESHOLD
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
      const idList = this.params.csIds.map((id) => `'${id}'`).join(', ')

      // Tier 2: Capture row data BEFORE deleting (for undo via INSERT)
      if (this.isTier2) {
        // Get all column names (including internal) for faithful restoration
        const colsResult = await ctx.db.query<{ column_name: string }>(
          `SELECT column_name FROM (DESCRIBE ${quoteTable(tableName)})`
        )
        this.allColumnNames = colsResult.map(c => c.column_name)

        // Capture the rows about to be deleted
        this.capturedRows = await ctx.db.query<CapturedRow>(
          `SELECT * FROM ${quoteTable(tableName)} WHERE "_cs_id" IN (${idList})`
        )
        console.log(`[DeleteRow] Tier 2: Captured ${this.capturedRows.length} row(s) for undo`)
      }

      // Delete the rows
      await ctx.db.execute(
        `DELETE FROM ${quoteTable(tableName)} WHERE "_cs_id" IN (${idList})`
      )

      // Get updated row count
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      // Tier 2: Journal the delete to OPFS changelog (fast path, ~2-3ms)
      let journaled = false
      if (this.isTier2 && this.capturedRows && this.allColumnNames) {
        try {
          await saveDeleteRowToChangelog(
            this.params.tableId,
            this.params.csIds,
            this.capturedRows,
            this.allColumnNames
          )
          journaled = true
        } catch (err) {
          console.warn('[DeleteRow] Failed to journal delete to changelog:', err)
        }
      }

      return {
        success: true,
        rowCount,
        columns: ctx.table.columns,
        affected: this.params.csIds.length,
        newColumnNames: [],
        droppedColumnNames: [],
        journaled,
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
    if (this.isTier2) {
      return {
        tier: 2,
        undoStrategy: 'Inverse SQL - INSERT deleted rows back on undo',
      }
    }
    return {
      tier: 3,
      undoStrategy: 'Snapshot restore - deleted rows will be recovered on undo',
    }
  }

  getInverseSql(ctx: CommandContext): string {
    if (!this.capturedRows || this.capturedRows.length === 0 || !this.allColumnNames) {
      throw new Error('Cannot generate inverse SQL: no captured row data (Tier 3 fallback)')
    }

    const tableName = quoteTable(ctx.table.name)
    const columns = this.allColumnNames.map(quoteColumn).join(', ')

    // Build VALUES clause for each captured row
    const valueRows = this.capturedRows.map(row => {
      const values = this.allColumnNames!.map(col => {
        const val = row[col]
        if (val === null || val === undefined) return 'NULL'
        if (typeof val === 'number' || typeof val === 'bigint') return String(val)
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE'
        // String value - escape single quotes
        const escaped = String(val).replace(/'/g, "''")
        return `'${escaped}'`
      })
      return `(${values.join(', ')})`
    })

    return `INSERT INTO ${tableName} (${columns}) VALUES ${valueRows.join(', ')}`
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
