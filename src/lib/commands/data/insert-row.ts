/**
 * Insert Row Command
 *
 * Inserts a new empty row into a table.
 * Tier 2 - Uses inverse SQL (DELETE) for undo.
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
import { CS_ORIGIN_ID_COLUMN } from '@/lib/duckdb'
import { saveInsertRowToChangelog } from '@/hooks/usePersistence'

export interface InsertRowParams {
  tableId: string
  tableName: string
  /** Insert after this row's _cs_id, or null for end of table */
  insertAfterCsId?: string | null
  /** Pre-computed _cs_id for deterministic Redo — set on first execute, reused on replay */
  forceCsId?: string
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
      const { insertAfterCsId, forceCsId } = this.params

      // O(1) gap-based insert: find midpoint between adjacent _cs_id values.
      // No UPDATE of other rows needed — gaps of 100 between rows absorb inserts.
      let newCsIdNum: number

      if (forceCsId) {
        // Deterministic Redo: reuse the _cs_id from the first execution
        newCsIdNum = parseInt(forceCsId, 10)
      } else if (insertAfterCsId === null || insertAfterCsId === undefined) {
        // Insert at the beginning: use half of the first row's _cs_id
        const firstRow = await ctx.db.query<{ min_id: number }>(
          `SELECT MIN(CAST("_cs_id" AS BIGINT)) as min_id FROM ${quoteTable(tableName)}`
        )
        const firstId = Number(firstRow[0]?.min_id ?? 100)
        newCsIdNum = firstId > 1 ? Math.floor(firstId / 2) : 1
        // If no gap available (first row is already 1), we need a rebalance
        // For now, use 1 and handle rebalance in Phase 2C
      } else {
        // Insert after the specified row: find midpoint between it and the next row
        const afterIdNum = parseInt(insertAfterCsId, 10)
        const nextRow = await ctx.db.query<{ next_id: number | null }>(
          `SELECT MIN(CAST("_cs_id" AS BIGINT)) as next_id FROM ${quoteTable(tableName)} WHERE CAST("_cs_id" AS BIGINT) > ${afterIdNum}`
        )
        const nextId = Number(nextRow[0]?.next_id ?? 0)

        if (nextId === 0) {
          // No row after — insert with afterIdNum + 100 (standard gap)
          newCsIdNum = afterIdNum + 100
        } else {
          // Midpoint between afterIdNum and nextId
          newCsIdNum = Math.floor((afterIdNum + nextId) / 2)
          if (newCsIdNum === afterIdNum) {
            // No gap available (adjacent integers) — needs rebalance
            // Fallback: use afterIdNum + 1 (Phase 2C adds proper rebalance)
            newCsIdNum = afterIdNum + 1
          }
        }
      }

      // Persist for deterministic Redo
      this.params.forceCsId = String(newCsIdNum)
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

      // Journal the insert to OPFS changelog (fast path, ~2-3ms)
      // This avoids the expensive full snapshot export for row inserts
      try {
        await saveInsertRowToChangelog(
          this.params.tableId,
          this.newCsId!,
          newOriginId,
          insertAfterCsId ?? null,
          columnNames
        )
      } catch (err) {
        console.warn('[InsertRow] Failed to journal insert to changelog:', err)
        // Non-fatal: data is already in DuckDB, worst case it triggers a snapshot save
      }

      return {
        success: true,
        rowCount,
        columns: ctx.table.columns,
        affected: 1,
        newColumnNames: [],
        droppedColumnNames: [],
        // Return inserted row info for local state injection (no reload needed)
        // rowIndex is the 0-based positional index (how many rows have a smaller _cs_id)
        insertedRow: {
          csId: this.newCsId!,
          rowIndex: insertAfterCsId === null || insertAfterCsId === undefined
            ? 0 // Inserted at beginning
            : await this.computeRowIndex(ctx, this.newCsId!),
        },
        /** Signal that this operation was journaled — skip priority snapshot save */
        journaled: true,
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

  /**
   * Compute the 0-based positional index of a row by its _cs_id.
   * With gap-based IDs, position = count of rows with smaller _cs_id.
   */
  private async computeRowIndex(ctx: CommandContext, csId: string): Promise<number> {
    const result = await ctx.db.query<{ pos: number }>(
      `SELECT COUNT(*) as pos FROM ${quoteTable(ctx.table.name)} WHERE CAST("_cs_id" AS BIGINT) < ${parseInt(csId, 10)}`
    )
    return Number(result[0]?.pos ?? 0)
  }

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 2,
      undoStrategy: 'Inverse SQL - DELETE the inserted row on undo',
    }
  }

  getInverseSql(ctx: CommandContext): string {
    if (!this.newCsId) {
      throw new Error('Cannot generate inverse SQL: row has not been inserted yet')
    }
    return `DELETE FROM ${quoteTable(ctx.table.name)} WHERE "_cs_id" = '${this.newCsId}'`
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
