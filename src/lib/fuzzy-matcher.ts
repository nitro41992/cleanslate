import { query, initDuckDB } from '@/lib/duckdb'
import { withDuckDBLock } from './duckdb/lock'
import type { MatchPair, BlockingStrategy, FieldSimilarity, FieldSimilarityStatus } from '@/types'
import { generateId } from '@/lib/utils'
import {
  generateFingerprint,
  generateMetaphoneKey,
  generateTokenPhoneticKey,
} from '@/lib/standardizer-engine'

/**
 * Block analysis result for chunked processing
 */
interface BlockInfo {
  blockKey: string
  size: number
  strategy: 'full' | 'strict' | 'sample'
}

/**
 * Progress information for chunked matching
 */
export interface ChunkedProgressInfo {
  phase: 'analyzing' | 'processing' | 'complete'
  currentBlock: number
  totalBlocks: number
  pairsFound: number
  maybeCount: number       // Uncertain pairs (need human review)
  definiteCount: number    // High confidence pairs
  currentBlockKey?: string
  oversizedBlocks: number
}

/**
 * Result from chunked matching
 */
export interface ChunkedMatchResult {
  pairs: MatchPair[]
  totalFound: number
  oversizedBlocksCount: number
  blocksProcessed: number
  totalBlocks: number
}

/**
 * Convert Levenshtein distance to similarity percentage (0-100)
 * Higher = more similar (intuitive for users)
 */
export function distanceToSimilarity(distance: number, maxLength: number): number {
  if (maxLength === 0) return 100
  const similarity = Math.max(0, 100 - (distance / maxLength) * 100)
  return Math.round(similarity * 10) / 10 // Round to 1 decimal
}

/**
 * Calculate Jaro similarity between two strings
 * Returns 0-1 where 1 is exact match
 */
function jaroSimilarity(s1: string, s2: string): number {
  const a = s1.toLowerCase()
  const b = s2.toLowerCase()

  if (a === b) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  // Maximum matching distance
  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1

  const aMatches = new Array(a.length).fill(false)
  const bMatches = new Array(b.length).fill(false)

  let matches = 0
  let transpositions = 0

  // Find matches
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, b.length)

    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0.0

  // Count transpositions
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }

  return (
    (matches / a.length +
      matches / b.length +
      (matches - transpositions / 2) / matches) /
    3
  )
}

/**
 * Calculate Jaro-Winkler similarity between two strings
 * Adds a prefix bonus to Jaro similarity for strings that match at the beginning
 * Returns 0-100 percentage (higher = more similar)
 *
 * Jaro-Winkler is better than Levenshtein for names because:
 * - Weights prefix matches higher (important for names)
 * - Handles transpositions better (Jon vs John)
 * - More forgiving of minor character differences
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2)

  // Find common prefix (up to 4 characters)
  const a = s1.toLowerCase()
  const b = s2.toLowerCase()
  let prefix = 0
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }

  // Winkler modification: scaling factor of 0.1
  const similarity = jaro + prefix * 0.1 * (1 - jaro)

  // Convert to 0-100 scale and round to 1 decimal
  return Math.round(similarity * 1000) / 10
}

/**
 * Double Metaphone encoding for phonetic matching
 * Simplified implementation that handles common English name variations
 */
