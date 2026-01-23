/**
 * Custom SQL Command
 *
 * Executes arbitrary SQL.
 * Tier 3 - Requires snapshot for undo (unpredictable effects).
 */

import type { CommandContext, CommandType, ValidationResult, ExecutionResult } from '../../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../base'
import { quoteTable } from '../../utils/sql'

export interface CustomSqlParams extends BaseTransformParams {
  sql: string
}

export class CustomSqlCommand extends Tier3TransformCommand<CustomSqlParams> {
  readonly type: CommandType = 'transform:custom_sql'
  readonly label = 'Custom SQL'

  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    if (!this.params.sql || this.params.sql.trim() === '') {
      return this.errorResult('SQL_REQUIRED', 'SQL query is required', 'sql')
    }

    // Basic safety checks
    const sqlLower = this.params.sql.toLowerCase()
    const dangerousPatterns = [
      'drop database',
      'drop schema',
      'truncate',
      'create database',
    ]

    for (const pattern of dangerousPatterns) {
      if (sqlLower.includes(pattern)) {
        return this.errorResult(
          'DANGEROUS_SQL',
          `SQL contains potentially dangerous operation: ${pattern}`,
          'sql'
        )
      }
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    try {
      // Execute the custom SQL
      await ctx.db.execute(this.params.sql)

      // Get updated info (table may have changed)
      const exists = await ctx.db.tableExists(ctx.table.name)
      if (!exists) {
        return {
          success: false,
          rowCount: 0,
          columns: [],
          affected: 0,
          newColumnNames: [],
          droppedColumnNames: [],
          error: 'Custom SQL dropped the table',
        }
      }

      const columns = await ctx.db.getTableColumns(ctx.table.name)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${quoteTable(ctx.table.name)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      // Calculate affected (difference from before)
      const affected = Math.abs(ctx.table.rowCount - rowCount)

      return {
        success: true,
        rowCount,
        columns,
        affected,
        newColumnNames: columns
          .filter((c) => !ctx.table.columns.find((oc) => oc.name === c.name))
          .map((c) => c.name),
        droppedColumnNames: ctx.table.columns
          .filter((c) => !columns.find((nc) => nc.name === c.name))
          .map((c) => c.name),
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

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // Cannot determine affected rows for arbitrary SQL
    return null
  }
}
