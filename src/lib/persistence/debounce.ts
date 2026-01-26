/**
 * Debounced save utility for state persistence
 * Delays write operations to reduce file system churn while ensuring data safety
 */
export class DebouncedSave {
  private timeoutId: NodeJS.Timeout | null = null
  private pendingFn: (() => Promise<void>) | null = null
  private readonly delayMs: number

  constructor(delayMs = 500) {
    this.delayMs = delayMs
  }

  /**
   * Trigger a debounced save operation
   * Each call resets the timer, ensuring writes only happen after idle period
   */
  trigger(fn: () => Promise<void>): void {
    this.pendingFn = fn
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
    }
    this.timeoutId = setTimeout(() => {
      this.pendingFn?.().catch((err) => console.error('[Persistence] Save failed:', err))
      this.pendingFn = null
      this.timeoutId = null
    }, this.delayMs)
  }

  /**
   * Execute pending save immediately (bypassing debounce)
   * Used before page unload to ensure data isn't lost
   */
  async executeNow(): Promise<void> {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    if (this.pendingFn) {
      const fn = this.pendingFn
      this.pendingFn = null
      await fn()
    }
  }

  /**
   * Cancel any pending save operation
   */
  flush(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    this.pendingFn = null
  }
}
