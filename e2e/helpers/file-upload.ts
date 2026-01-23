import { Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES_PATH = path.resolve(__dirname, '../fixtures/csv')

export interface CSVUploadOptions {
  headerRow?: number
  encoding?: 'auto' | 'utf-8' | 'iso-8859-1'
  delimiter?: 'auto' | ',' | '\t' | '|' | ';'
}

/**
 * Upload a CSV file from the fixtures folder and configure the ingestion wizard
 */
export async function uploadCSVFile(
  page: Page,
  filename: string,
  options?: CSVUploadOptions
): Promise<void> {
  const filePath = path.join(FIXTURES_PATH, filename)

  // Locate the file input and set files
  const fileInput = page.getByTestId('file-input')
  await fileInput.setInputFiles(filePath)

  // Wait for ingestion wizard to appear
  const wizard = page.getByTestId('ingestion-wizard')
  await wizard.waitFor({ state: 'visible', timeout: 10000 })

  // Configure wizard options if provided
  if (options?.headerRow && options.headerRow !== 1) {
    await page.locator('#header-row').click()
    await page.locator(`[role="option"]`).filter({ hasText: `Row ${options.headerRow}` }).click()
  }

  if (options?.encoding && options.encoding !== 'auto') {
    await page.locator('#encoding').click()
    const encodingLabel = options.encoding === 'utf-8' ? 'UTF-8' : 'Latin-1'
    await page.locator(`[role="option"]`).filter({ hasText: encodingLabel }).click()
  }

  if (options?.delimiter && options.delimiter !== 'auto') {
    await page.locator('#delimiter').click()
    const delimiterLabel = {
      ',': 'Comma',
      '\t': 'Tab',
      '|': 'Pipe',
      ';': 'Semicolon',
    }[options.delimiter]
    await page.locator(`[role="option"]`).filter({ hasText: delimiterLabel }).click()
  }

  // Click Import button
  await page.getByTestId('import-btn').click()

  // Wait for wizard to close
  await wizard.waitFor({ state: 'hidden', timeout: 15000 })
}

/**
 * Wait for file to be loaded and grid to be visible
 */
export async function waitForFileLoaded(page: Page, expectedTableName?: string): Promise<void> {
  // Wait for grid container to be visible
  await page.getByTestId('data-grid').waitFor({ state: 'visible', timeout: 15000 })

  // Optionally wait for specific table name
  if (expectedTableName) {
    await page.locator(`text=${expectedTableName}`).waitFor({ timeout: 10000 })
  }
}

/**
 * Get the path to a fixture file
 */
export function getFixturePath(filename: string): string {
  return path.join(FIXTURES_PATH, filename)
}