export function doubleMetaphone(text: string): [string, string] {
  if (!text) return ['', '']

  const str = text.toUpperCase().replace(/[^A-Z]/g, '')
  if (str.length === 0) return ['', '']

  let primary = ''
  let secondary = ''
  let current = 0

  const charAt = (pos: number) => str[pos] || ''
  const stringAt = (start: number, length: number, ...matches: string[]) => {
    const substr = str.substring(start, start + length)
    return matches.some(m => m === substr)
  }

  // Skip initial silent letters
  if (stringAt(0, 2, 'GN', 'KN', 'PN', 'WR', 'PS')) {
    current++
  }

  // Handle initial X
  if (charAt(0) === 'X') {
    primary += 'S'
    secondary += 'S'
    current++
  }

  while (current < str.length && (primary.length < 4 || secondary.length < 4)) {
    const char = charAt(current)

    switch (char) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        if (current === 0) {
          primary += 'A'
          secondary += 'A'
        }
        current++
        break

      case 'B':
        primary += 'P'
        secondary += 'P'
        current += charAt(current + 1) === 'B' ? 2 : 1
        break

      case 'C':
        if (stringAt(current, 2, 'CH')) {
          primary += 'X'
          secondary += 'X'
          current += 2
        } else if (stringAt(current, 2, 'CI', 'CE', 'CY')) {
          primary += 'S'
          secondary += 'S'
          current += 1
        } else {
          primary += 'K'
          secondary += 'K'
          current += stringAt(current, 2, 'CK', 'CC') ? 2 : 1
        }
        break

      case 'D':
        if (stringAt(current, 2, 'DG')) {
          if (stringAt(current + 2, 1, 'I', 'E', 'Y')) {
            primary += 'J'
            secondary += 'J'
            current += 3
          } else {
            primary += 'TK'
            secondary += 'TK'
            current += 2
          }
        } else {
          primary += 'T'
          secondary += 'T'
          current += stringAt(current, 2, 'DT', 'DD') ? 2 : 1
        }
        break

      case 'F':
        primary += 'F'
        secondary += 'F'
        current += charAt(current + 1) === 'F' ? 2 : 1
        break

      case 'G':
        if (charAt(current + 1) === 'H') {
          if (current > 0 && !stringAt(current - 1, 1, 'A', 'E', 'I', 'O', 'U')) {
            primary += 'K'
            secondary += 'K'
            current += 2
          } else if (current === 0) {
            primary += 'K'
            secondary += 'K'
            current += 2
          } else {
            current += 2
          }
        } else if (charAt(current + 1) === 'N') {
          if (current === 0) {
            current += 2
          } else {
            primary += 'KN'
            secondary += 'N'
            current += 2
          }
        } else if (stringAt(current + 1, 1, 'I', 'E', 'Y')) {
          primary += 'J'
          secondary += 'K'
          current += 2
        } else {
          primary += 'K'
          secondary += 'K'
          current += charAt(current + 1) === 'G' ? 2 : 1
        }
        break

      case 'H':
        if (current === 0 || stringAt(current - 1, 1, 'A', 'E', 'I', 'O', 'U')) {
          if (stringAt(current + 1, 1, 'A', 'E', 'I', 'O', 'U')) {
            primary += 'H'
            secondary += 'H'
          }
        }
        current++
        break

      case 'J':
        primary += 'J'
        secondary += 'J'
        current += charAt(current + 1) === 'J' ? 2 : 1
        break

      case 'K':
        primary += 'K'
        secondary += 'K'
        current += charAt(current + 1) === 'K' ? 2 : 1
        break

      case 'L':
        primary += 'L'
        secondary += 'L'
        current += charAt(current + 1) === 'L' ? 2 : 1
        break

      case 'M':
        primary += 'M'
        secondary += 'M'
        current += charAt(current + 1) === 'M' ? 2 : 1
        break

      case 'N':
        primary += 'N'
        secondary += 'N'
        current += charAt(current + 1) === 'N' ? 2 : 1
        break

      case 'P':
        if (charAt(current + 1) === 'H') {
          primary += 'F'
          secondary += 'F'
          current += 2
        } else {
          primary += 'P'
          secondary += 'P'
          current += stringAt(current, 2, 'PP', 'PB') ? 2 : 1
        }
        break

      case 'Q':
        primary += 'K'
        secondary += 'K'
        current += charAt(current + 1) === 'Q' ? 2 : 1
        break

      case 'R':
        primary += 'R'
        secondary += 'R'
        current += charAt(current + 1) === 'R' ? 2 : 1
        break

      case 'S':
        if (stringAt(current, 2, 'SH')) {
          primary += 'X'
          secondary += 'X'
          current += 2
        } else if (stringAt(current, 3, 'SIO', 'SIA')) {
          primary += 'X'
          secondary += 'S'
          current += 3
        } else {
          primary += 'S'
          secondary += 'S'
          current += stringAt(current, 2, 'SS', 'SC') ? 2 : 1
        }
        break

      case 'T':
        if (stringAt(current, 4, 'TION')) {
          primary += 'X'
          secondary += 'X'
          current += 4
        } else if (stringAt(current, 2, 'TH')) {
          primary += '0' // Theta
          secondary += 'T'
          current += 2
        } else {
          primary += 'T'
          secondary += 'T'
          current += stringAt(current, 2, 'TT', 'TD') ? 2 : 1
        }
        break

      case 'V':
        primary += 'F'
        secondary += 'F'
        current += charAt(current + 1) === 'V' ? 2 : 1
        break

      case 'W':
        if (stringAt(current + 1, 1, 'A', 'E', 'I', 'O', 'U')) {
          primary += 'A'
          secondary += 'A'
        }
        current++
        break

      case 'X':
        primary += 'KS'
        secondary += 'KS'
        current += charAt(current + 1) === 'X' ? 2 : 1
        break

      case 'Z':
        primary += 'S'
        secondary += 'S'
        current += charAt(current + 1) === 'Z' ? 2 : 1
        break

      default:
        current++
    }
  }

  return [primary.substring(0, 4), secondary.substring(0, 4)]
}

/**
 * Generate bigrams (2-character sequences) from text for n-gram blocking
 */
export function generateBigrams(text: string): string[] {
  if (!text || text.length < 2) return []

  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const bigrams: string[] = []

  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.push(normalized.substring(i, i + 2))
  }

  return [...new Set(bigrams)] // Return unique bigrams
}

