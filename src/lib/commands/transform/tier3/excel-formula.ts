/**
 * Excel Formula Command
 *
 * Applies Excel-like formulas (IF, LEN, UPPER, etc.) to table data.
 * Transpiles Excel syntax to DuckDB SQL for execution.
 *
 * Tier 3 - Requires snapshot for undo (creates/modifies columns).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'
import { transpileFormula, validateFormula, extractColumnRefs } from '@/lib/formula'
import { tableHasCsId } from '@/lib/duckdb'

export type OutputMode = 'new' | 'replace'

export interface ExcelFormulaParams extends BaseTransformParams {
  /** Excel-like formula (e.g., "IF(@State = \"NY\", \"East\", \"West\")") */
  formula: string
  /** Name for new column (when outputMode='new') */
  outputColumn?: string
  /** Output mode: 'new' creates column, 'replace' overwrites existing */
  outputMode: OutputMode
  /** Column to replace (when outputMode='replace') */
  targetColumn?: string
}

export class ExcelFormulaCommand extends Tier3TransformCommand<ExcelFormulaParams> {
  readonly type: CommandType = 'transform:excel_formula'
  readonly label = 'Formula Builder'

  protected async validateParams(ctx: CommandContext): Promise<ValidationResult> {
    const { formula, outputMode, outputColumn, targetColumn } = this.params

    // Formula is required
    if (!formula || formula.trim() === '') {
      return this.errorResult('EMPTY_FORMULA', 'Formula cannot be empty', 'formula')
    }

    // Get available column names for validation
    const availableColumns = ctx.table.columns.map((c) => c.name)

    // Validate formula syntax and column references
    const validation = validateFormula(formula, availableColumns)

    if (!validation.isValid && validation.errors.length > 0) {
      const errorMsg = validation.errors.map((e) => e.message).join('; ')
      return this.errorResult('INVALID_FORMULA', errorMsg, 'formula')
    }

    // Validate output mode specifics
    if (outputMode === 'new') {
      // Output column name is required for new column mode
      if (!outputColumn || outputColumn.trim() === '') {
        return this.errorResult(
          'MISSING_OUTPUT_COLUMN',
          'Output column name is required when creating a new column',
          'outputColumn'
        )
      }

      // Check output column doesn't already exist
      if (availableColumns.includes(outputColumn)) {
        return this.errorResult(
          'COLUMN_EXISTS',
          `Column "${outputColumn}" already exists. Choose a different name or use "Replace Column" mode.`,
          'outputColumn'
        )
      }
    } else if (outputMode === 'replace') {
      // Target column is required for replace mode
      if (!targetColumn || targetColumn.trim() === '') {
        return this.errorResult(
          'MISSING_TARGET_COLUMN',
          'Target column is required when replacing an existing column',
          'targetColumn'
        )
      }

      // Check target column exists
      if (!availableColumns.includes(targetColumn)) {
        return this.errorResult(
          'COLUMN_NOT_FOUND',
          `Column "${targetColumn}" not found in table`,
          'targetColumn'
        )
      }
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const { formula, outputMode, outputColumn, targetColumn } = this.params

    // Get available columns
    const availableColumns = ctx.table.columns.map((c) => c.name)

    // Transpile formula to SQL
    const transpileResult = transpileFormula(formula, availableColumns)

    if (!transpileResult.success || !transpileResult.sql) {
      return {
        success: false,
        rowCount: ctx.table.rowCount,
        columns: ctx.table.columns,
        affected: 0,
        newColumnNames: [],
        droppedColumnNames: [],
        error: transpileResult.error || 'Failed to transpile formula',
      }
    }

    const sqlExpr = transpileResult.sql
    const tempTable = `${tableName}_temp_${Date.now()}`

    try {
      const hasCsId = await tableHasCsId(tableName)
      const csIdSelect = hasCsId ? '"_cs_id", ' : ''

      if (outputMode === 'new') {
        // Create new column with formula result
        const existingColumns = ctx.table.columns
          .filter((c) => c.name !== '_cs_id')
          .map((c) => quoteColumn(c.name))
          .join(', ')

        const newColName = outputColumn!

        // Create temp table with new column
        const selectQuery = hasCsId
          ? `SELECT ${csIdSelect}${existingColumns}, (${sqlExpr}) AS ${quoteColumn(newColName)} FROM ${quoteTable(tableName)}`
          : `SELECT ${existingColumns}, (${sqlExpr}) AS ${quoteColumn(newColName)} FROM ${quoteTable(tableName)}`

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
          newColumnNames: [newColName],
          droppedColumnNames: [],
        }
      } else {
        // Replace existing column
        const targetCol = targetColumn!

        // Build column list with replacement
        const columnSelects = ctx.table.columns
          .filter((c) => c.name !== '_cs_id')
          .map((c) => {
            if (c.name === targetCol) {
              return `(${sqlExpr}) AS ${quoteColumn(c.name)}`
            }
            return quoteColumn(c.name)
          })
          .join(', ')

        // Create temp table with modified column
        const selectQuery = hasCsId
          ? `SELECT ${csIdSelect}${columnSelects} FROM ${quoteTable(tableName)}`
          : `SELECT ${columnSelects} FROM ${quoteTable(tableName)}`

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
      }
    } catch (error) {
      // Cleanup temp table on error
      try {
        await ctx.db.execute(`DROP TABLE IF EXISTS ${quoteTable(tempTable)}`)
      } catch {
        // Ignore cleanup errors
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
    // For 'new' mode: all rows are affected (new column)
    // For 'replace' mode: all rows are affected (column value changed)
    return null
  }

  /**
   * Override to provide formula-specific audit info
   */
  getAuditInfo(ctx: CommandContext, result: ExecutionResult) {
    const baseInfo = super.getAuditInfo(ctx, result)
    const { formula, outputMode, outputColumn, targetColumn } = this.params

    // Extract referenced columns for audit
    const referencedColumns = extractColumnRefs(formula)

    return {
      ...baseInfo,
      action: outputMode === 'new'
        ? `Formula Builder → ${outputColumn}`
        : `Formula Builder → ${targetColumn}`,
      details: {
        type: 'transform' as const,
        transformationType: 'excel_formula',
        column: outputMode === 'new' ? outputColumn : targetColumn,
        params: {
          formula,
          outputMode,
          outputColumn,
          targetColumn,
          referencedColumns,
        },
      },
      affectedColumns: outputMode === 'new'
        ? [outputColumn!, ...referencedColumns]
        : [targetColumn!, ...referencedColumns],
    }
  }
}
