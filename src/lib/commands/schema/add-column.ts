/**
 * Add Column Command
 *
 * Adds a new column to a table.
 * Tier 3 - Requires snapshot for undo (schema modification).
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

export type ColumnDataType = 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP'

export interface AddColumnParams {
  tableId: string
  tableName: string
  columnName: string
  columnType?: ColumnDataType
  /** Column name to insert after, or null for end of table */
  insertAfter?: string | null
}

export class AddColumnCommand implements Command<AddColumnParams> {
  readonly id: string
  readonly type: CommandType = 'schema:add_column'
  readonly label: string = 'Add Column'
  readonly params: AddColumnParams

  constructor(id: string | undefined, params: AddColumnParams) {
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

    // Check column name is provided
    if (!this.params.columnName || this.params.columnName.trim() === '') {
      return {
        isValid: false,
        errors: [{ code: 'COLUMN_NAME_REQUIRED', message: 'Column name is required', field: 'columnName' }],
        warnings: [],
      }
    }

    // Check column doesn't already exist
    const columnExists = ctx.table.columns.some(
      (c) => c.name.toLowerCase() === this.params.columnName.toLowerCase()
    )
    if (columnExists) {
      return {
        isValid: false,
        errors: [
          {
            code: 'COLUMN_EXISTS',
            message: `Column "${this.params.columnName}" already exists`,
            field: 'columnName',
          },
        ],
        warnings: [],
      }
    }

    // Validate insertAfter column exists if specified
    if (this.params.insertAfter) {
      const afterExists = ctx.table.columns.some((c) => c.name === this.params.insertAfter)
      if (!afterExists) {
        return {
          isValid: false,
          errors: [
            {
              code: 'INSERT_AFTER_NOT_FOUND',
              message: `Column "${this.params.insertAfter}" not found`,
              field: 'insertAfter',
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
    const columnName = this.params.columnName
    const columnType = this.params.columnType || 'VARCHAR'

    try {
      // DuckDB doesn't support ALTER TABLE ADD COLUMN with position,
      // so we need to recreate the table with the new column in the right position

      if (this.params.insertAfter) {
        // Need to recreate table with column in specific position
        const tempTable = `${tableName}_temp_${Date.now()}`

        // Query ALL columns including internal ones (_cs_id) directly from database
        // ctx.table.columns excludes internal columns, which would break the table
        const allColumnsResult = await ctx.db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY ordinal_position`
        )
        const existingColumns = allColumnsResult.map((r) => r.column_name)

        // Build column list with new column inserted after specified column
        const newColumnOrder: string[] = []
        for (const col of existingColumns) {
          newColumnOrder.push(col)
          if (col === this.params.insertAfter) {
            newColumnOrder.push(columnName)
          }
        }

        // Build SELECT with new column (NULL value)
        const selectColumns = newColumnOrder.map((col) => {
          if (col === columnName) {
            return `NULL::${columnType} AS ${quoteColumn(col)}`
          }
          return quoteColumn(col)
        })

        // Create temp table with new structure
        await ctx.db.execute(
          `CREATE TABLE ${quoteTable(tempTable)} AS SELECT ${selectColumns.join(', ')} FROM ${quoteTable(tableName)}`
        )

        // Swap tables
        await ctx.db.execute(`DROP TABLE ${quoteTable(tableName)}`)
        await ctx.db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)
      } else {
        // Add column at end - simple ALTER TABLE
        await ctx.db.execute(
          `ALTER TABLE ${quoteTable(tableName)} ADD COLUMN ${quoteColumn(columnName)} ${columnType}`
        )
      }

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
        newColumnNames: [columnName],
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
      undoStrategy: 'Snapshot restore - column will be removed on undo',
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // No rows affected, just schema change
    return null
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const details: TransformAuditDetails = {
      type: 'transform',
      transformationType: 'add_column',
      column: this.params.columnName,
      params: {
        columnType: this.params.columnType || 'VARCHAR',
        insertAfter: this.params.insertAfter,
      },
    }

    return {
      action: 'Add Column',
      details,
      affectedColumns: [this.params.columnName],
      rowsAffected: result.affected,
      hasRowDetails: false,
      auditEntryId: this.id,
      isCapped: false,
    }
  }
}
