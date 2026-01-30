/**
 * Standardize Date Command
 *
 * Parses dates in various formats and outputs in a standard format.
 * Supports both string date formats and Unix timestamps (auto-detected).
 * Tier 3 - Requires snapshot for undo (data format may not be recoverable).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import {
  buildDateFormatExpression,
  buildDateParseSuccessPredicate,
  detectUnixTimestampType,
  type OutputFormat,
  type DateOutputType,
  type UnixTimestampType,
} from '../../utils/date'
import { runBatchedColumnTransform, buildColumnOrderedSelect, getColumnOrderForTable } from '../../batch-utils'
import { tableHasCsId } from '@/lib/duckdb'

export interface StandardizeDateParams extends BaseTransformParams {
  column: string
  /** Output format (default: 'YYYY-MM-DD') */
  format?: OutputFormat
  /** Output type: 'text' (VARCHAR), 'date' (DATE), or 'timestamp' (TIMESTAMP) */
  outputType?: DateOutputType
}

export class StandardizeDateCommand extends Tier3TransformCommand<StandardizeDateParams> {
  readonly type: CommandType = 'transform:standardize_date'
  readonly label = 'Standardize Date'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    const validFormats: OutputFormat[] = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY']
    const format = this.params.format ?? 'YYYY-MM-DD'

    if (!validFormats.includes(format)) {
      return this.errorResult(
        'INVALID_FORMAT',
        `Invalid output format: ${format}. Valid formats: ${validFormats.join(', ')}`,
        'format'
      )
    }

    const validOutputTypes: DateOutputType[] = ['text', 'date', 'timestamp']
    const outputType = this.params.outputType ?? 'text'

    if (!validOutputTypes.includes(outputType)) {
      return this.errorResult(
        'INVALID_OUTPUT_TYPE',
        `Invalid output type: ${outputType}. Valid types: ${validOutputTypes.join(', ')}`,
        'outputType'
      )
    }

    return this.validResult()
  }

  /**
   * Detect Unix timestamp type from sample values.
   */
  private async detectTimestampType(ctx: CommandContext): Promise<UnixTimestampType> {
    const col = this.params.column
    const quotedCol = quoteColumn(col)

    try {
      const sampleQuery = `
        SELECT CAST(${quotedCol} AS VARCHAR) as val
        FROM ${quoteTable(ctx.table.name)}
        WHERE ${quotedCol} IS NOT NULL
        LIMIT 100
      `
      const sampleResult = await ctx.db.query<{ val: string }>(sampleQuery)
      const sampleValues = sampleResult.map(r => r.val).filter(Boolean)

      // Count occurrences of each timestamp type
      const typeCounts = new Map<UnixTimestampType, number>()
      for (const val of sampleValues) {
        const type = detectUnixTimestampType(val)
        if (type) {
          typeCounts.set(type, (typeCounts.get(type) || 0) + 1)
        }
      }

      // Find the most common type
      let maxCount = 0
      let modeType: UnixTimestampType = null
      for (const [type, count] of typeCounts) {
        if (count > maxCount) {
          maxCount = count
          modeType = type
        }
      }

      // Only return if at least 50% of samples match
      const threshold = sampleValues.length * 0.5
      if (maxCount >= threshold) {
        console.log('[StandardizeDate] Detected Unix timestamp type:', modeType)
        return modeType
      }
    } catch (err) {
      console.warn('[StandardizeDate] Timestamp detection failed:', err)
    }

    return null
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const col = this.params.column
    const tableName = ctx.table.name
    const format = this.params.format ?? 'YYYY-MM-DD'
    const outputType = this.params.outputType ?? 'text'

    // Detect if the column contains Unix timestamps
    const detectedTimestampType = await this.detectTimestampType(ctx)
    const dateExpr = buildDateFormatExpression(col, format, outputType, detectedTimestampType)

    console.log('[StandardizeDate] Using expression:', dateExpr.slice(0, 200) + '...')

    if (ctx.batchMode) {
      return runBatchedColumnTransform(ctx, col, dateExpr)
    }

    // Non-batch mode: use column-ordered SELECT
    const tempTable = `${tableName}_temp_${Date.now()}`
    const columnOrder = getColumnOrderForTable(ctx)
    const hasCsId = await tableHasCsId(tableName)
    const selectQuery = buildColumnOrderedSelect(tableName, columnOrder, { [col]: dateExpr }, hasCsId)

    try {
      await ctx.db.execute(`CREATE OR REPLACE TABLE ${quoteTable(tempTable)} AS ${selectQuery}`)

      // Swap tables
      await ctx.db.execute(`DROP TABLE ${quoteTable(tableName)}`)
      await ctx.db.execute(`ALTER TABLE ${quoteTable(tempTable)} RENAME TO ${quoteTable(tableName)}`)

      // Get updated info
      const columns = await ctx.db.getTableColumns(tableName)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(tableName)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: rowCount,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    } catch (error) {
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
    return buildDateParseSuccessPredicate(this.params.column)
  }
}
