import type { DiffResult } from '@/types'

interface ExportOptions {
  includeUnchanged?: boolean
  columns: string[]
  keyColumns: string[]
  tableAName: string
  tableBName: string
}

interface DiffSummary {
  added: number
  removed: number
  modified: number
  unchanged: number
}

/**
 * Export diff results to CSV format
 */
export function exportDiffToCSV(
  results: DiffResult[],
  options: ExportOptions
): string {
  const { includeUnchanged = false, columns } = options

  const filteredResults = includeUnchanged
    ? results
    : results.filter(r => r.status !== 'unchanged')

  // Build header row: Status, then all columns
  const headers = ['Status', ...columns]
  const csvRows: string[] = [headers.map(escapeCSV).join(',')]

  for (const result of filteredResults) {
    const row: string[] = [result.status.toUpperCase()]

    for (const col of columns) {
      const value = getCellValue(result, col)
      row.push(escapeCSV(value))
    }

    csvRows.push(row.join(','))
  }

  return csvRows.join('\n')
}

/**
 * Export diff results to JSON format
 */
export function exportDiffToJSON(
  results: DiffResult[],
  summary: DiffSummary,
  options: ExportOptions
): string {
  const { includeUnchanged = false, columns, keyColumns, tableAName, tableBName } = options

  const filteredResults = includeUnchanged
    ? results
    : results.filter(r => r.status !== 'unchanged')

  const exportData = {
    meta: {
      exportedAt: new Date().toISOString(),
      tableA: tableAName,
      tableB: tableBName,
      keyColumns,
      columns,
    },
    summary: {
      added: summary.added,
      removed: summary.removed,
      modified: summary.modified,
      unchanged: summary.unchanged,
      total: summary.added + summary.removed + summary.modified + summary.unchanged,
    },
    results: filteredResults.map(r => ({
      status: r.status,
      rowA: r.rowA,
      rowB: r.rowB,
      modifiedColumns: r.modifiedColumns,
    })),
  }

  return JSON.stringify(exportData, null, 2)
}

/**
 * Copy diff results to clipboard as formatted text
 */
export async function copyDiffToClipboard(
  results: DiffResult[],
  summary: DiffSummary,
  options: ExportOptions
): Promise<void> {
  const { tableAName, tableBName } = options
  const filteredResults = results.filter(r => r.status !== 'unchanged').slice(0, 100)

  const lines: string[] = [
    `Diff Results: ${tableAName} vs ${tableBName}`,
    `${'='.repeat(50)}`,
    `Summary: +${summary.added} added, -${summary.removed} removed, ~${summary.modified} modified, =${summary.unchanged} unchanged`,
    '',
    'Results:',
    '',
  ]

  for (const result of filteredResults) {
    const statusIcon = result.status === 'added' ? '+' : result.status === 'removed' ? '-' : '~'
    const keyValues = options.keyColumns.map(k => getCellValue(result, k)).join(', ')
    lines.push(`${statusIcon} [${result.status.toUpperCase()}] ${keyValues}`)

    if (result.status === 'modified' && result.modifiedColumns) {
      for (const col of result.modifiedColumns) {
        const oldVal = result.rowA?.[col] ?? ''
        const newVal = result.rowB?.[col] ?? ''
        lines.push(`    ${col}: "${oldVal}" -> "${newVal}"`)
      }
    }
  }

  if (results.filter(r => r.status !== 'unchanged').length > 100) {
    lines.push('')
    lines.push(`... and ${results.filter(r => r.status !== 'unchanged').length - 100} more`)
  }

  await navigator.clipboard.writeText(lines.join('\n'))
}

/**
 * Trigger download of a file
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Get cell value from diff result
 */
function getCellValue(result: DiffResult, column: string): string {
  if (result.status === 'added') {
    const val = result.rowB?.[column]
    return val === null || val === undefined ? '' : String(val)
  }
  if (result.status === 'removed') {
    const val = result.rowA?.[column]
    return val === null || val === undefined ? '' : String(val)
  }
  // Modified or unchanged - show both if different
  const valA = result.rowA?.[column]
  const valB = result.rowB?.[column]
  const strA = valA === null || valA === undefined ? '' : String(valA)
  const strB = valB === null || valB === undefined ? '' : String(valB)

  if (result.modifiedColumns?.includes(column)) {
    return `${strA} -> ${strB}`
  }
  return strA
}

/**
 * Escape value for CSV
 */
function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
