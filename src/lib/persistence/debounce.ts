/**
 * Debounced save utility for state persistence
 * Delays write operations to reduce file system churn while ensuring data safety
 */
export class DebouncedSave {
  private timeoutId: NodeJS.Timeout | null = null
  private readonly delayMs: number

  constructor(delayMs = 500) {
    this.delayMs = delayMs
  }

  /**
   * Trigger a debounced save operation
   * Each call resets the timer, ensuring writes only happen after idle period
   */
  trigger(fn: () => Promise<void>): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
    }
    this.timeoutId = setTimeout(() => {
      fn().catch((err) => console.error('[Persistence] Save failed:', err))
    }, this.delayMs)
  }

  /**
   * Cancel any pending save operation
   */
  flush(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }
}
