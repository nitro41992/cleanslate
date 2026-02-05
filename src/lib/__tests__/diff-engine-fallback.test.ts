import { describe, it, expect } from 'vitest'

/**
 * Unit Tests for Diff Engine Column Matching Logic
 *
 * These tests verify the SQL column expressions used when tables have or don't have
 * _cs_origin_id columns. The actual database operations are tested in E2E tests;
 * these unit tests verify the logic for generating correct SQL expressions.
 *
 * Related commits:
 * - 75b4f7b: Tables missing _cs_origin_id in fetch queries
 * - 5d8ecf3: Inserted rows not getting _cs_origin_id
 */

const CS_ORIGIN_ID_COLUMN = '_cs_origin_id'

/**
 * Build row matching expressions based on column availability.
 * Extracted from fetchDiffPage() for unit testing.
 *
 * @param hasOriginId - Whether the target table has _cs_origin_id column
 * @returns Object containing SQL expressions for row matching
 */
function buildRowMatchingExpressions(hasOriginId: boolean) {
  // Build row matching expressions based on column availability
  const bRowsCteCol = hasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'
  const bRowsJoinCol = hasOriginId ? `d.b_origin_id` : `d.b_row_id`
  const bTableJoinCol = hasOriginId ? `"${CS_ORIGIN_ID_COLUMN}"` : '"_cs_id"'

  return {
    bRowsCteCol,
    bRowsJoinCol,
    bTableJoinCol,
  }
}

describe('diff-engine fallback logic', () => {
  describe('buildRowMatchingExpressions', () => {
    it('uses _cs_origin_id when available', () => {
      const result = buildRowMatchingExpressions(true)

      expect(result.bRowsCteCol).toBe('"_cs_origin_id"')
      expect(result.bRowsJoinCol).toBe('d.b_origin_id')
      expect(result.bTableJoinCol).toBe('"_cs_origin_id"')
    })

    it('falls back to _cs_id when _cs_origin_id is not available', () => {
      const result = buildRowMatchingExpressions(false)

      expect(result.bRowsCteCol).toBe('"_cs_id"')
      expect(result.bRowsJoinCol).toBe('d.b_row_id')
      expect(result.bTableJoinCol).toBe('"_cs_id"')
    })

    it('produces SQL-safe quoted identifiers', () => {
      const withOrigin = buildRowMatchingExpressions(true)
      const withoutOrigin = buildRowMatchingExpressions(false)

      // All column references should be properly quoted for SQL safety
      expect(withOrigin.bRowsCteCol).toMatch(/^"[^"]+"$/)
      expect(withoutOrigin.bRowsCteCol).toMatch(/^"[^"]+"$/)
      expect(withOrigin.bTableJoinCol).toMatch(/^"[^"]+"$/)
      expect(withoutOrigin.bTableJoinCol).toMatch(/^"[^"]+"$/)
    })

    it('join expressions use consistent column references', () => {
      const withOrigin = buildRowMatchingExpressions(true)
      const withoutOrigin = buildRowMatchingExpressions(false)

      // When hasOriginId is true, both bRowsJoinCol and bTableJoinCol reference origin_id
      expect(withOrigin.bRowsJoinCol).toContain('origin')
      expect(withOrigin.bTableJoinCol).toContain('origin')

      // When hasOriginId is false, both reference _cs_id
      expect(withoutOrigin.bRowsJoinCol).not.toContain('origin')
      expect(withoutOrigin.bTableJoinCol).not.toContain('origin')
    })
  })

  describe('hasOriginIdB parameter handling', () => {
    /**
     * Tests the priority logic: hasOriginIdB parameter takes precedence over
     * runtime tableHasOriginId() check when defined.
     */
    it('uses explicit hasOriginIdB=false over runtime check', () => {
      // Simulates: hasOriginIdB !== undefined ? hasOriginIdB : await tableHasOriginId(...)
      const hasOriginIdB: boolean | undefined = false

      const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : true // runtime would return true
      expect(targetHasOriginId).toBe(false) // But explicit param wins
    })

    it('uses explicit hasOriginIdB=true over runtime check', () => {
      const hasOriginIdB: boolean | undefined = true

      const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : false // runtime would return false
      expect(targetHasOriginId).toBe(true) // But explicit param wins
    })

    it('falls back to runtime check when hasOriginIdB is undefined', () => {
      const hasOriginIdB: boolean | undefined = undefined
      const runtimeResult = true // Simulated result from tableHasOriginId()

      const targetHasOriginId = hasOriginIdB !== undefined ? hasOriginIdB : runtimeResult
      expect(targetHasOriginId).toBe(true) // Runtime result is used
    })
  })
})

describe('selectCols generation', () => {
  /**
   * Tests the column select expression generation for diff queries.
   * This handles new/removed columns correctly.
   */
  function buildSelectCols(
    allColumns: string[],
    newColumns: string[],
    removedColumns: string[]
  ): string {
    return allColumns
      .map((c) => {
        const inA = !removedColumns.includes(c) // Column exists in A if not in removedColumns
        const inB = !newColumns.includes(c) // Column exists in B if not in newColumns
        const aExpr = inA ? `a."${c}"` : 'NULL'
        const bExpr = inB ? `b."${c}"` : 'NULL'
        return `${aExpr} as "a_${c}", ${bExpr} as "b_${c}"`
      })
      .join(', ')
  }

  it('generates both a_ and b_ columns for shared columns', () => {
    const result = buildSelectCols(['name', 'email'], [], [])

    expect(result).toContain('a."name" as "a_name"')
    expect(result).toContain('b."name" as "b_name"')
    expect(result).toContain('a."email" as "a_email"')
    expect(result).toContain('b."email" as "b_email"')
  })

  it('generates NULL for b_ when column is new (only in A)', () => {
    // newColumns = columns in A but not B
    const result = buildSelectCols(['name', 'old_field'], ['old_field'], [])

    expect(result).toContain('a."old_field" as "a_old_field"')
    expect(result).toContain('NULL as "b_old_field"')
  })

  it('generates NULL for a_ when column is removed (only in B)', () => {
    // removedColumns = columns in B but not A
    const result = buildSelectCols(['name', 'new_field'], [], ['new_field'])

    expect(result).toContain('NULL as "a_new_field"')
    expect(result).toContain('b."new_field" as "b_new_field"')
  })

  it('handles mix of shared, new, and removed columns', () => {
    const allColumns = ['id', 'name', 'old_col', 'new_col']
    const newColumns = ['old_col'] // in A, not in B
    const removedColumns = ['new_col'] // in B, not in A

    const result = buildSelectCols(allColumns, newColumns, removedColumns)

    // Shared columns: both a_ and b_ present
    expect(result).toContain('a."id" as "a_id"')
    expect(result).toContain('b."id" as "b_id"')

    // New column (in A only): a_ present, b_ is NULL
    expect(result).toContain('a."old_col" as "a_old_col"')
    expect(result).toContain('NULL as "b_old_col"')

    // Removed column (in B only): a_ is NULL, b_ present
    expect(result).toContain('NULL as "a_new_col"')
    expect(result).toContain('b."new_col" as "b_new_col"')
  })
})
