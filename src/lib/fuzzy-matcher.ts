import { query } from '@/lib/duckdb'
import type { MatchPair, BlockingStrategy, FieldSimilarity, FieldSimilarityStatus } from '@/types'
import { generateId } from '@/lib/utils'

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
 * Calculate Levenshtein distance between two strings (JavaScript fallback)
 * Used for field-by-field comparison since DuckDB only provides it in SQL
 */
function levenshteinDistance(a: string, b: string): number {
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()

  if (aLower === bLower) return 0
  if (aLower.length === 0) return bLower.length
  if (bLower.length === 0) return aLower.length

  const matrix: number[][] = []

  for (let i = 0; i <= bLower.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= aLower.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= bLower.length; i++) {
    for (let j = 1; j <= aLower.length; j++) {
      const cost = bLower[i - 1] === aLower[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }

  return matrix[bLower.length][aLower.length]
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

    // Calculate similarity
    let similarity: number
    if (strA === strB) {
      similarity = 100
    } else if (strA === '' || strB === '') {
      similarity = 0
    } else {
      const maxLen = Math.max(strA.length, strB.length)
      const distance = levenshteinDistance(strA, strB)
      similarity = distanceToSimilarity(distance, maxLen)
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
 * Find duplicate records using fuzzy matching
 */
export async function findDuplicates(
  tableName: string,
  matchColumn: string,
  blockingStrategy: BlockingStrategy,
  _definiteThreshold: number = 85, // Minimum similarity % for "definite" match (used by UI)
  maybeThreshold: number = 60    // Minimum similarity % for "maybe" match
): Promise<MatchPair[]> {
  // Get all columns for the table
  const columnsResult = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY ordinal_position`
  )
  const columns = columnsResult.map((c) => c.column_name)

  // For blocking strategies that need JS computation, we fetch data and compute in JS
  if (blockingStrategy === 'double_metaphone' || blockingStrategy === 'ngram') {
    return findDuplicatesWithJSBlocking(
      tableName,
      matchColumn,
      columns,
      blockingStrategy,
      maybeThreshold
    )
  }

  // Build SQL blocking condition for simple strategies
  let blockCondition: string
  switch (blockingStrategy) {
    case 'first_letter':
      blockCondition = `UPPER(SUBSTR(a."${matchColumn}", 1, 1)) = UPPER(SUBSTR(b."${matchColumn}", 1, 1))`
      break
    case 'none':
      blockCondition = `TRUE`
      break
    default:
      blockCondition = `UPPER(SUBSTR(a."${matchColumn}", 1, 1)) = UPPER(SUBSTR(b."${matchColumn}", 1, 1))`
  }

  // Build select columns for both a and b
  const selectColsA = columns.map((c) => `a."${c}" as "a_${c}"`).join(', ')
  const selectColsB = columns.map((c) => `b."${c}" as "b_${c}"`).join(', ')

  // Convert similarity threshold to distance threshold
  // If maybeThreshold = 60%, then for strings of length 10, max distance = 4
  // We'll use a reasonable upper bound for distance filtering
  const maxDistance = 10 // Allow pairs with distance up to 10

  // Run fuzzy matching query with Levenshtein distance
  const matchQuery = `
    WITH numbered AS (
      SELECT ROW_NUMBER() OVER () as row_id, *
      FROM "${tableName}"
    )
    SELECT
      ${selectColsA},
      ${selectColsB},
      levenshtein(LOWER(COALESCE(a."${matchColumn}", '')), LOWER(COALESCE(b."${matchColumn}", ''))) as distance,
      GREATEST(LENGTH(COALESCE(a."${matchColumn}", '')), LENGTH(COALESCE(b."${matchColumn}", ''))) as max_len
    FROM numbered a
    JOIN numbered b ON a.row_id < b.row_id
    WHERE ${blockCondition}
      AND levenshtein(LOWER(COALESCE(a."${matchColumn}", '')), LOWER(COALESCE(b."${matchColumn}", ''))) <= ${maxDistance}
      AND a."${matchColumn}" IS NOT NULL
      AND b."${matchColumn}" IS NOT NULL
    ORDER BY distance ASC
    LIMIT 500
  `

  const results = await query<Record<string, unknown>>(matchQuery)

  const pairs: MatchPair[] = []

  for (const row of results) {
    const rowA: Record<string, unknown> = {}
    const rowB: Record<string, unknown> = {}

    columns.forEach((col) => {
      rowA[col] = row[`a_${col}`]
      rowB[col] = row[`b_${col}`]
    })

    const distance = Number(row.distance)
    const maxLen = Number(row.max_len) || 1
    const similarity = distanceToSimilarity(distance, maxLen)

    // Filter by minimum threshold
    if (similarity < maybeThreshold) continue

    const fieldSimilarities = calculateFieldSimilarities(rowA, rowB, columns)

    pairs.push({
      id: generateId(),
      rowA,
      rowB,
      score: distance, // Keep raw score for backwards compatibility
      similarity,
      fieldSimilarities,
      status: 'pending',
    })
  }

  return pairs
}

/**
 * Find duplicates using JS-based blocking (Double Metaphone or N-Gram)
 */
async function findDuplicatesWithJSBlocking(
  tableName: string,
  matchColumn: string,
  columns: string[],
  blockingStrategy: 'double_metaphone' | 'ngram',
  minSimilarity: number
): Promise<MatchPair[]> {
  // Fetch all rows with their match column values
  const selectCols = columns.map((c) => `"${c}"`).join(', ')
  const dataQuery = `
    SELECT ROW_NUMBER() OVER () as _row_id, ${selectCols}
    FROM "${tableName}"
    WHERE "${matchColumn}" IS NOT NULL
  `
  const rows = await query<Record<string, unknown>>(dataQuery)

  // Group rows by blocking key
  const blocks = new Map<string, number[]>()

  rows.forEach((row, index) => {
    const value = String(row[matchColumn] || '')
    let keys: string[] = []

    if (blockingStrategy === 'double_metaphone') {
      const [primary, secondary] = doubleMetaphone(value)
      keys = [primary, secondary].filter(Boolean)
    } else {
      // N-gram: use first 3 bigrams as keys
      keys = generateBigrams(value).slice(0, 3)
    }

    keys.forEach((key) => {
      if (!blocks.has(key)) {
        blocks.set(key, [])
      }
      blocks.get(key)!.push(index)
    })
  })

  // Find candidate pairs within each block
  const candidatePairs = new Set<string>()

  blocks.forEach((indices) => {
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const minIdx = Math.min(indices[i], indices[j])
        const maxIdx = Math.max(indices[i], indices[j])
        candidatePairs.add(`${minIdx}:${maxIdx}`)
      }
    }
  })

  // Score candidate pairs
  const pairs: MatchPair[] = []

  candidatePairs.forEach((pairKey) => {
    const [idxA, idxB] = pairKey.split(':').map(Number)
    const rowA = rows[idxA]
    const rowB = rows[idxB]

    const valueA = String(rowA[matchColumn] || '')
    const valueB = String(rowB[matchColumn] || '')

    // Calculate similarity
    const maxLen = Math.max(valueA.length, valueB.length)
    const distance = levenshteinDistance(valueA, valueB)
    const similarity = distanceToSimilarity(distance, maxLen)

    if (similarity >= minSimilarity) {
      // Build clean row objects (without _row_id)
      const cleanRowA: Record<string, unknown> = {}
      const cleanRowB: Record<string, unknown> = {}

      columns.forEach((col) => {
        cleanRowA[col] = rowA[col]
        cleanRowB[col] = rowB[col]
      })

      const fieldSimilarities = calculateFieldSimilarities(cleanRowA, cleanRowB, columns)

      pairs.push({
        id: generateId(),
        rowA: cleanRowA,
        rowB: cleanRowB,
        score: distance,
        similarity,
        fieldSimilarities,
        status: 'pending',
      })
    }
  })

  // Sort by similarity descending and limit
  return pairs
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 500)
}

export async function mergeDuplicates(
  tableName: string,
  pairs: MatchPair[],
  keyColumn: string
): Promise<number> {
  const mergedPairs = pairs.filter((p) => p.status === 'merged')

  if (mergedPairs.length === 0) return 0

  // For each merged pair, delete the second row (rowB)
  // This is a simplified merge - in production you might want to merge values
  let deletedCount = 0

  for (const pair of mergedPairs) {
    const keyValueB = pair.rowB[keyColumn]
    if (keyValueB !== null && keyValueB !== undefined) {
      try {
        await query(
          `DELETE FROM "${tableName}" WHERE "${keyColumn}" = '${String(keyValueB).replace(/'/g, "''")}'`
        )
        deletedCount++
      } catch (e) {
        console.warn('Could not delete row:', e)
      }
    }
  }

  return deletedCount
}
