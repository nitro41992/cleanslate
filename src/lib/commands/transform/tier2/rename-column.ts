/**
 * Rename Column Command
 *
 * Changes the name of a column.
 * Tier 2 - Invertible SQL (no snapshot needed, undo via inverse rename).
 */

import type {
  CommandContext,
  CommandType,
  ValidationResult,
  ExecutionResult,
  InvertibilityInfo,
} from '../../types'
import { Tier2TransformCommand, type BaseTransformParams } from '../base'
import { quoteColumn, quoteTable } from '../../utils/sql'

export interface RenameColumnParams extends BaseTransformParams {
  column: string
  newName: string
}

export class RenameColumnCommand extends Tier2TransformCommand<RenameColumnParams> {
  readonly type: CommandType = 'transform:rename_column'
  readonly label = 'Rename Column'

  protected async validateParams(ctx: CommandContext): Promise<ValidationResult> {
    // Check new name is provided
    if (!this.params.newName || this.params.newName.trim() === '') {
      return this.errorResult('NEW_NAME_REQUIRED', 'New column name is required', 'newName')
    }

    // Check new name doesn't already exist
    const columns = ctx.table.columns.map((c) => c.name)
    if (columns.includes(this.params.newName)) {
      return this.errorResult(
        'NAME_EXISTS',
        `Column "${this.params.newName}" already exists`,
        'newName'
      )
    }

    // Check new name is different from old name
    if (this.params.column === this.params.newName) {
      return this.errorResult(
        'SAME_NAME',
        'New column name is the same as the current name',
        'newName'
      )
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = quoteTable(ctx.table.name)
    const oldCol = quoteColumn(this.params.column)
    const newCol = quoteColumn(this.params.newName)

    try {
      // Execute rename
      await ctx.db.execute(`ALTER TABLE ${tableName} RENAME COLUMN ${oldCol} TO ${newCol}`)

      // Get updated columns
      const columns = await ctx.db.getTableColumns(ctx.table.name)

      return {
        success: true,
        rowCount: ctx.table.rowCount,
        columns,
        affected: 0, // Metadata change only
        newColumnNames: [this.params.newName],
        droppedColumnNames: [this.params.column],
        renameMappings: { [this.params.column]: this.params.newName },
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
    const oldCol = quoteColumn(this.params.newName) // After execution, newName is current
    const newCol = quoteColumn(this.params.column) // Restore to original
    return `ALTER TABLE ${tableName} RENAME COLUMN ${oldCol} TO ${newCol}`
  }

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 2,
      undoStrategy: 'Inverse SQL - rename back to original',
      inverseSql: undefined, // Will be set from context during execution
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // Metadata change only - no rows affected
    return null
  }
}
