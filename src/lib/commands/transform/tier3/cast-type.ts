/**
 * Cast Type Command
 *
 * Converts column data type.
 * Tier 3 - Requires snapshot for undo (type conversion may lose data).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { detectUnixTimestampType, buildUnixToTimestampExpression, buildDateParseExpression, type UnixTimestampType } from '../../utils/date'
import { runBatchedColumnTransform, buildColumnOrderedSelect, getColumnOrderForTable } from '../../batch-utils'
import { tableHasCsId, tableHasOriginId } from '@/lib/duckdb'

export type CastTargetType = 'VARCHAR' | 'INTEGER' | 'DOUBLE' | 'DATE' | 'TIMESTAMP' | 'BOOLEAN'

export interface CastTypeParams extends BaseTransformParams {
  column: string
  targetType: CastTargetType
}

export class CastTypeCommand extends Tier3TransformCommand<CastTypeParams> {
  readonly type: CommandType = 'transform:cast_type'
  readonly label = 'Cast Type'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    const validTypes: CastTargetType[] = ['VARCHAR', 'INTEGER', 'DOUBLE', 'DATE', 'TIMESTAMP', 'BOOLEAN']
    if (!validTypes.includes(this.params.targetType)) {
      return this.errorResult(
        'INVALID_TYPE',
        `Invalid target type: ${this.params.targetType}`,
        'targetType'
      )
    }
    return this.validResult()
  }

  /**
   * Detect Unix timestamp type from sample values using digit count.
   * Returns the most common timestamp type found in the samples.
   */
  private detectTimestampTypeFromSamples(sampleValues: string[]): UnixTimestampType {
    // Count occurrences of each type
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

    // Only return if at least 50% of samples match this type
    const threshold = sampleValues.length * 0.5
    return maxCount >= threshold ? modeType : null
  }

  /**
   * Build the transform expression for the cast.
   * For DATE/TIMESTAMP targets, detects Unix timestamps by digit count and uses appropriate epoch functions.
   */
  private async buildTransformExpression(ctx: CommandContext): Promise<string> {
    const col = this.params.column
    const quotedCol = quoteColumn(col)
    const targetType = this.params.targetType

    // For DATE or TIMESTAMP, detect Unix timestamps
    if (targetType === 'DATE' || targetType === 'TIMESTAMP') {
      try {
        // Sample actual string values to detect by digit count
        // This is more reliable than numeric range checks
        const sampleQuery = `
          SELECT CAST(${quotedCol} AS VARCHAR) as val
          FROM ${quoteTable(ctx.table.name)}
          WHERE ${quotedCol} IS NOT NULL
          LIMIT 100
        `
        const sampleResult = await ctx.db.query<{ val: string }>(sampleQuery)
        const sampleValues = sampleResult.map(r => r.val).filter(Boolean)

        console.log('[CastType] Sample values (first 5):', sampleValues.slice(0, 5))
        console.log('[CastType] Sample value types:', sampleValues.slice(0, 5).map(v => ({
          value: v,
          isInt: /^\d+$/.test(v),
          isFloat: /^\d+\.0*$/.test(v),
          isSciNotation: /^[\d.]+[eE][+-]?\d+$/.test(v),
        })))

        const timestampType = this.detectTimestampTypeFromSamples(sampleValues)
        console.log('[CastType] Detected timestamp type:', timestampType)

        if (timestampType) {
          // Use shared utility to build the epoch expression
          const epochExpr = buildUnixToTimestampExpression(quotedCol, timestampType)
          if (epochExpr) {
            if (targetType === 'DATE') {
              return `TRY_CAST(${epochExpr} AS DATE)`
            }
            return epochExpr
          }
        }
      } catch (err) {
        console.warn('[CastType] Unix detection failed:', err)
      }

      // No Unix timestamp detected - use date parsing that tries multiple string formats
      console.log('[CastType] Using date parsing with multiple format detection')
      const dateParseExpr = buildDateParseExpression(col)
      if (targetType === 'DATE') {
        return `TRY_CAST(${dateParseExpr} AS DATE)`
      }
      return dateParseExpr  // TIMESTAMP
    }

    // Default for non-date types: use TRY_CAST
    console.log('[CastType] Using default TRY_CAST')
    return `TRY_CAST(${quotedCol} AS ${targetType})`
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const col = this.params.column
    const quotedCol = quoteColumn(col)
    const transformExpr = await this.buildTransformExpression(ctx)

    // Check if batching is needed
    if (ctx.batchMode) {
      return runBatchedColumnTransform(
        ctx, col, transformExpr,
        `(${transformExpr} IS NOT NULL OR ${quotedCol} IS NOT NULL)`
      )
    }

    // Non-batch mode: use column-ordered SELECT
    const tempTable = `${tableName}_temp_${Date.now()}`
    const columnOrder = getColumnOrderForTable(ctx)
    const hasCsId = await tableHasCsId(tableName)
    const hasOriginId = await tableHasOriginId(tableName)
    const selectQuery = buildColumnOrderedSelect(tableName, columnOrder, { [col]: transformExpr }, hasCsId, hasOriginId)

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
    const col = quoteColumn(this.params.column)
    return `${col} IS NOT NULL`
  }
}
