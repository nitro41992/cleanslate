/**
 * Async mutex to serialize DuckDB query execution.
 * Prevents concurrent queries from corrupting internal state.
 *
 * This is necessary because DuckDB-WASM can exhibit race conditions
 * when multiple queries are executed concurrently, leading to errors
 * like `_setThrew is not defined` (MVP bundle) or other corruption.
 */

type QueuedTask<T> = {
  execute: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

class AsyncMutex {
  private queue: QueuedTask<unknown>[] = []
  private isProcessing = false

  async acquire<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        execute: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      try {
        const result = await task.execute()
        task.resolve(result)
      } catch (error) {
        task.reject(error)
      }
    }

    this.isProcessing = false
  }
}

export const duckdbMutex = new AsyncMutex()

/**
 * Execute an operation with the DuckDB mutex lock.
 * Guarantees only one DuckDB query runs at a time.
 */
export async function withMutex<T>(operation: () => Promise<T>): Promise<T> {
  return duckdbMutex.acquire(operation)
}
