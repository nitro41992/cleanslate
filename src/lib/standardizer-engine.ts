import { query, execute } from '@/lib/duckdb'
import { doubleMetaphone } from '@/lib/fuzzy-matcher'
import { generateId } from '@/lib/utils'
import type { ValueCluster, ClusterValue, ClusteringAlgorithm, StandardizationMapping } from '@/types'

// Maximum unique values we'll cluster (performance threshold)
const MAX_UNIQUE_VALUES = 50_000
// Chunk size for processing values
const CHUNK_SIZE = 5000

/**
 * Progress information for clustering
 */
export interface ClusteringProgressInfo {
  phase: 'validating' | 'clustering' | 'complete'
  currentChunk: number
  totalChunks: number
  progress: number
}

/**
 * Validation result for column clustering
 */
export interface ValidationResult {
  valid: boolean
  uniqueCount: number
  error?: string
}

/**
 * Validate a column for clustering
 * Returns error if unique values exceed threshold
 */
export async function validateColumnForClustering(
  tableName: string,
  columnName: string
): Promise<ValidationResult> {
  try {
    const result = await query<{ count: bigint }>(`
      SELECT COUNT(DISTINCT "${columnName}") as count
      FROM "${tableName}"
      WHERE "${columnName}" IS NOT NULL
        AND TRIM(CAST("${columnName}" AS VARCHAR)) != ''
    `)

    const uniqueCount = Number(result[0].count)

    if (uniqueCount > MAX_UNIQUE_VALUES) {
      return {
        valid: false,
        uniqueCount,
        error: `Column has ${uniqueCount.toLocaleString()} unique values, which exceeds the limit of ${MAX_UNIQUE_VALUES.toLocaleString()}. Please filter the data first.`,
      }
    }

    if (uniqueCount === 0) {
      return {
        valid: false,
        uniqueCount: 0,
        error: 'Column has no non-empty values to cluster.',
      }
    }

    return {
      valid: true,
      uniqueCount,
    }
  } catch (error) {
    return {
      valid: false,
      uniqueCount: 0,
      error: error instanceof Error ? error.message : 'Validation failed',
    }
  }
}

/**
 * Generate fingerprint key for a value
 * Normalization: lowercase → remove accents → remove punctuation → sort tokens → join
 */
export function generateFingerprint(value: string): string {
  if (!value || typeof value !== 'string') return ''

  // Lowercase
  let normalized = value.toLowerCase()

  // Remove accents (basic normalization)
  normalized = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  // Remove punctuation and special characters, keep alphanumeric and spaces
  normalized = normalized.replace(/[^a-z0-9\s]/g, '')

  // Split into tokens, filter empty, sort, and join
  const tokens = normalized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort()

  return tokens.join(' ')
}

/**
 * Generate metaphone key for a value
 * Uses double metaphone for phonetic matching
 */
export function generateMetaphoneKey(value: string): string {
  if (!value || typeof value !== 'string') return ''

  // Use double metaphone from fuzzy-matcher
  const [primary, secondary] = doubleMetaphone(value)

  // Use both codes for better matching
  return primary === secondary ? primary : `${primary}|${secondary}`
}

/**
 * Generate token phonetic key for a value
 * Applies phonetic encoding to each word separately, then sorts and joins
 * Ideal for multi-word values like full names where word order may vary
 *
 * Examples:
 *   "John Smith"  → "JN SM0"
 *   "Jon Smyth"   → "JN SM0"  (same cluster!)
 *   "Smith, John" → "JN SM0"  (same cluster!)
 */
export function generateTokenPhoneticKey(value: string): string {
  if (!value || typeof value !== 'string') return ''

  // Normalize: lowercase, remove accents, remove punctuation except spaces
  const normalized = value.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')

  // Split into tokens, filter empty
  const tokens = normalized.split(/\s+/).filter(t => t.length > 0)

  // Apply metaphone to each token
  const metaphoneCodes = tokens.map(token => {
    const [primary] = doubleMetaphone(token)
    return primary
  }).filter(code => code.length > 0)

  // Sort and join for order-independent matching
  return metaphoneCodes.sort().join(' ')
}

/**
 * Get the clustering key based on algorithm
 */