/**
 * Calculate field-by-field similarities for a match pair
 * Uses Jaro-Winkler for better name matching (prefix-weighted, transposition-friendly)
 */
export function calculateFieldSimilarities(
  rowA: Record<string, unknown>,
  rowB: Record<string, unknown>,
  columns: string[]
): FieldSimilarity[] {
  return columns.map((column) => {
    const valueA = rowA[column]
    const valueB = rowB[column]

    // Stringify values for comparison
    const strA = valueA === null || valueA === undefined ? '' : String(valueA)
    const strB = valueB === null || valueB === undefined ? '' : String(valueB)

    // Calculate similarity using Jaro-Winkler (better for names)
    let similarity: number
    if (strA === strB) {
      similarity = 100
    } else if (strA === '' || strB === '') {
      similarity = 0
    } else {
      similarity = jaroWinklerSimilarity(strA, strB)
    }

    // Determine status
    let status: FieldSimilarityStatus
    if (similarity === 100) {
      status = 'exact'
    } else if (similarity >= 70) {
      status = 'similar'
    } else {
      status = 'different'
    }

    return {
      column,
      valueA,
      valueB,
      similarity,
      status,
    }
  })
}

/**
 * Stratified sampling: ensure fuzzy matches are visible and limit total pairs
 * to prevent UI from crashing with too many results.
 *
 * Strategy:
 * - All fuzzy matches (< 100% similarity) are prioritized - these are the most valuable
 * - Exact matches (100%) are sampled if we exceed the limit
 * - Maximum 10,000 pairs returned to keep UI responsive
 */
const MAX_PAIRS = 10000

function stratifiedSort(pairs: MatchPair[]): MatchPair[] {
  const exactMatches: MatchPair[] = []
  const fuzzyMatches: MatchPair[] = []

  for (const pair of pairs) {
    if (pair.similarity === 100) {
      exactMatches.push(pair)
    } else {
      fuzzyMatches.push(pair)
    }
  }

  // Sort fuzzy matches by similarity descending
  fuzzyMatches.sort((a, b) => b.similarity - a.similarity)

  // If fuzzy matches alone exceed limit, take top ones
  if (fuzzyMatches.length >= MAX_PAIRS) {
    return fuzzyMatches.slice(0, MAX_PAIRS)
  }

  // Calculate how many exact matches we can include
  const remainingSlots = MAX_PAIRS - fuzzyMatches.length

  // Sample exact matches if there are too many
  let sampledExact: MatchPair[]
  if (exactMatches.length <= remainingSlots) {
    sampledExact = exactMatches
  } else {
    // Take evenly distributed sample of exact matches
    sampledExact = []
    const step = exactMatches.length / remainingSlots
    for (let i = 0; i < remainingSlots; i++) {
      sampledExact.push(exactMatches[Math.floor(i * step)])
    }
  }

  // Fuzzy matches first (most valuable), then exact matches
  return [...fuzzyMatches, ...sampledExact]
}

/**
 * Check if a blocking strategy requires phonetic key preprocessing in JavaScript
 */
function isPhoneticBlockingStrategy(strategy: BlockingStrategy): boolean {
  return ['fingerprint_block', 'metaphone_block', 'token_phonetic_block'].includes(strategy)
}

/**
 * Generate a blocking key for a value based on the algorithm
 */
function generateBlockingKey(value: string, strategy: BlockingStrategy): string {
  if (!value) return ''
  switch (strategy) {
    case 'fingerprint_block':
      return generateFingerprint(value)
    case 'metaphone_block':
      return generateMetaphoneKey(value)
    case 'token_phonetic_block':
      return generateTokenPhoneticKey(value)
    default:
      return value
  }
}

/**
 * Create a temporary table with phonetic blocking keys
 * Uses CSV registration for bulk loading (much faster than individual INSERTs)
 *
 * CRITICAL: Only process DISTINCT values from the match column to avoid O(n) JS processing
 * For 1M rows with 50k distinct values, we process 50k not 1M
 */
