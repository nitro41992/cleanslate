import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

interface Issue {
  file: string
  line: number
  pattern: string
  suggestion: string
}

const issues: Issue[] = []

// Find all test files
const testDir = 'e2e/tests'
const testFiles = readdirSync(testDir)
  .filter(f => f.endsWith('.spec.ts'))
  .map(f => join(testDir, f))

testFiles.forEach(file => {
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n')

  lines.forEach((line, index) => {
    const lineNum = index + 1

    // Pattern 1: picker.apply() without waitForTransformComplete
    if (line.includes('picker.apply()')) {
      const nextFewLines = lines.slice(index, index + 5).join('\n')
      if (!nextFewLines.includes('waitForTransformComplete')) {
        issues.push({
          file,
          line: lineNum,
          pattern: 'picker.apply() without waitForTransformComplete',
          suggestion: 'Add await inspector.waitForTransformComplete(tableId) after picker.apply()'
        })
      }
    }

    // Pattern 2: waitForTimeout (forbidden)
    if (line.includes('waitForTimeout')) {
      issues.push({
        file,
        line: lineNum,
        pattern: 'waitForTimeout() usage ("No Sleep" rule violation)',
        suggestion: 'Replace with semantic wait helper or expect.poll()'
      })
    }

    // Pattern 3: Promise.race for completion
    if (line.includes('Promise.race')) {
      const context = lines.slice(Math.max(0, index - 2), index + 3).join('\n')
      if (context.includes('toBeVisible')) {
        issues.push({
          file,
          line: lineNum,
          pattern: 'Promise.race() for operation completion',
          suggestion: 'Use dedicated wait helper (waitForMergeComplete, waitForCombinerComplete, etc.)'
        })
      }
    }

    // Pattern 4: editCell without waitForGridReady
    if (line.includes('editCell(')) {
      const prevLines = lines.slice(Math.max(0, index - 3), index).join('\n')
      if (!prevLines.includes('waitForGridReady')) {
        issues.push({
          file,
          line: lineNum,
          pattern: 'editCell() without prior waitForGridReady()',
          suggestion: 'Add await inspector.waitForGridReady() before grid interaction'
        })
      }
    }

    // Pattern 5: Cardinality assertion instead of identity
    if (/expect\(.*\.length\)\.toBe\(\d+\)/.test(line) && !line.includes('toBeGreaterThan')) {
      const context = lines.slice(Math.max(0, index - 2), index + 1).join('\n')
      if (context.includes('getTableData') || context.includes('runQuery')) {
        issues.push({
          file,
          line: lineNum,
          pattern: 'Cardinality assertion (length check)',
          suggestion: 'Use identity assertion: expect(rows.map(r => r.id)).toEqual([expected, ids])'
        })
      }
    }
  })
})

// Output results
if (issues.length === 0) {
  console.log('✅ No flaky patterns detected')
  process.exit(0)
}

console.log(`\n⚠️  Found ${issues.length} potential flakiness issues:\n`)

issues.forEach(issue => {
  console.log(`${issue.file}:${issue.line}`)
  console.log(`  Pattern: ${issue.pattern}`)
  console.log(`  Suggestion: ${issue.suggestion}`)
  console.log()
})

// Optional: fail CI if issues found
if (process.env.CI && process.env.STRICT_LINT === 'true') {
  process.exit(1)
}
