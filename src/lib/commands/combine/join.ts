/**
 * Combine Join Command
 *
 * Joins two tables on a key column.
 * Tier 2 - Creates new table, undo by dropping it.
 */

import type {
  CommandContext,
  CommandType,
  ExecutionResult,
  AuditInfo,
  CombineAuditDetails,
  ValidationResult,
  InvertibilityInfo,
  Command,
} from '../types'
import { generateId } from '@/lib/utils'
import { joinTables, validateJoin } from '@/lib/combiner-engine'
import { getTableColumns } from '@/lib/duckdb'
import type { JoinType } from '@/types'

export interface CombineJoinParams {
  tableId: string // Left table ID (for context building)
  leftTableName: string
  rightTableName: string
  keyColumn: string
  joinType: JoinType
  resultTableName: string
}

export class CombineJoinCommand implements Command<CombineJoinParams> {
  readonly id: string
  readonly type: CommandType = 'combine:join'
  readonly label = 'Join Tables'
  readonly params: CombineJoinParams

  constructor(id: string | undefined, params: CombineJoinParams) {
    this.id = id || generateId()
    this.params = params
  }

  async validate(ctx: CommandContext): Promise<ValidationResult> {
    const { leftTableName, rightTableName, keyColumn, resultTableName } = this.params

    // Check tables are provided
    if (!leftTableName || !rightTableName) {
      return {
        isValid: false,
        errors: [{ code: 'MISSING_TABLES', message: 'Both left and right tables are required' }],
        warnings: [],
      }
    }

    // Check key column is provided
    if (!keyColumn) {
      return {
        isValid: false,
        errors: [{ code: 'MISSING_KEY', message: 'Key column is required' }],
        warnings: [],
      }
    }

    // Check result table name is provided
    if (!resultTableName || resultTableName.trim() === '') {
      return {
        isValid: false,
        errors: [{ code: 'MISSING_RESULT_NAME', message: 'Result table name is required' }],
        warnings: [],
      }
    }

    // Check source tables exist
    const leftExists = await ctx.db.tableExists(leftTableName)
    const rightExists = await ctx.db.tableExists(rightTableName)

    if (!leftExists) {
      return {
        isValid: false,
        errors: [{ code: 'TABLE_NOT_FOUND', message: `Table ${leftTableName} not found` }],
        warnings: [],
      }
    }

    if (!rightExists) {
      return {
        isValid: false,
        errors: [{ code: 'TABLE_NOT_FOUND', message: `Table ${rightTableName} not found` }],
        warnings: [],
      }
    }

    // Check result table doesn't already exist
    const resultExists = await ctx.db.tableExists(resultTableName)
    if (resultExists) {
      return {
        isValid: false,
        errors: [{ code: 'TABLE_EXISTS', message: `Table ${resultTableName} already exists` }],
        warnings: [],
      }
    }

    // Validate join compatibility
    try {
      const validation = await validateJoin(leftTableName, rightTableName, keyColumn)
      if (!validation.isValid) {
        return {
          isValid: false,
          errors: [{ code: 'JOIN_INVALID', message: validation.warnings.join('; ') }],
          warnings: [],
        }
      }
      const warnings = validation.warnings.map((w) => ({
        code: 'JOIN_WARNING',
        message: w,
        requiresConfirmation: false,
      }))
      return { isValid: true, errors: [], warnings }
    } catch (error) {
      return {
        isValid: false,
        errors: [{ code: 'VALIDATION_ERROR', message: error instanceof Error ? error.message : String(error) }],
        warnings: [],
      }
    }
  }

  async execute(_ctx: CommandContext): Promise<ExecutionResult> {
    const { leftTableName, rightTableName, keyColumn, joinType, resultTableName } = this.params

    try {
      // Call the combiner engine
      const { rowCount } = await joinTables(leftTableName, rightTableName, keyColumn, joinType, resultTableName)

      // Get new table columns
      const columns = await getTableColumns(resultTableName)

      return {
        success: true,
        rowCount,
        columns,
        affected: rowCount,
        newColumnNames: [],
        droppedColumnNames: [],
      }
    } catch (error) {
      return {
        success: false,
        rowCount: 0,
        columns: [],
        affected: 0,
        newColumnNames: [],
        droppedColumnNames: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const { leftTableName, rightTableName, keyColumn, joinType, resultTableName } = this.params

    const details: CombineAuditDetails = {
      type: 'combine',
      operation: 'join',
      sourceTableA: leftTableName,
      sourceTableB: rightTableName,
      joinKey: keyColumn,
      joinType: joinType === 'full_outer' ? 'full' : joinType,
    }

    const joinTypeLabel = joinType === 'inner' ? 'Inner' : joinType === 'left' ? 'Left' : 'Full Outer'

    return {
      action: `${joinTypeLabel} Join: ${leftTableName} + ${rightTableName} on ${keyColumn} → ${resultTableName}`,
      details,
      affectedColumns: [keyColumn],
      rowsAffected: result.affected,
      hasRowDetails: false,
      auditEntryId: this.id,
      isCapped: false,
    }
  }

  getInvertibility(): InvertibilityInfo {
    return {
      tier: 2,
      undoStrategy: 'Drop created table',
      inverseSql: `DROP TABLE IF EXISTS "${this.params.resultTableName}"`,
    }
  }

  getInverseSql(): string {
    return `DROP TABLE IF EXISTS "${this.params.resultTableName}"`
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // New table created - no predicate applicable
    return null
  }
}