async function createPhoneticBlockingTable(
  tableName: string,
  matchColumn: string,
  strategy: BlockingStrategy
): Promise<string> {
  const tempTableName = `_phonetic_keys_${Date.now()}`

  // 1. Query DISTINCT values only (crucial for performance)
  const distinctValues = await query<{ value: string }>(`
    SELECT DISTINCT CAST("${matchColumn}" AS VARCHAR) as value
    FROM "${tableName}"
    WHERE "${matchColumn}" IS NOT NULL
      AND LENGTH(TRIM(CAST("${matchColumn}" AS VARCHAR))) > 0
  `)

  if (distinctValues.length === 0) {
    // Create empty table
    await query(`CREATE TEMP TABLE ${tempTableName} (value VARCHAR, block_key VARCHAR)`)
    return tempTableName
  }

  // 2. Generate keys in JavaScript
  const mappings: { value: string; key: string }[] = []
  for (const row of distinctValues) {
    const value = row.value
    const key = generateBlockingKey(value, strategy)
    if (key) {
      mappings.push({ value, key })
    }
  }

  // 3. Bulk load via CSV registration
  // Escape CSV values: wrap in quotes, escape internal quotes by doubling
  const escapeCsvValue = (s: string) => `"${s.replace(/"/g, '""')}"`
  const csvContent = 'value,block_key\n' +
    mappings.map(m => `${escapeCsvValue(m.value)},${escapeCsvValue(m.key)}`).join('\n')

  // Register CSV and create temp table
  const db = await initDuckDB()
  const csvFileName = `_phonetic_keys_${Date.now()}.csv`
  await db.registerFileText(csvFileName, csvContent)

  await query(`
    CREATE TEMP TABLE ${tempTableName} AS
    SELECT * FROM read_csv_auto('${csvFileName}', header=true)
  `)

  return tempTableName
}

/**
 * Check if a strategy is a fast SQL-only strategy (no JS preprocessing)
 */
function isFastSqlStrategy(strategy: BlockingStrategy): boolean {
  return ['first_letter', 'first_2_chars', 'none'].includes(strategy)
}

/**
 * Get blocking key SQL expression based on strategy
 * For phonetic strategies, this returns a placeholder that will be replaced by JOIN
 */
function getBlockKeyExpr(matchColumn: string, blockingStrategy: BlockingStrategy): string {
  switch (blockingStrategy) {
    // Fast SQL-only strategies
    case 'first_letter':
      return `UPPER(SUBSTR("${matchColumn}", 1, 1))`
    case 'first_2_chars':
      return `UPPER(SUBSTR(REGEXP_REPLACE("${matchColumn}", '[^A-Za-z0-9]', '', 'g'), 1, 2))`
    case 'none':
      return `'ALL'`
    // Phonetic strategies use temp table JOIN, not SQL expression
    case 'fingerprint_block':
    case 'metaphone_block':
    case 'token_phonetic_block':
      return `'PHONETIC'`
    default:
      return `'PHONETIC'`
  }
}

/**
 * Analyze block distribution for chunked processing
 * Returns blocks sorted by size (smallest first for faster progress)
 *
 * For phonetic strategies, uses the temp table created by createPhoneticBlockingTable
 */
async function analyzeBlocks(
  tableName: string,
  matchColumn: string,
  blockKeyExpr: string,
  phoneticTableName?: string
): Promise<BlockInfo[]> {
  let sql: string

  if (phoneticTableName) {
    // For phonetic strategies, join with the temp table to get block keys
    sql = `
      SELECT
        pk.block_key,
        COUNT(*) as cnt
      FROM "${tableName}" t
      INNER JOIN ${phoneticTableName} pk
        ON CAST(t."${matchColumn}" AS VARCHAR) = pk.value
      WHERE t."${matchColumn}" IS NOT NULL
        AND LENGTH(TRIM(CAST(t."${matchColumn}" AS VARCHAR))) > 0
      GROUP BY pk.block_key
      ORDER BY cnt ASC
    `
  } else {
    sql = `
      SELECT
        ${blockKeyExpr} as block_key,
        COUNT(*) as cnt
      FROM "${tableName}"
      WHERE "${matchColumn}" IS NOT NULL
        AND LENGTH(COALESCE("${matchColumn}", '')) > 0
      GROUP BY block_key
      ORDER BY cnt ASC
    `
  }

  const result = await query<{ block_key: string; cnt: number }>(sql)

  return result.map((r) => ({
    blockKey: r.block_key ?? 'NULL',
    size: Number(r.cnt),
    strategy: r.cnt < 500 ? 'full' : r.cnt < 2000 ? 'strict' : 'sample',
  }))
}

/**
 * Process a single block and return match pairs using Jaro-Winkler similarity
 */
