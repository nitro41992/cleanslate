/**
 * Match Merge Command
 *
 * Merges duplicate rows based on fuzzy matching results.
 * Tier 3 - Requires snapshot for undo (row deletion is destructive).
 */

import type {
  CommandContext,
  CommandType,
  ExecutionResult,
  AuditInfo,
  MergeAuditDetails,
  ValidationResult,
} from '../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../transform/base'
import { mergeDuplicates } from '@/lib/fuzzy-matcher'
import type { MatchPair } from '@/types'

export interface MatchMergeParams extends BaseTransformParams {
  matchColumn: string
  pairs: MatchPair[]
}

export class MatchMergeCommand extends Tier3TransformCommand<MatchMergeParams> {
  readonly type: CommandType = 'match:merge'
  readonly label = 'Merge Duplicates'

  protected async validateParams(ctx: CommandContext): Promise<ValidationResult> {
    const { matchColumn, pairs } = this.params

    // Check pairs are provided
    if (!pairs || pairs.length === 0) {
      return this.errorResult(
        'NO_PAIRS',
        'No match pairs provided for merging'
      )
    }

    // Check at least one pair is marked for merge
    const mergedPairs = pairs.filter((p) => p.status === 'merged')
    if (mergedPairs.length === 0) {
      return this.errorResult(
        'NO_MERGED_PAIRS',
        'No pairs marked for merge. Mark pairs as merged before applying.'
      )
    }

    // Check match column exists
    const columns = ctx.table.columns.map((c) => c.name)
    if (!columns.includes(matchColumn)) {
      return this.errorResult(
        'MATCH_COLUMN_NOT_FOUND',
        `Match column ${matchColumn} not found in table`,
        'matchColumn'
      )
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const { matchColumn, pairs } = this.params

    try {
      // Call the existing fuzzy matcher engine
      // Pass this.id as auditEntryId so the engine stores merge details
      const deletedCount = await mergeDuplicates(
        tableName,
        pairs,
        matchColumn,
        this.id // Use command ID as audit entry ID for linking
      )

      // Get updated table metadata
      const columns = await ctx.db.getTableColumns(tableName)
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      const rowCount = Number(countResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: deletedCount,
        newColumnNames: [],
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

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const { matchColumn, pairs } = this.params
    const mergedPairs = pairs.filter((p) => p.status === 'merged')

    const details: MergeAuditDetails = {
      type: 'merge',
      matchColumns: [matchColumn],
      pairsMerged: mergedPairs.length,
      rowsDeleted: result.affected,
      survivorStrategy: 'first', // Default - keeps row A or B based on pair.keepRow
    }

    return {
      action: 'Merge Duplicates',
      details,
      affectedColumns: [matchColumn],
      rowsAffected: result.affected,
      hasRowDetails: true, // Engine stores merge details in _merge_audit_details
      auditEntryId: this.id,
      isCapped: false,
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // Cannot highlight rows that have been deleted
    // The Diff View can show deleted rows by comparing to snapshot
    return null
  }
}
