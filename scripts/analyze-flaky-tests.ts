import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

interface TestResult {
  title: string
  file: string
  status: 'passed' | 'failed' | 'flaky'
  retries: number
  duration: number
}

// Parse Playwright JSON report
const reportPath = 'playwright-report/results.json'

if (!existsSync(reportPath)) {
  console.error(`❌ Report file not found: ${reportPath}`)
  console.error('Run tests with: npx playwright test --reporter=json')
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf-8'))

// Extract flaky tests (passed on retry)
const flakyTests: TestResult[] = []
const failedTests: TestResult[] = []

report.suites.forEach((suite: any) => {
  suite.specs.forEach((spec: any) => {
    const attempts = spec.tests.flatMap((t: any) => t.results)
    const lastResult = attempts[attempts.length - 1]

    if (attempts.length > 1 && lastResult.status === 'passed') {
      // Flaky: failed first, passed on retry
      flakyTests.push({
        title: spec.title,
        file: suite.file,
        status: 'flaky',
        retries: attempts.length - 1,
        duration: lastResult.duration
      })
    } else if (lastResult.status === 'failed') {
      // Failed: all attempts failed
      failedTests.push({
        title: spec.title,
        file: suite.file,
        status: 'failed',
        retries: attempts.length - 1,
        duration: lastResult.duration
      })
    }
  })
})

// Output results
console.log(`\n📊 Test Results Summary`)
console.log(`========================`)
console.log(`Flaky Tests: ${flakyTests.length}`)
console.log(`Failed Tests: ${failedTests.length}`)

if (flakyTests.length > 0) {
  console.log(`\n⚠️  Flaky Tests:`)
  flakyTests.forEach(t => {
    console.log(`  - ${t.file}:${t.title} (${t.retries} retries, ${Math.round(t.duration / 1000)}s)`)
  })
}

if (failedTests.length > 0) {
  console.log(`\n❌ Failed Tests:`)
  failedTests.forEach(t => {
    console.log(`  - ${t.file}:${t.title} (${t.retries} retries, ${Math.round(t.duration / 1000)}s)`)
  })
}

// Ensure test-results directory exists
const resultsDir = 'test-results'
if (!existsSync(resultsDir)) {
  mkdirSync(resultsDir, { recursive: true })
}

// Write to file for tracking over time
const timestamp = new Date().toISOString()
const record = {
  timestamp,
  flakyCount: flakyTests.length,
  failedCount: failedTests.length,
  flakyTests: flakyTests.map(t => ({ file: t.file, title: t.title, retries: t.retries })),
  failedTests: failedTests.map(t => ({ file: t.file, title: t.title }))
}

const reportFile = join(resultsDir, `${timestamp.split('T')[0]}-flaky-report.json`)
writeFileSync(reportFile, JSON.stringify(record, null, 2))
console.log(`\n📝 Report written to: ${reportFile}`)

// Exit with error if flakiness rate too high
const FLAKY_THRESHOLD = 0.05 // 5%
const totalTests = report.suites.reduce((sum: number, suite: any) => sum + suite.specs.length, 0)
const flakinessRate = totalTests > 0 ? flakyTests.length / totalTests : 0

if (flakinessRate > FLAKY_THRESHOLD) {
  console.error(`\n🚨 Flakiness rate (${Math.round(flakinessRate * 100)}%) exceeds threshold (${FLAKY_THRESHOLD * 100}%)`)
  process.exit(1)
}

console.log(`\n✅ Flakiness rate: ${Math.round(flakinessRate * 100)}% (threshold: ${FLAKY_THRESHOLD * 100}%)`)