function getClusterKey(value: string, algorithm: ClusteringAlgorithm): string {
  switch (algorithm) {
    case 'fingerprint':
      return generateFingerprint(value)
    case 'metaphone':
      return generateMetaphoneKey(value)
    case 'token_phonetic':
      return generateTokenPhoneticKey(value)
    default:
      return generateFingerprint(value)
  }
}

/**
 * Build clusters from distinct values
 * Uses chunked processing for scalability
 */
export async function buildClusters(
  tableName: string,
  columnName: string,
  algorithm: ClusteringAlgorithm,
  onProgress: (info: ClusteringProgressInfo) => void,
  shouldCancel: () => boolean
): Promise<ValueCluster[]> {
  // Query all distinct values with counts
  const distinctValues = await query<{ value: string; count: bigint }>(`
    SELECT
      CAST("${columnName}" AS VARCHAR) as value,
      COUNT(*) as count
    FROM "${tableName}"
    WHERE "${columnName}" IS NOT NULL
      AND TRIM(CAST("${columnName}" AS VARCHAR)) != ''
    GROUP BY CAST("${columnName}" AS VARCHAR)
    ORDER BY count DESC
  `)

  if (distinctValues.length === 0) {
    return []
  }

  const totalChunks = Math.ceil(distinctValues.length / CHUNK_SIZE)

  // Map to group values by cluster key
  const clusterMap = new Map<string, { value: string; count: number }[]>()

  // Process in chunks
  for (let chunk = 0; chunk < totalChunks; chunk++) {
    if (shouldCancel()) {
      return []
    }

    const start = chunk * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, distinctValues.length)
    const chunkValues = distinctValues.slice(start, end)

    // Process each value in the chunk
    for (const row of chunkValues) {
      const value = row.value
      const count = Number(row.count)
      const key = getClusterKey(value, algorithm)

      if (!key) continue // Skip empty keys

      if (!clusterMap.has(key)) {
        clusterMap.set(key, [])
      }
      clusterMap.get(key)!.push({ value, count })
    }

    // Report progress
    const progress = Math.round(((chunk + 1) / totalChunks) * 100)
    onProgress({
      phase: 'clustering',
      currentChunk: chunk + 1,
      totalChunks,
      progress,
    })

    // Yield to UI thread between chunks
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  // Convert map to ValueCluster array
  const clusters: ValueCluster[] = []

  for (const [clusterKey, values] of clusterMap) {
    // Sort values by count descending to determine master
    values.sort((a, b) => b.count - a.count)

    const masterValue = values[0].value
    const clusterValues: ClusterValue[] = values.map((v, index) => ({
      id: generateId(),
      value: v.value,
      count: v.count,
      isSelected: true, // Default all selected
      isMaster: index === 0, // First (most frequent) is master
    }))

    // Calculate selected count (all except master)
    const selectedCount = clusterValues.filter((v) => !v.isMaster).length

    clusters.push({
      id: generateId(),
      clusterKey,
      values: clusterValues,
      masterValue,
      selectedCount,
    })
  }

  // Sort clusters by number of values (most actionable first)
  clusters.sort((a, b) => b.values.length - a.values.length)

  onProgress({
    phase: 'complete',
    currentChunk: totalChunks,
    totalChunks,
    progress: 100,
  })

  return clusters
}

/**
 * Ensure standardization audit details table exists
 */
