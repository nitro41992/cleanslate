import { Page, expect } from '@playwright/test'

export interface DownloadResult {
  filename: string
  content: string
  rows: string[][]
}

export interface TXTDownloadResult {
  filename: string
  content: string
  lines: string[]
}

/**
 * Click the export button and capture the downloaded CSV
 */
export async function downloadAndVerifyCSV(page: Page): Promise<DownloadResult> {
  // Start waiting for download before clicking
  const downloadPromise = page.waitForEvent('download')

  // Click export button
  await page.getByTestId('export-csv-btn').click()

  // Wait for download
  const download = await downloadPromise

  // Get file content
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []

  if (stream) {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
  }

  const content = Buffer.concat(chunks).toString('utf-8')

  // Parse CSV content
  const lines = content.trim().split('\n')
  const rows = lines.map((line) => parseCSVLine(line))

  return {
    filename: download.suggestedFilename(),
    content,
    rows,
  }
}

/**
 * Parse a single CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }

  result.push(current)
  return result
}

/**
 * Verify the downloaded content matches expected data
 */
export async function verifyDownloadContent(
  downloadResult: DownloadResult,
  expectedRows: string[][],
  options?: { ignoreOrder?: boolean; skipHeader?: boolean }
): Promise<void> {
  const dataRows = options?.skipHeader
    ? downloadResult.rows.slice(1)
    : downloadResult.rows

  if (options?.ignoreOrder) {
    const sortFn = (a: string[], b: string[]) =>
      a.join('|').localeCompare(b.join('|'))
    expect([...dataRows].sort(sortFn)).toEqual([...expectedRows].sort(sortFn))
  } else {
    expect(dataRows).toEqual(expectedRows)
  }
}

/**
 * Click a button and capture the downloaded TXT file
 * @param page - Playwright page
 * @param buttonSelector - Selector for the button that triggers download
 */
export async function downloadAndVerifyTXT(
  page: Page,
  buttonSelector: string
): Promise<TXTDownloadResult> {
  // Start waiting for download before clicking
  const downloadPromise = page.waitForEvent('download')

  // Click export button
  await page.locator(buttonSelector).click()

  // Wait for download
  const download = await downloadPromise

  // Get file content
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []

  if (stream) {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
  }

  const content = Buffer.concat(chunks).toString('utf-8')

  // Parse TXT content
  const lines = content.split('\n')

  return {
    filename: download.suggestedFilename(),
    content,
    lines,
  }
}
