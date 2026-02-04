/**
 * Split Column Command
 *
 * Splits a column into multiple columns by delimiter, position, or length.
 * Tier 3 - Requires snapshot for undo (adds multiple columns).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable, escapeSqlString } from '../../utils/sql'
import { runBatchedTransform } from '../../batch-utils'
import { getConnection } from '@/lib/duckdb'

export type SplitMode = 'delimiter' | 'position' | 'length'

export interface SplitColumnParams extends BaseTransformParams {
  column: string
  splitMode: SplitMode
  delimiter?: string
  position?: number
  length?: number
}

export class SplitColumnCommand extends Tier3TransformCommand<SplitColumnParams> {
  readonly type: CommandType = 'transform:split_column'
  readonly label = 'Split Column'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    const mode = this.params.splitMode || 'delimiter'

    if (mode === 'delimiter' && !this.params.delimiter) {
      return this.errorResult('DELIMITER_REQUIRED', 'Delimiter is required for delimiter mode', 'delimiter')
    }

    if (mode === 'position' && (this.params.position === undefined || this.params.position < 1)) {
      return this.errorResult('POSITION_REQUIRED', 'Valid position is required for position mode', 'position')
    }

    if (mode === 'length' && (this.params.length === undefined || this.params.length < 1)) {
      return this.errorResult('LENGTH_REQUIRED', 'Valid length is required for length mode', 'length')
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = this.params.column
    const mode = this.params.splitMode || 'delimiter'

    // Determine prefix for new columns
    const existingCols = ctx.table.columns.map((c) => c.name)
    let prefix = col
    if (existingCols.some((c) => c.startsWith(`${col}_1`))) {
      prefix = `${col}_split`
    }

    let partColumns: string
    const conn = await getConnection()

    if (mode === 'position') {
        const pos = this.params.position || 3
        partColumns = `
          substring(CAST(${quoteColumn(col)} AS VARCHAR), 1, ${pos}) as ${quoteColumn(`${prefix}_1`)},
          substring(CAST(${quoteColumn(col)} AS VARCHAR), ${pos + 1}) as ${quoteColumn(`${prefix}_2`)}
        `
      } else if (mode === 'length') {
        const len = this.params.length || 2
        // Get max length to determine number of parts
        const maxLenResult = await conn.query(
          `SELECT MAX(LENGTH(CAST(${quoteColumn(col)} AS VARCHAR))) as max_len FROM ${quoteTable(tableName)}`
        )
        const maxLen = Number(maxLenResult.toArray()[0]?.max_len) || 0
        const numParts = Math.min(Math.ceil(maxLen / len), 50) // Cap at 50

        partColumns = Array.from({ length: numParts }, (_, i) =>
          `substring(CAST(${quoteColumn(col)} AS VARCHAR), ${i * len + 1}, ${len}) as ${quoteColumn(`${prefix}_${i + 1}`)}`
        ).join(', ')
      } else {
        // Delimiter mode
        const delimiter = this.params.delimiter || ' '
        const escapedDelim = escapeSqlString(delimiter)

        // Get max parts
        const maxPartsResult = await conn.query(
          `SELECT MAX(len(string_split(CAST(${quoteColumn(col)} AS VARCHAR), '${escapedDelim}'))) as max_parts FROM ${quoteTable(tableName)}`
        )
        const numParts = Math.min(Number(maxPartsResult.toArray()[0]?.max_parts) || 2, 10)

        partColumns = Array.from({ length: numParts }, (_, i) =>
          `string_split(CAST(${quoteColumn(col)} AS VARCHAR), '${escapedDelim}')[${i + 1}] as ${quoteColumn(`${prefix}_${i + 1}`)}`
        ).join(', ')
      }

    // Check if batching is needed
    if (ctx.batchMode) {
      // Construct the "after" expression based on split mode
      let afterExpression: string
      if (mode === 'position') {
        const pos = this.params.position || 3
        afterExpression = `substring(CAST(${quoteColumn(col)} AS VARCHAR), 1, ${pos})`
      } else if (mode === 'length') {
        const len = this.params.length || 2
        afterExpression = `substring(CAST(${quoteColumn(col)} AS VARCHAR), 1, ${len})`
      } else {
        // Delimiter mode
        const delimiter = this.params.delimiter || ' '
        const escapedDelim = escapeSqlString(delimiter)
        afterExpression = `string_split(CAST(${quoteColumn(col)} AS VARCHAR), '${escapedDelim}')[1]`
      }

      return runBatchedTransform(
        ctx,
        // Transform query (adds new columns)
        `SELECT *, ${partColumns}
         FROM "${tableName}"`,
        // Sample query (captures original value and first split part for first 1000 rows)
        `SELECT ${quoteColumn(col)} as before,
                ${afterExpression} as after
         FROM "${tableName}"
         WHERE ${quoteColumn(col)} IS NOT NULL AND TRIM(CAST(${quoteColumn(col)} AS VARCHAR)) != ''
         LIMIT 1000`
      )
    }

    // Original logic for <500k rows
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {
      // Create temp table with split columns
      const sql = `
        CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS
        SELECT *, ${partColumns}
        FROM ${quoteTable(tableName)}
      `
      await ctx.db.execute(sql)

      // Swap tables
      await ctx.db.execute(`DROP TABLE ${quoteTable(tableName)}`)
      await ctx.db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

      // Get updated info
      const columns = await ctx.db.getTableColumns(tableName)
      const newColumnNames = columns
        .filter((c) => c.name.startsWith(`${prefix}_`))
        .map((c) => c.name)

      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: rowCount,
        newColumnNames,
        droppedColumnNames: [],
      }
    } catch (error) {
      // Cleanup
      try {
        await ctx.db.execute(`DROP TABLE IF EXISTS ${quoteTable(tempTable)}`)
      } catch {
        // Ignore
      }

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

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    const col = quoteColumn(this.params.column)
    // All non-null rows are affected
    return `${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) != ''`
  }
}
