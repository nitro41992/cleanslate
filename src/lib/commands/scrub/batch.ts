/**
 * Scrub Batch Command
 *
 * A composite command that applies multiple scrub operations at once
 * and optionally creates a unified key map table for all transforms.
 *
 * Tier 3 - Requires snapshot for undo (composite operation).
 */

import type {
  CommandContext,
  CommandType,
  ExecutionResult,
  ValidationResult,
  AuditInfo,
  TransformAuditDetails,
} from '../types'
import { Tier3TransformCommand, type BaseTransformParams } from '../transform/base'
import type { ScrubMethod } from '@/types'

/**
 * A single rule in the batch configuration
 */
export interface ScrubBatchRule {
  column: string
  method: ScrubMethod
  params?: Record<string, unknown>
}

export interface ScrubBatchParams extends BaseTransformParams {
  rules: ScrubBatchRule[]
  secret?: string // Shared secret for hash methods
  generateKeyMap?: boolean
}

// Map method names to their SQL implementations
const METHOD_SQL: Record<ScrubMethod, (col: string, secret?: string) => string> = {
  redact: () => `'[REDACTED]'`,

  mask: (col) => {
    const colExpr = `CAST("${col}" AS VARCHAR)`
    return `CASE
      WHEN "${col}" IS NULL THEN NULL
      WHEN LENGTH(${colExpr}) <= 2 THEN REPEAT('*', LENGTH(${colExpr}))
      ELSE CONCAT(
        LEFT(${colExpr}, 1),
        REPEAT('*', LEAST(LENGTH(${colExpr}) - 2, 5)),
        RIGHT(${colExpr}, 1)
      )
    END`
  },

  hash: (col, secret = '') => {
    const escapedSecret = secret.replace(/'/g, "''")
    return `MD5(CONCAT(CAST("${col}" AS VARCHAR), '${escapedSecret}'))`
  },

  last4: (col) => {
    const colExpr = `CAST("${col}" AS VARCHAR)`
    const digitsOnly = `regexp_replace(${colExpr}, '[^0-9]', '', 'g')`
    return `CASE
      WHEN "${col}" IS NULL THEN NULL
      WHEN LENGTH(${digitsOnly}) <= 4 THEN ${digitsOnly}
      ELSE CONCAT(
        REPEAT('*', LENGTH(${digitsOnly}) - 4),
        RIGHT(${digitsOnly}, 4)
      )
    END`
  },

  zero: (col) => `regexp_replace(CAST("${col}" AS VARCHAR), '[0-9]', '0', 'g')`,

  scramble: (col) => {
    const colExpr = `CAST("${col}" AS VARCHAR)`
    const digitsOnly = `regexp_replace(${colExpr}, '[^0-9]', '', 'g')`
    return `CASE
      WHEN "${col}" IS NULL THEN NULL
      WHEN ${colExpr} = '' THEN ''
      WHEN ${colExpr} = ${digitsOnly}
      THEN reverse(${colExpr})
      ELSE regexp_replace(
        ${colExpr},
        '[0-9]+',
        reverse(${digitsOnly}),
        'g'
      )
    END`
  },

  year_only: (col) => {
    return `CASE
      WHEN "${col}" IS NOT NULL AND TRY_CAST("${col}" AS DATE) IS NOT NULL
      THEN strftime(DATE_TRUNC('year', TRY_CAST("${col}" AS DATE)), '%Y-%m-%d')
      ELSE CAST("${col}" AS VARCHAR)
    END`
  },
}

export class ScrubBatchCommand extends Tier3TransformCommand<ScrubBatchParams> {
  readonly type: CommandType = 'scrub:batch'
  readonly label = 'Batch Privacy'

  protected async validateParams(ctx: CommandContext): Promise<ValidationResult> {
    const { rules, secret } = this.params

    // Must have at least one rule
    if (!rules || rules.length === 0) {
      return this.errorResult('NO_RULES', 'At least one column rule is required', 'rules')
    }

    // Check all columns exist
    const columns = ctx.table.columns.map((c) => c.name)
    for (const rule of rules) {
      if (!columns.includes(rule.column)) {
        return this.errorResult(
          'COLUMN_NOT_FOUND',
          `Column "${rule.column}" not found in table`,
          'rules'
        )
      }
    }

    // Check secret is provided if any rule uses hash
    const hasHashRule = rules.some((r) => r.method === 'hash')
    if (hasHashRule && (!secret || secret.length < 5)) {
      return this.errorResult(
        'SECRET_REQUIRED',
        'A secret (min 5 characters) is required for hash method',
        'secret'
      )
    }

    return this.validResult()
  }

  async execute(ctx: CommandContext): Promise<ExecutionResult> {
    const { rules, secret, generateKeyMap } = this.params
    const tableName = ctx.table.name

    try {
      let totalAffected = 0
      const affectedColumns: string[] = []

      // 1. Optionally capture distinct values for key map BEFORE transforms
      let keyMapData: { column: string; original: string; obfuscated: string }[] = []
      if (generateKeyMap) {
        keyMapData = await this.captureKeyMapData(ctx, rules, secret)
      }

      // 2. Build and execute batch UPDATE for all rules
      // Using CTAS pattern to handle all columns at once
      const allCols = ctx.table.columns.map((c) => c.name)
      const rulesByColumn = new Map(rules.map((r) => [r.column, r]))

      const selectParts = allCols.map((col) => {
        const rule = rulesByColumn.get(col)
        if (rule) {
          const sqlExpr = METHOD_SQL[rule.method](col, secret)
          affectedColumns.push(col)
          return `${sqlExpr} AS "${col}"`
        }
        return `"${col}"`
      })

      // Count affected rows (non-null values in any target column)
      const countConditions = rules.map(
        (r) => `"${r.column}" IS NOT NULL`
      ).join(' OR ')
      const countResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${countConditions}`
      )
      totalAffected = Number(countResult[0]?.count ?? 0)

      // Execute CTAS pattern
      const tempTable = `_temp_scrub_batch_${Date.now()}`
      await ctx.db.execute(
        `CREATE TABLE "${tempTable}" AS SELECT ${selectParts.join(', ')} FROM "${tableName}" ORDER BY "_cs_id"`
      )
      await ctx.db.execute(`DROP TABLE "${tableName}"`)
      await ctx.db.execute(`ALTER TABLE "${tempTable}" RENAME TO "${tableName}"`)

      // 3. Create key map table if enabled
      if (generateKeyMap && keyMapData.length > 0) {
        await this.createKeyMapTable(ctx, keyMapData)
      }

      // Get updated metadata
      const columns = await ctx.db.getTableColumns(tableName)
      const rowCountResult = await ctx.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      )
      const rowCount = Number(rowCountResult[0]?.count ?? 0)

      return {
        success: true,
        rowCount,
        columns,
        affected: totalAffected,
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

  /**
   * Capture distinct values and their obfuscated versions for key map
   */
  private async captureKeyMapData(
    ctx: CommandContext,
    rules: ScrubBatchRule[],
    secret?: string
  ): Promise<{ column: string; original: string; obfuscated: string }[]> {
    const result: { column: string; original: string; obfuscated: string }[] = []

    for (const rule of rules) {
      const sqlExpr = METHOD_SQL[rule.method](rule.column, secret)

      // Query distinct values with their obfuscated versions
      const distinctData = await ctx.db.query<{ original: string; obfuscated: string }>(
        `SELECT DISTINCT
          CAST("${rule.column}" AS VARCHAR) as original,
          ${sqlExpr} as obfuscated
        FROM "${ctx.table.name}"
        WHERE "${rule.column}" IS NOT NULL`
      )

      for (const row of distinctData) {
        result.push({
          column: rule.column,
          original: row.original,
          obfuscated: row.obfuscated,
        })
      }
    }

    return result
  }

  /**
   * Create the unified key map table
   */
  private async createKeyMapTable(
    ctx: CommandContext,
    data: { column: string; original: string; obfuscated: string }[]
  ): Promise<void> {
    const keyMapTableName = `${ctx.table.name}_keymap`

    // Drop existing key map if any
    await ctx.db.execute(`DROP TABLE IF EXISTS "${keyMapTableName}"`)

    // Create key map table
    await ctx.db.execute(`
      CREATE TABLE "${keyMapTableName}" (
        column_name VARCHAR,
        original VARCHAR,
        obfuscated VARCHAR
      )
    `)

    // Insert data in batches
    const BATCH_SIZE = 500
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE)
      const values = batch.map((row) => {
        const col = row.column.replace(/'/g, "''")
        const orig = row.original.replace(/'/g, "''")
        const obf = row.obfuscated.replace(/'/g, "''")
        return `('${col}', '${orig}', '${obf}')`
      }).join(',\n')

      await ctx.db.execute(`
        INSERT INTO "${keyMapTableName}" (column_name, original, obfuscated)
        VALUES ${values}
      `)
    }
  }

  getAuditInfo(_ctx: CommandContext, result: ExecutionResult): AuditInfo {
    const { rules, generateKeyMap } = this.params

    const details: TransformAuditDetails = {
      type: 'transform',
      transformationType: 'privacy_batch',
      params: {
        rules: rules.map((r) => ({ column: r.column, method: r.method })),
        generateKeyMap,
      },
    }

    return {
      action: 'Batch Privacy',
      details,
      affectedColumns: rules.map((r) => r.column),
      rowsAffected: result.affected,
      hasRowDetails: false, // Batch operations don't track individual row changes
      auditEntryId: this.id,
      isCapped: false,
    }
  }

  async getAffectedRowsPredicate(_ctx: CommandContext): Promise<string | null> {
    // Return predicate matching any row with non-null value in target columns
    const conditions = this.params.rules.map(
      (r) => `"${r.column}" IS NOT NULL`
    ).join(' OR ')
    return conditions || null
  }
}
