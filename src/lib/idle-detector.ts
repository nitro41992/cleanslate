/**
 * Idle Detector
 *
 * Tracks user activity to enable smart memory compaction suggestions.
 * When the user is idle and memory is high, we can suggest (not auto-trigger)
 * a memory compaction operation.
 *
 * Activity events tracked:
 * - mousemove, keydown, scroll, click, touchstart
 *
 * Usage:
 *   idleDetector.start()
 *   idleDetector.registerCallback('memory-check', async () => { ... })
 *   const idleMs = idleDetector.getIdleTimeMs()
 */

type IdleCallback = () => Promise<void>

// Check interval for idle callbacks (30 seconds)
const CHECK_INTERVAL_MS = 30_000

// Minimum idle time before running callbacks (2 minutes)
const MIN_IDLE_TIME_MS = 2 * 60 * 1000

class IdleDetector {
  private lastActivityTime = Date.now()
  private callbacks = new Map<string, IdleCallback>()
  private checkIntervalId: ReturnType<typeof setInterval> | null = null
  private isRunning = false

  /**
   * Start tracking user activity
   */
  start(): void {
    if (this.isRunning) return

    this.isRunning = true
    this.lastActivityTime = Date.now()

    // Track activity events
    const activityHandler = () => {
      this.lastActivityTime = Date.now()
    }

    // Use passive listeners for scroll to avoid jank
    window.addEventListener('mousemove', activityHandler, { passive: true })
    window.addEventListener('keydown', activityHandler, { passive: true })
    window.addEventListener('scroll', activityHandler, { passive: true })
    window.addEventListener('click', activityHandler, { passive: true })
    window.addEventListener('touchstart', activityHandler, { passive: true })

    // Store cleanup function
    this._cleanup = () => {
      window.removeEventListener('mousemove', activityHandler)
      window.removeEventListener('keydown', activityHandler)
      window.removeEventListener('scroll', activityHandler)
      window.removeEventListener('click', activityHandler)
      window.removeEventListener('touchstart', activityHandler)
    }

    // Start periodic check for idle callbacks
    this.checkIntervalId = setInterval(() => {
      this.checkIdleCallbacks()
    }, CHECK_INTERVAL_MS)

    console.log('[IdleDetector] Started tracking user activity')
  }

  private _cleanup: (() => void) | null = null

  /**
   * Stop tracking user activity
   */
  stop(): void {
    if (!this.isRunning) return

    this.isRunning = false

    if (this._cleanup) {
      this._cleanup()
      this._cleanup = null
    }

    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
      this.checkIntervalId = null
    }

    this.callbacks.clear()
    console.log('[IdleDetector] Stopped')
  }

  /**
   * Register a callback to run when user is idle
   *
   * @param id - Unique identifier for this callback (used for deduplication)
   * @param callback - Async function to run when idle
   */
  registerCallback(id: string, callback: IdleCallback): void {
    this.callbacks.set(id, callback)
  }

  /**
   * Unregister a callback
   */
  unregisterCallback(id: string): void {
    this.callbacks.delete(id)
  }

  /**
   * Get the time since last user activity in milliseconds
   */
  getIdleTimeMs(): number {
    return Date.now() - this.lastActivityTime
  }

  /**
   * Check if user has been idle long enough to run callbacks
   */
  isIdle(): boolean {
    return this.getIdleTimeMs() >= MIN_IDLE_TIME_MS
  }

  /**
   * Check and run idle callbacks if user is idle
   */
  private async checkIdleCallbacks(): Promise<void> {
    if (!this.isIdle()) return

    const idleTimeMs = this.getIdleTimeMs()
    console.log(`[IdleDetector] User idle for ${Math.round(idleTimeMs / 1000)}s, checking callbacks...`)

    // Run all registered callbacks
    for (const [id, callback] of this.callbacks.entries()) {
      try {
        await callback()
      } catch (err) {
        console.warn(`[IdleDetector] Callback "${id}" failed:`, err)
      }
    }
  }
}

// Export singleton instance
export const idleDetector = new IdleDetector()
