/**
 * Combine Stack Command
 *
 * Stacks two tables vertically using UNION ALL.
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
import { stackTables, validateStack } from '@/lib/combiner-engine'
import { getTableColumns } from '@/lib/duckdb'
import { checkSnapshotFileExists } from '@/lib/opfs/snapshot-storage'
import { useCombinerStore } from '@/stores/combinerStore'

export interface CombineStackParams {
  tableId: string // Source table A (for context building)
  sourceTableA: string // Table A name
  sourceTableB: string // Table B name
  resultTableName: string
}

export class CombineStackCommand implements Command<CombineStackParams> {
  readonly id: string
  readonly type: CommandType = 'combine:stack'
  readonly label = 'Stack Tables'
  readonly params: CombineStackParams


  constructor(id: string | undefined, params: CombineStackParams) {
    this.id = id || generateId()
    this.params = params
  }

  async validate(ctx: CommandContext): Promise<ValidationResult> {
    const { sourceTableA, sourceTableB, resultTableName } = this.params

    // Check source tables are provided
    if (!sourceTableA || !sourceTableB) {
      return {
        isValid: false,
        errors: [{ code: 'MISSING_TABLES', message: 'Both source tables are required' }],
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

    // Check if tables are available (in DuckDB or frozen in OPFS)
    const tableAExists = await ctx.db.tableExists(sourceTableA)
    const tableBExists = await ctx.db.tableExists(sourceTableB)

    if (!tableAExists) {
      // Check if frozen in OPFS
      const snapshotId = sourceTableA.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      const hasSnapshot = await checkSnapshotFileExists(snapshotId)
      if (!hasSnapshot) {
        return {
          isValid: false,
          errors: [{ code: 'TABLE_NOT_FOUND', message: `Table ${sourceTableA} not found` }],
          warnings: [],
        }
      }
    }

    if (!tableBExists) {
      const snapshotId = sourceTableB.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
      const hasSnapshot = await checkSnapshotFileExists(snapshotId)
      if (!hasSnapshot) {
        return {
          isValid: false,
          errors: [{ code: 'TABLE_NOT_FOUND', message: `Table ${sourceTableB} not found` }],
          warnings: [],
        }
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

    // Validate stack compatibility (may fail if tables are frozen — that's OK, engine handles it)
    try {
      const validation = await validateStack(sourceTableA, sourceTableB)
      const warnings = validation.warnings.map((w) => ({
        code: 'STACK_WARNING',
        message: w,
        requiresConfirmation: false,
      }))
      return { isValid: true, errors: [], warnings }
    } catch (error) {
      // Only swallow "table not in DuckDB" errors — re-throw unexpected ones
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('Catalog Error') || msg.includes('not found') || msg.includes('does not exist')) {
        return { isValid: true, errors: [], warnings: [] }
      }
      throw error
    }
  }

  async execute(_ctx: CommandContext): Promise<ExecutionResult> {
    const { sourceTableA, sourceTableB, resultTableName } = this.params

    try {
      // Call the combiner engine with progress reporting
      const onProgress = useCombinerStore.getState().setCombineProgress
      const { rowCount } = await stackTables(sourceTableA, sourceTableB, resultTableName, onProgress)

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
    const { sourceTableA, sourceTableB, resultTableName } = this.params

    const details: CombineAuditDetails = {
      type: 'combine',
      operation: 'stack',
      sourceTableA,
      sourceTableB,
    }

    return {
      action: `Stack Tables: ${sourceTableA} + ${sourceTableB} → ${resultTableName}`,
      details,
      affectedColumns: [],
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
