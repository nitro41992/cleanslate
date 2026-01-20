/**
 * File analysis utilities for CSV ingestion wizard
 */

const DELIMITERS = [',', '\t', '|', ';'] as const
export type Delimiter = (typeof DELIMITERS)[number]

export interface FilePreviewResult {
  lines: string[]
  encoding: 'utf-8' | 'latin-1'
  detectedDelimiter: Delimiter
}

/**
 * Read the first N lines of a file as raw text
 */
export async function readFilePreview(
  file: File,
  maxLines: number = 50
): Promise<FilePreviewResult> {
  const buffer = await file.slice(0, 1024 * 100).arrayBuffer() // Read first 100KB
  const uint8Array = new Uint8Array(buffer)

  // Detect encoding
  const encoding = detectEncoding(uint8Array)

  // Decode the content
  const decoder = new TextDecoder(encoding)
  const text = decoder.decode(uint8Array)

  // Split into lines and limit
  const allLines = text.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)

  // Detect delimiter
  const detectedDelimiter = detectDelimiter(lines)

  return {
    lines,
    encoding,
    detectedDelimiter,
  }
}

/**
 * Detect text encoding by checking for UTF-8 validity
 * Falls back to Latin-1 if UTF-8 decode fails
 */
export function detectEncoding(buffer: Uint8Array): 'utf-8' | 'latin-1' {
  // Try to decode as UTF-8 and check for replacement characters
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8Text = utf8Decoder.decode(buffer)

  // Check for common UTF-8 decoding issues
  // If we see the replacement character (U+FFFD), it's likely not valid UTF-8
  if (utf8Text.includes('\uFFFD')) {
    return 'latin-1'
  }

  // Check for common Latin-1 specific byte sequences that would be invalid UTF-8
  // Bytes 0x80-0xFF as standalone bytes indicate Latin-1
  let hasInvalidUtf8Sequence = false
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]
    if (byte >= 0x80 && byte <= 0xbf) {
      // Check if this is a continuation byte without a proper start byte
      if (i === 0 || buffer[i - 1] < 0xc0) {
        hasInvalidUtf8Sequence = true
        break
      }
    }
  }

  if (hasInvalidUtf8Sequence) {
    return 'latin-1'
  }

  return 'utf-8'
}

/**
 * Detect the most likely delimiter by counting occurrences
 * Picks the delimiter with the most consistent count across lines
 */
export function detectDelimiter(lines: string[]): Delimiter {
  if (lines.length === 0) return ','

  // Filter out empty lines for analysis
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
  if (nonEmptyLines.length === 0) return ','

  // Count delimiter occurrences per line
  const delimiterScores: Record<Delimiter, number> = {
    ',': 0,
    '\t': 0,
    '|': 0,
    ';': 0,
  }

  for (const delimiter of DELIMITERS) {
    const counts = nonEmptyLines.map((line) => countDelimiter(line, delimiter))

    // Calculate consistency score
    // Higher score = more consistent and more occurrences
    const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length
    const variance = counts.reduce((sum, c) => sum + Math.pow(c - avgCount, 2), 0) / counts.length
    const stdDev = Math.sqrt(variance)

    // Score = average count / (1 + standard deviation)
    // This favors delimiters with high counts and low variance
    if (avgCount > 0) {
      delimiterScores[delimiter] = avgCount / (1 + stdDev)
    }
  }

  // Find the delimiter with the highest score
  let bestDelimiter: Delimiter = ','
  let bestScore = 0

  for (const delimiter of DELIMITERS) {
    if (delimiterScores[delimiter] > bestScore) {
      bestScore = delimiterScores[delimiter]
      bestDelimiter = delimiter
    }
  }

  return bestDelimiter
}

/**
 * Count occurrences of a delimiter in a line
 * Handles quoted fields properly
 */
function countDelimiter(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      // Check for escaped quote
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        i++ // Skip next quote
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      count++
    }
  }

  return count
}

/**
 * Parse a single line using the given delimiter
 */
export function parseLine(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }

  fields.push(current)
  return fields
}

/**
 * Get delimiter display name
 */
export function getDelimiterLabel(delimiter: Delimiter): string {
  switch (delimiter) {
    case ',':
      return 'Comma'
    case '\t':
      return 'Tab'
    case '|':
      return 'Pipe'
    case ';':
      return 'Semicolon'
  }
}
