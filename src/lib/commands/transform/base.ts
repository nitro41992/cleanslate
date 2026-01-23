/**
 * Base Transform Command
 *
 * Abstract base class for all transform commands.
 * Provides common functionality and enforces the Command interface.
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
import { createColumnVersionManager, type ColumnVersionStore } from '../column-versions'

/**
 * Base parameters for all transform commands
 */
export interface BaseTransformParams {
  tableId: string
  column?: string
}

/**
 * Abstract base class for transform commands
 */
export abstract class BaseTransformCommand<TParams extends BaseTransformParams = BaseTransformParams>
  implements Command<TParams>
{
  readonly id: string
  abstract readonly type: CommandType
  abstract readonly label: string
  readonly params: TParams

  constructor(id: string | undefined, params: TParams) {
    this.id = id || generateId()
    this.params = params
  }

  /**
   * Get the quoted column name
   */
  protected getQuotedColumn(): string {
    if (!this.params.column) {
      throw new Error('Column is required for this transformation')
    }
    return quoteColumn(this.params.column)
  }

  /**
   * Get the quoted table name from context
   */
  protected getQuotedTable(ctx: CommandContext): string {
    return quoteTable(ctx.table.name)
  }

  /**
   * Create a valid ValidationResult
   */
  protected validResult(): ValidationResult {
    return { isValid: true, errors: [], warnings: [] }
  }

  /**
   * Create an error ValidationResult
   */
  protected errorResult(code: string, message: string, field?: string): ValidationResult {
    return {
      isValid: false,
      errors: [{ code, message, field }],
      warnings: [],
    }
  }

  /**
   * Validate common preconditions
   */
  async validate(ctx: CommandContext): Promise<ValidationResult> {
    // Check table exists
    const exists = await ctx.db.tableExists(ctx.table.name)
    if (!exists) {
      return this.errorResult('TABLE_NOT_FOUND', `Table ${ctx.table.name} not found`)
    }

    // Check column exists (if column-based)
    if (this.params.column) {
      const columns = ctx.table.columns.map((c) => c.name)
      if (!columns.includes(this.params.column)) {
        return this.errorResult(
          'COLUMN_NOT_FOUND',
          `Column ${this.params.column} not found in table`,
          'column'
        )
      }
    }

    // Call subclass validation
    return this.validateParams(ctx)
  }

  /**
   * Override in subclass for parameter-specific validation
   */
  protected async validateParams(_ctx: CommandContext): Promise<ValidationResult> {
    return this.validResult()
  }

  /**
   * Execute must be implemented by subclass
   */
  abstract execute(ctx: CommandContext): Promise<ExecutionResult>

  /**
   * Get audit info - can be overridden for custom details
   */
  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const details: TransformAuditDetails = {
      type: 'transform',
      transformationType: this.type.replace('transform:', ''),
      column: this.params.column,
      params: this.params as unknown as Record<string, unknown>,
    }

    return {
      action: this.label,
      details,
      affectedColumns: this.params.column ? [this.params.column] : [],
      rowsAffected: result.affected,
      hasRowDetails: false, // Subclass can override
      auditEntryId: this.id,
      isCapped: false,
    }
  }

  /**
   * Get invertibility info - must be implemented by subclass
   */
  abstract getInvertibility(): InvertibilityInfo

  /**
   * Get affected rows predicate - can be overridden for specific predicates
   */
  abstract getAffectedRowsPredicate(ctx: CommandContext): Promise<string | null>

  /**
   * Get diff view SQL - optional
   */
  getDiffViewSql?(ctx: CommandContext, stepIndex: number): string
}

/**
 * Base class for Tier 1 (Column Versioning) commands
 *
 * Uses expression chaining for instant undo - no full table snapshots.
 * Supports chained transforms (e.g., trim → lowercase on same column).
 */
export abstract class Tier1TransformCommand<TParams extends BaseTransformParams = BaseTransformParams>
  extends BaseTransformCommand<TParams>
{
  /**
   * Get the SQL expression for the transformation.
   * MUST use {{COL}} placeholder for the column reference.
   *
   * @example
   * // Trim: return 'TRIM({{COL}})'
   * // Replace: return `REPLACE({{COL}}, 'find', 'replace')`
   * // Lowercase: return 'LOWER({{COL}})'
   */
  abstract getTransformExpression(ctx: CommandContext): string

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 1,
      undoStrategy: 'Column versioning - instant undo',
      columnVersion: this.params.column
        ? { original: this.params.column, backup: '' }
        : undefined,
    }
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const column = this.params.column!

    try {
      // Count affected rows before transformation
      const affectedCount = await this.countAffectedRows(ctx)

      // Get the transformation expression
      const expression = this.getTransformExpression(ctx)

      // Use column versioning for Tier 1 (instant undo via backup/restore)
      const versionStore: ColumnVersionStore = { versions: ctx.columnVersions }
      const versionManager = createColumnVersionManager(ctx.db, versionStore)

      const versionResult = await versionManager.createVersion(
        tableName,
        column,
        expression,
        this.id
      )

      if (!versionResult.success) {
        return {
          success: false,
          rowCount: ctx.table.rowCount,
          columns: ctx.table.columns,
          affected: 0,
          newColumnNames: [],
          droppedColumnNames: [],
          error: versionResult.error || 'Column versioning failed',
        }
      }

      // Update context's column versions for subsequent commands
      ctx.columnVersions = versionStore.versions

      // Get new row count and columns
      const columns = await ctx.db.getTableColumns(tableName)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${this.getQuotedTable(ctx)}`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: affectedCount,
        newColumnNames: [],
        droppedColumnNames: [],
        versionedColumn: {
          original: column,
          backup: versionResult.baseColumn,
          version: versionResult.expressionCount,
        },
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
   * Count rows that will be affected - subclass can override
   */
  protected async countAffectedRows(ctx: CommandContext): Promise<number> {
    const predicate = await this.getAffectedRowsPredicate(ctx)
    if (!predicate || predicate === 'TRUE') {
      return ctx.table.rowCount
    }

    const result = await ctx.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.getQuotedTable(ctx)} WHERE ${predicate}`
    )
    return Number(result[0]?.count ?? 0)
  }
}

/**
 * Base class for Tier 2 (Invertible SQL) commands
 */
export abstract class Tier2TransformCommand<TParams extends BaseTransformParams = BaseTransformParams>
  extends BaseTransformCommand<TParams>
{
  /**
   * Get the SQL to undo this transformation
   */
  abstract getInverseSql(ctx: CommandContext): string

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 2,
      undoStrategy: 'Inverse SQL - no snapshot needed',
      inverseSql: undefined, // Set during execution
    }
  }
}

/**
 * Base class for Tier 3 (Snapshot Required) commands
 */
export abstract class Tier3TransformCommand<TParams extends BaseTransformParams = BaseTransformParams>
  extends BaseTransformCommand<TParams>
{
  getInvertibility(): InvertibilityInfo {
    return {
      tier: 3,
      undoStrategy: 'Snapshot required - restore from backup',
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // Tier 3 commands often can't provide a predicate (e.g., remove_duplicates)
    // Subclass can override if predicate is available
    return null
  }
}
