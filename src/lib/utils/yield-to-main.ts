/**
 * Cooperative yield to browser main thread.
 * Uses scheduler.yield() when available (Chrome 115+, Firefox 129+)
 * for priority-aware scheduling, falls back to setTimeout(0) for older browsers.
 *
 * This prevents UI freezing during long-running operations by allowing the browser
 * to handle pending user input (scrolls, clicks) between processing steps.
 *
 * @see https://developer.chrome.com/blog/use-scheduler-yield
 */
export async function yieldToMain(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheduler = (globalThis as any).scheduler
  if (scheduler && typeof scheduler.yield === 'function') {
    await scheduler.yield()
  } else {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