async function ensureStandardizeAuditTable(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS _standardize_audit_details (
      id VARCHAR PRIMARY KEY,
      audit_entry_id VARCHAR NOT NULL,
      from_value VARCHAR NOT NULL,
      to_value VARCHAR NOT NULL,
      row_count INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Create index if not exists
  await execute(`
    CREATE INDEX IF NOT EXISTS idx_standardize_audit_entry
    ON _standardize_audit_details(audit_entry_id)
  `)
}

/**
 * Apply standardization mappings to the table
 * Returns the total number of rows affected
 */
export async function applyStandardization(
  tableName: string,
  columnName: string,
  mappings: StandardizationMapping[],
  auditEntryId: string
): Promise<{ rowsAffected: number; hasRowDetails: boolean; affectedRowIds: string[] }> {
  if (mappings.length === 0) {
    return { rowsAffected: 0, hasRowDetails: false, affectedRowIds: [] }
  }

  // Ensure audit table exists
  await ensureStandardizeAuditTable()

  // Build single UPDATE with CASE-WHEN for efficiency
  const caseWhenClauses = mappings
    .map((m) => {
      const fromEscaped = m.fromValue.replace(/'/g, "''")
      const toEscaped = m.toValue.replace(/'/g, "''")
      return `WHEN CAST("${columnName}" AS VARCHAR) = '${fromEscaped}' THEN '${toEscaped}'`
    })
    .join('\n    ')

  // Build WHERE clause for affected rows
  const whereValues = mappings
    .map((m) => `'${m.fromValue.replace(/'/g, "''")}'`)
    .join(', ')

  // PRE-CHECK: Count rows that would actually change (idempotency check)
  // A row changes only if it matches a from-value AND the from-value differs from to-value
  const changesNeededQuery = `
    SELECT COUNT(*) as count FROM "${tableName}"
    WHERE CAST("${columnName}" AS VARCHAR) IN (${whereValues})
      AND "${columnName}" IS DISTINCT FROM (CASE
        ${caseWhenClauses}
        ELSE "${columnName}"
        END)
  `
  const changesResult = await query<{ count: bigint }>(changesNeededQuery)
  const rowsNeedingChange = Number(changesResult[0]?.count ?? 0)

  // If no rows would actually change, return early (idempotent - already standardized)
  if (rowsNeedingChange === 0) {
    console.log('[StandardizeApply] No rows need changing - values already standardized')
    return { rowsAffected: 0, hasRowDetails: false, affectedRowIds: [] }
  }

  // Query affected row IDs BEFORE the update (for highlighting support)
  // Only include rows that will actually change
  let affectedRowIds: string[] = []
  try {
    const rowIdQuery = `
      SELECT _cs_id FROM "${tableName}"
      WHERE CAST("${columnName}" AS VARCHAR) IN (${whereValues})
        AND "${columnName}" IS DISTINCT FROM (CASE
          ${caseWhenClauses}
          ELSE "${columnName}"
          END)
    `
    const rowIdResult = await query<{ _cs_id: string }>(rowIdQuery)
    affectedRowIds = rowIdResult.map((row) => row._cs_id)
  } catch (e) {
    // If _cs_id doesn't exist or query fails, continue without row IDs
    console.warn('Could not get affected row IDs for highlighting:', e)
  }

  // Execute UPDATE with IS DISTINCT FROM to only update rows that actually change
  const sql = `
    UPDATE "${tableName}"
    SET "${columnName}" = CASE
    ${caseWhenClauses}
    ELSE "${columnName}"
    END
    WHERE CAST("${columnName}" AS VARCHAR) IN (${whereValues})
      AND "${columnName}" IS DISTINCT FROM (CASE
        ${caseWhenClauses}
        ELSE "${columnName}"
        END)
  `

  await execute(sql)

  // Record audit details - always store value mappings since they're small
  // (we store value->value mappings, not row-level data, so even with many rows
  // we typically only have a handful of mappings)
  for (const mapping of mappings) {
    const id = generateId()
    const fromEscaped = mapping.fromValue.replace(/'/g, "''")
    const toEscaped = mapping.toValue.replace(/'/g, "''")

    await execute(`
      INSERT INTO _standardize_audit_details (id, audit_entry_id, from_value, to_value, row_count, created_at)
      VALUES ('${id}', '${auditEntryId}', '${fromEscaped}', '${toEscaped}', ${mapping.rowCount}, CURRENT_TIMESTAMP)
    `)
  }

  // Always true for standardization since we store value mappings, not row-level data
  const hasRowDetails = true

  return { rowsAffected: rowsNeedingChange, hasRowDetails, affectedRowIds }
}

/**
 * Get standardization audit details for a specific audit entry
 */
export async function getStandardizeAuditDetails(
  auditEntryId: string
): Promise<{
  id: string
  fromValue: string
  toValue: string
  rowCount: number
}[]> {
  try {
    await ensureStandardizeAuditTable()

    const results = await query<{
      id: string
      from_value: string
      to_value: string
      row_count: number
    }>(`
      SELECT id, from_value, to_value, row_count
      FROM _standardize_audit_details
      WHERE audit_entry_id = '${auditEntryId.replace(/'/g, "''")}'
      ORDER BY row_count DESC
    `)

    return results.map((row) => ({
      id: row.id,
      fromValue: row.from_value,
      toValue: row.to_value,
      rowCount: row.row_count,
    }))
  } catch (e) {
    console.error('Failed to get standardize audit details:', e)
    return []
  }
}