async function processBlock(
  tableName: string,
  matchColumn: string,
  blockKey: string,
  blockKeyExpr: string,
  strategy: 'full' | 'strict' | 'sample',
  jwThreshold: number,
  columns: string[],
  phoneticTableName?: string
): Promise<{
  results: Record<string, unknown>[]
  wasSampled: boolean
}> {
  // Build select columns for both a and b
  const selectColsA = columns.map((c) => `a."${c}" as "a_${c}"`).join(', ')
  const selectColsB = columns.map((c) => `b."${c}" as "b_${c}"`).join(', ')

  // Stricter threshold for large blocks (add 5% to threshold)
  const effectiveThreshold = strategy === 'strict'
    ? Math.min(0.95, jwThreshold + 0.05)
    : jwThreshold

  // For sampled blocks, limit input rows
  const sampleClause = strategy === 'sample'
    ? 'ORDER BY RANDOM() LIMIT 500'
    : ''

  const escapedBlockKey = blockKey.replace(/'/g, "''")
  let sql: string

  if (phoneticTableName) {
    // Phonetic blocking: join with temp table
    if (strategy === 'sample') {
      sql = `
        WITH sampled_data AS (
          SELECT t.*
          FROM "${tableName}" t
          INNER JOIN ${phoneticTableName} pk
            ON CAST(t."${matchColumn}" AS VARCHAR) = pk.value
          WHERE pk.block_key = '${escapedBlockKey}'
            AND t."${matchColumn}" IS NOT NULL
            AND LENGTH(TRIM(CAST(t."${matchColumn}" AS VARCHAR))) > 0
          ${sampleClause}
        ),
        block_data AS (
          SELECT ROW_NUMBER() OVER () as row_id, *
          FROM sampled_data
        )
        SELECT
          ${selectColsA},
          ${selectColsB},
          jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) as similarity
        FROM block_data a
        JOIN block_data b ON a.row_id < b.row_id
        WHERE jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) >= ${effectiveThreshold}
        ORDER BY similarity DESC
        LIMIT 1000
      `
    } else {
      sql = `
        WITH block_data AS (
          SELECT ROW_NUMBER() OVER () as row_id, t.*
          FROM "${tableName}" t
          INNER JOIN ${phoneticTableName} pk
            ON CAST(t."${matchColumn}" AS VARCHAR) = pk.value
          WHERE pk.block_key = '${escapedBlockKey}'
            AND t."${matchColumn}" IS NOT NULL
            AND LENGTH(TRIM(CAST(t."${matchColumn}" AS VARCHAR))) > 0
        )
        SELECT
          ${selectColsA},
          ${selectColsB},
          jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) as similarity
        FROM block_data a
        JOIN block_data b ON a.row_id < b.row_id
        WHERE jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) >= ${effectiveThreshold}
        ORDER BY similarity DESC
        LIMIT 1000
      `
    }
  } else {
    // Legacy SQL-based blocking
    if (strategy === 'sample') {
      sql = `
        WITH sampled_data AS (
          SELECT *
          FROM "${tableName}"
          WHERE ${blockKeyExpr} = '${escapedBlockKey}'
            AND "${matchColumn}" IS NOT NULL
            AND LENGTH(COALESCE("${matchColumn}", '')) > 0
          ${sampleClause}
        ),
        block_data AS (
          SELECT ROW_NUMBER() OVER () as row_id, *
          FROM sampled_data
        )
        SELECT
          ${selectColsA},
          ${selectColsB},
          jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) as similarity
        FROM block_data a
        JOIN block_data b ON a.row_id < b.row_id
        WHERE jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) >= ${effectiveThreshold}
        ORDER BY similarity DESC
        LIMIT 1000
      `
    } else {
      sql = `
        WITH block_data AS (
          SELECT ROW_NUMBER() OVER () as row_id, *
          FROM "${tableName}"
          WHERE ${blockKeyExpr} = '${escapedBlockKey}'
            AND "${matchColumn}" IS NOT NULL
            AND LENGTH(COALESCE("${matchColumn}", '')) > 0
        )
        SELECT
          ${selectColsA},
          ${selectColsB},
          jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) as similarity
        FROM block_data a
        JOIN block_data b ON a.row_id < b.row_id
        WHERE jaro_winkler_similarity(
            LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
            LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
          ) >= ${effectiveThreshold}
        ORDER BY similarity DESC
        LIMIT 1000
      `
    }
  }

  const results = await query<Record<string, unknown>>(sql)
  return {
    results,
    wasSampled: strategy === 'sample',
  }
}

/**
 * Find duplicates using chunked multi-pass processing with Jaro-Winkler similarity
 *
 * This approach:
 * 1. Analyzes block distribution first (fast)
 * 2. Processes each block separately (bounded memory)
 * 3. Reports progress after each block
 * 4. Handles oversized blocks by sampling
 * 5. Supports cancellation between blocks
 *
 * Phonetic blocking strategies (fingerprint, metaphone, token_phonetic) use
 * JavaScript preprocessing with bulk CSV registration.
 *
 * Scales to 2M+ rows with predictable performance.
 */
export async function findDuplicatesChunked(
  tableName: string,
  matchColumn: string,
  blockingStrategy: BlockingStrategy,
  definiteThreshold: number,
  maybeThreshold: number,
  onProgress: (info: ChunkedProgressInfo) => void,
  shouldCancel: () => boolean
): Promise<ChunkedMatchResult> {
  return withDuckDBLock(async () => {
    const columns = await getTableColumns(tableName)
    const blockKeyExpr = getBlockKeyExpr(matchColumn, blockingStrategy)
    // Convert threshold from percentage to 0-1 scale for Jaro-Winkler
    const jwThreshold = maybeThreshold / 100

    // Phase 1: Analyze block distribution
    onProgress({
      phase: 'analyzing',
      currentBlock: 0,
      totalBlocks: 0,
      pairsFound: 0,
      maybeCount: 0,
      definiteCount: 0,
      oversizedBlocks: 0,
    })

    // For phonetic strategies, create the temp table first
    let phoneticTableName: string | undefined
    if (isPhoneticBlockingStrategy(blockingStrategy)) {
      phoneticTableName = await createPhoneticBlockingTable(tableName, matchColumn, blockingStrategy)
    }

    try {
      const blocks = await analyzeBlocks(tableName, matchColumn, blockKeyExpr, phoneticTableName)
      const oversizedCount = blocks.filter((b) => b.strategy === 'sample').length

      if (shouldCancel()) {
        return {
          pairs: [],
          totalFound: 0,
          oversizedBlocksCount: oversizedCount,
          blocksProcessed: 0,
          totalBlocks: blocks.length,
        }
      }

      // Phase 2: Process blocks sequentially
      const allPairs: MatchPair[] = []
      let maybeCount = 0
      let definiteCount = 0

      for (let i = 0; i < blocks.length; i++) {
        if (shouldCancel()) break

        const block = blocks[i]
        onProgress({
          phase: 'processing',
          currentBlock: i + 1,
          totalBlocks: blocks.length,
          pairsFound: allPairs.length,
          maybeCount,
          definiteCount,
          currentBlockKey: block.blockKey,
          oversizedBlocks: oversizedCount,
        })

        try {
          const { results } = await processBlock(
            tableName,
            matchColumn,
            block.blockKey,
            blockKeyExpr,
            block.strategy,
            jwThreshold,
            columns,
            phoneticTableName
          )

          // Convert results to MatchPair objects
          for (const row of results) {
            const rowA = extractRow(row, columns, 'a_')
            const rowB = extractRow(row, columns, 'b_')
            // Jaro-Winkler returns 0-1, convert to 0-100
            const similarity = Math.round(Number(row.similarity) * 1000) / 10

            // Filter by minimum threshold (double-check)
            if (similarity < maybeThreshold) continue

            const fieldSimilarities = calculateFieldSimilarities(rowA, rowB, columns)

            const pair: MatchPair = {
              id: generateId(),
              rowA,
              rowB,
              score: Math.round(100 - similarity), // Backwards compat: lower score = better match
              similarity,
              fieldSimilarities,
              status: 'pending',
              keepRow: 'A',
            }

            allPairs.push(pair)

            // Track counts
            if (similarity >= definiteThreshold) {
              definiteCount++
            } else {
              maybeCount++
            }
          }
        } catch (error) {
          console.error(`Error processing block ${block.blockKey}:`, error)
          // Continue with next block
        }
      }

      // Phase 3: Complete
      onProgress({
        phase: 'complete',
        currentBlock: blocks.length,
        totalBlocks: blocks.length,
        pairsFound: allPairs.length,
        maybeCount,
        definiteCount,
        oversizedBlocks: oversizedCount,
      })

      // Apply stratified sorting: fuzzy matches first (most valuable for human review)
      const sortedPairs = stratifiedSort(allPairs)

      return {
        pairs: sortedPairs,
        totalFound: allPairs.length,
        oversizedBlocksCount: oversizedCount,
        blocksProcessed: blocks.length,
        totalBlocks: blocks.length,
      }
    } finally {
      // Clean up temp table if created
      if (phoneticTableName) {
        try {
          await query(`DROP TABLE IF EXISTS ${phoneticTableName}`)
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  })
}

/**
 * Get table columns from DuckDB
 */
async function getTableColumns(tableName: string): Promise<string[]> {
  const columnsResult = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY ordinal_position`
  )
  return columnsResult.map((c) => c.column_name)
}

/**
 * Extract row data from prefixed result columns
 */
function extractRow(row: Record<string, unknown>, columns: string[], prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  columns.forEach((col) => {
    result[col] = row[`${prefix}${col}`]
  })
  return result
}

/**
 * Find duplicate records using fuzzy matching
 *
 * Uses Jaro-Winkler similarity (native DuckDB function) for better name matching.
 * Phonetic blocking strategies (fingerprint, metaphone, token_phonetic) use
 * JavaScript preprocessing with bulk CSV registration for efficiency.
 *
 * Scales to 2M+ rows with predictable performance.
 */
export async function findDuplicates(
  tableName: string,
  matchColumn: string,
  blockingStrategy: BlockingStrategy,
  _definiteThreshold: number = 85, // Minimum similarity % for "definite" match (used by UI)
  maybeThreshold: number = 60    // Minimum similarity % for "maybe" match
): Promise<MatchPair[]> {
  return withDuckDBLock(async () => {
    const columns = await getTableColumns(tableName)

    // Build select columns for both a and b
    const selectColsA = columns.map((c) => `a."${c}" as "a_${c}"`).join(', ')
    const selectColsB = columns.map((c) => `b."${c}" as "b_${c}"`).join(', ')

    // Convert threshold from percentage to 0-1 scale for Jaro-Winkler
    const jwThreshold = maybeThreshold / 100

    let matchQuery: string
    let phoneticTableName: string | null = null

    try {
      // Check if this is a phonetic blocking strategy requiring JS preprocessing
      if (isPhoneticBlockingStrategy(blockingStrategy)) {
        // Create temp table with phonetic keys
        phoneticTableName = await createPhoneticBlockingTable(tableName, matchColumn, blockingStrategy)

        // Query using phonetic key JOIN and Jaro-Winkler similarity
        matchQuery = `
          WITH base_data AS (
            SELECT ROW_NUMBER() OVER () as row_id, *
            FROM "${tableName}"
            WHERE "${matchColumn}" IS NOT NULL
              AND LENGTH(TRIM(CAST("${matchColumn}" AS VARCHAR))) > 0
          ),
          blocked AS (
            SELECT bd.*, pk.block_key
            FROM base_data bd
            INNER JOIN ${phoneticTableName} pk
              ON CAST(bd."${matchColumn}" AS VARCHAR) = pk.value
          )
          SELECT
            ${selectColsA},
            ${selectColsB},
            jaro_winkler_similarity(
              LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
              LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
            ) as similarity
          FROM blocked a
          JOIN blocked b
            ON a.block_key = b.block_key
            AND a.row_id < b.row_id
          WHERE jaro_winkler_similarity(
              LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
              LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
            ) >= ${jwThreshold}
          ORDER BY similarity DESC
          LIMIT 10000
        `
      } else if (isFastSqlStrategy(blockingStrategy)) {
        // Fast SQL-only strategies (first_letter, first_2_chars, none)
        const blockKeyExpr = getBlockKeyExpr(matchColumn, blockingStrategy)

        matchQuery = `
          WITH blocked AS (
            SELECT
              ROW_NUMBER() OVER () as row_id,
              ${blockKeyExpr} as block_key,
              *
            FROM "${tableName}"
            WHERE "${matchColumn}" IS NOT NULL
              AND LENGTH(COALESCE("${matchColumn}", '')) > 0
          )
          SELECT
            ${selectColsA},
            ${selectColsB},
            jaro_winkler_similarity(
              LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
              LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
            ) as similarity
          FROM blocked a
          JOIN blocked b
            ON a.block_key = b.block_key
            AND a.row_id < b.row_id
          WHERE jaro_winkler_similarity(
              LOWER(COALESCE(CAST(a."${matchColumn}" AS VARCHAR), '')),
              LOWER(COALESCE(CAST(b."${matchColumn}" AS VARCHAR), ''))
            ) >= ${jwThreshold}
          ORDER BY similarity DESC
          LIMIT 10000
        `
      } else {
        // Fallback (shouldn't happen)
        throw new Error(`Unknown blocking strategy: ${blockingStrategy}`)
      }

      const results = await query<Record<string, unknown>>(matchQuery)

      // Convert to MatchPair objects (max 10k from SQL)
      const pairs: MatchPair[] = []

      for (const row of results) {
        const rowA = extractRow(row, columns, 'a_')
        const rowB = extractRow(row, columns, 'b_')
        // Jaro-Winkler returns 0-1, convert to 0-100
        const similarity = Math.round(Number(row.similarity) * 1000) / 10

        // Filter by minimum threshold (double-check)
        if (similarity < maybeThreshold) continue

        const fieldSimilarities = calculateFieldSimilarities(rowA, rowB, columns)

        pairs.push({
          id: generateId(),
          rowA,
          rowB,
          score: Math.round(100 - similarity), // Backwards compat: lower score = better match
          similarity,
          fieldSimilarities,
          status: 'pending',
          keepRow: 'A',
        })
      }

      // Apply stratified sorting: fuzzy matches first
      return stratifiedSort(pairs)
    } finally {
      // Clean up temp table if created
      if (phoneticTableName) {
        try {
          await query(`DROP TABLE IF EXISTS ${phoneticTableName}`)
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  })
}

export async function mergeDuplicates(
  tableName: string,
  pairs: MatchPair[],
  keyColumn: string,
  auditEntryId?: string
): Promise<number> {
  const mergedPairs = pairs.filter((p) => p.status === 'merged')

  if (mergedPairs.length === 0) return 0

  // Capture merge details before deletion (if audit tracking requested)
  if (auditEntryId) {
    await ensureMergeAuditTable()

    // Custom JSON serializer to handle BigInt values from DuckDB
    // CRITICAL: Use String() not Number() to preserve precision for large integers
    const jsonReplacer = (_key: string, value: unknown) => {
      if (typeof value === 'bigint') {
        return String(value)
      }
      return value
    }

    for (let i = 0; i < mergedPairs.length; i++) {
      const pair = mergedPairs[i]
      const keptRow = pair.keepRow === 'A' ? pair.rowA : pair.rowB
      const deletedRow = pair.keepRow === 'A' ? pair.rowB : pair.rowA

      // Escape for SQL - only escape single quotes for SQL insertion
      // Do NOT escape backslashes as this corrupts JSON strings containing escape sequences
      const escapeForSql = (str: string) => str.replace(/'/g, "''")
      const keptRowJson = escapeForSql(JSON.stringify(keptRow, jsonReplacer))
      const deletedRowJson = escapeForSql(JSON.stringify(deletedRow, jsonReplacer))
      const matchColEscaped = escapeForSql(keyColumn)

      try {
        await query(`
          INSERT INTO _merge_audit_details (id, audit_entry_id, pair_index, similarity, match_column, kept_row_data, deleted_row_data, created_at)
          VALUES (
            '${generateId()}',
            '${auditEntryId}',
            ${i},
            ${Math.round(pair.similarity)},
            '${matchColEscaped}',
            '${keptRowJson}',
            '${deletedRowJson}',
            CURRENT_TIMESTAMP
          )
        `)
      } catch (e) {
        console.error('Could not record merge audit detail:', e)
      }
    }
  }

  // For each merged pair, delete the row that should NOT be kept
  // Uses keepRow to determine which row to delete
  let deletedCount = 0

  for (const pair of mergedPairs) {
    // Delete the row that is NOT being kept
    const rowToDelete = pair.keepRow === 'A' ? pair.rowB : pair.rowA
    const keyValue = rowToDelete[keyColumn]
    if (keyValue !== null && keyValue !== undefined) {
      try {
        await query(
          `DELETE FROM "${tableName}" WHERE "${keyColumn}" = '${String(keyValue).replace(/'/g, "''")}'`
        )
        deletedCount++
      } catch (e) {
        console.warn('Could not delete row:', e)
      }
    }
  }

  return deletedCount
}

