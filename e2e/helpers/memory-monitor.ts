import { Page } from '@playwright/test'

export async function logMemoryUsage(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => {
    const perf = performance as Performance & {
      memory?: {
        usedJSHeapSize: number
        totalJSHeapSize: number
        jsHeapSizeLimit: number
      }
    }

    if (!perf.memory) return null

    return {
      usedMB: Math.round(perf.memory.usedJSHeapSize / 1024 / 1024),
      totalMB: Math.round(perf.memory.totalJSHeapSize / 1024 / 1024),
      limitMB: Math.round(perf.memory.jsHeapSizeLimit / 1024 / 1024)
    }
  })

  if (metrics) {
    const usagePercent = Math.round((metrics.usedMB / metrics.limitMB) * 100)
    console.log(`[Memory ${label}] ${metrics.usedMB}MB / ${metrics.limitMB}MB (${usagePercent}%)`)

    // Warn if approaching limit
    if (usagePercent > 80) {
      console.warn(`⚠️  High memory usage: ${usagePercent}%`)
    }
  }
}

export async function assertMemoryUnderLimit(
  page: Page,
  maxUsagePercent: number,
  label: string
): Promise<void> {
  const metrics = await page.evaluate(() => {
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
    }
    if (!perf.memory) return null
    return {
      used: perf.memory.usedJSHeapSize,
      limit: perf.memory.jsHeapSizeLimit
    }
  })

  if (metrics) {
    const usagePercent = (metrics.used / metrics.limit) * 100
    if (usagePercent > maxUsagePercent) {
      throw new Error(`Memory usage (${Math.round(usagePercent)}%) exceeds limit (${maxUsagePercent}%) at ${label}`)
    }
  }
}
