/**
 * Standardize Apply Command
 *
 * Applies cluster-based value standardization to a column.
 * Tier 3 - Requires snapshot for undo (overwrites original values).
 */

import type {
  CommandContext,
  CommandType,
  ExecutionResult,
  AuditInfo,
  StandardizeAuditDetails,
  ValidationResult,
} from '../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../transform/base'
import { applyStandardization } from '@/lib/standardizer-engine'
import type { StandardizationMapping, ClusteringAlgorithm } from '@/types'

export interface StandardizeApplyParams extends BaseTransformParams {
  column: string
  algorithm: ClusteringAlgorithm
  mappings: StandardizationMapping[]
}

export class StandardizeApplyCommand extends Tier3TransformCommand<StandardizeApplyParams> {
  readonly type: CommandType = 'standardize:apply'
  readonly label = 'Apply Standardization'

  /**
   * Store affected row IDs after execution for highlighting
   */
  private affectedRowIds: string[] = []

  protected async validateParams(ctx: CommandContext): Promise<ValidationResult> {
    // Check mappings are provided
    if (!this.params.mappings || this.params.mappings.length === 0) {
      return this.errorResult(
        'NO_MAPPINGS',
        'No value mappings provided for standardization'
      )
    }

    // Check algorithm is valid
    const validAlgorithms: ClusteringAlgorithm[] = ['fingerprint', 'metaphone', 'token_phonetic']
    if (!validAlgorithms.includes(this.params.algorithm)) {
      return this.errorResult(
        'INVALID_ALGORITHM',
        `Invalid algorithm: ${this.params.algorithm}`
      )
    }

    // Verify column exists (base class already checks, but be explicit)
    const columns = ctx.table.columns.map((c) => c.name)
    if (!columns.includes(this.params.column)) {
      return this.errorResult(
        'COLUMN_NOT_FOUND',
        `Column ${this.params.column} not found in table`,
        'column'
      )
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const tableName = ctx.table.name
    const { column, mappings } = this.params

    try {
      // Call the existing standardizer engine
      // Pass this.id as auditEntryId so the engine stores audit details
      const result = await applyStandardization(
        tableName,
        column,
        mappings,
        this.id // Use command ID as audit entry ID for linking
      )

      // Store affected row IDs for highlighting support
      this.affectedRowIds = result.affectedRowIds

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
        affected: result.rowsAffected,
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
    const { column, algorithm, mappings } = this.params

    // Build cluster mapping structure for audit details
    // Group mappings by target value to reconstruct clusters
    const clustersByTarget = new Map<string, string[]>()
    for (const mapping of mappings) {
      if (!clustersByTarget.has(mapping.toValue)) {
        clustersByTarget.set(mapping.toValue, [])
      }
      clustersByTarget.get(mapping.toValue)!.push(mapping.fromValue)
    }

    // Convert to the expected audit details format
    const clusters: Record<string, { master: string; members: string[] }> = {}
    let clusterIndex = 0
    for (const [masterValue, memberValues] of clustersByTarget) {
      clusters[`cluster_${clusterIndex}`] = {
        master: masterValue,
        members: memberValues,
      }
      clusterIndex++
    }

    const details: StandardizeAuditDetails = {
      type: 'standardize',
      column,
      algorithm: algorithm === 'token_phonetic' ? 'metaphone' : algorithm, // Normalize for audit
      clusterCount: clustersByTarget.size,
      clusters,
    }

    return {
      action: `Standardize Values in ${column}`,
      details,
      affectedColumns: [column],
      rowsAffected: result.affected,
      hasRowDetails: true, // Engine stores value mappings in _standardize_audit_details
      auditEntryId: this.id,
      isCapped: false,
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // If we have stored row IDs from execution, build a predicate
    if (this.affectedRowIds.length > 0) {
      const idList = this.affectedRowIds.map((id) => `'${id}'`).join(', ')
      return `_cs_id IN (${idList})`
    }

    // Fallback: build predicate from mappings (before execution)
    const { column, mappings } = this.params
    if (mappings.length === 0) return null

    const whereValues = mappings
      .map((m) => `'${m.fromValue.replace(/'/g, "''")}'`)
      .join(', ')

    return `CAST("${column}" AS VARCHAR) IN (${whereValues})`
  }
}