/**
 * Ensure the merge audit details table exists
 */
async function ensureMergeAuditTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS _merge_audit_details (
      id VARCHAR PRIMARY KEY,
      audit_entry_id VARCHAR NOT NULL,
      pair_index INTEGER NOT NULL,
      similarity INTEGER NOT NULL,
      match_column VARCHAR NOT NULL,
      kept_row_data VARCHAR NOT NULL,
      deleted_row_data VARCHAR NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

/**
 * Get merge audit details for a specific audit entry
 */
export async function getMergeAuditDetails(
  auditEntryId: string
): Promise<{
  id: string
  pairIndex: number
  similarity: number
  matchColumn: string
  keptRowData: Record<string, unknown>
  deletedRowData: Record<string, unknown>
}[]> {
  try {
    // Ensure table exists before querying
    await ensureMergeAuditTable()

    const results = await query<{
      id: string
      pair_index: number
      similarity: number
      match_column: string
      kept_row_data: string
      deleted_row_data: string
    }>(`
      SELECT id, pair_index, similarity, match_column, kept_row_data, deleted_row_data
      FROM _merge_audit_details
      WHERE audit_entry_id = '${auditEntryId.replace(/'/g, "''")}'
      ORDER BY pair_index
    `)

    return results.map((row) => {
      let keptRowData: Record<string, unknown> = {}
      let deletedRowData: Record<string, unknown> = {}

      try {
        keptRowData = JSON.parse(row.kept_row_data)
      } catch (parseError) {
        console.error('Failed to parse kept_row_data:', row.kept_row_data, parseError)
        // Attempt recovery: unescape SQL-doubled single quotes
        try {
          const recovered = row.kept_row_data.replace(/''/g, "'")
          keptRowData = JSON.parse(recovered)
        } catch {
          keptRowData = { _parseError: true, _rawData: row.kept_row_data }
        }
      }

      try {
        deletedRowData = JSON.parse(row.deleted_row_data)
      } catch (parseError) {
        console.error('Failed to parse deleted_row_data:', row.deleted_row_data, parseError)
        // Attempt recovery: unescape SQL-doubled single quotes
        try {
          const recovered = row.deleted_row_data.replace(/''/g, "'")
          deletedRowData = JSON.parse(recovered)
        } catch {
          deletedRowData = { _parseError: true, _rawData: row.deleted_row_data }
        }
      }

      return {
        id: row.id,
        pairIndex: row.pair_index,
        similarity: row.similarity,
        matchColumn: row.match_column,
        keptRowData,
        deletedRowData,
      }
    })
  } catch (e) {
    console.error('Failed to get merge audit details:', e)
    return []
  }
}
