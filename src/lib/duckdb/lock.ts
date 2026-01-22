import { useUIStore } from '@/stores/uiStore'

/**
 * Wraps a DuckDB operation with the busy lock.
 * Uses reference counting to support nested operations safely.
 *
 * This prevents memory polling from running during heavy operations,
 * which can cause race conditions with the shared DuckDB connection.
 *
 * @example
 * ```ts
 * const result = await withDuckDBLock(async () => {
 *   // Your DuckDB operation here
 *   return await runDiff(tableA, tableB, keys)
 * })
 * ```
 */
export async function withDuckDBLock<T>(operation: () => Promise<T>): Promise<T> {
  const { incrementBusy, decrementBusy } = useUIStore.getState()
  try {
    incrementBusy()
    return await operation()
  } finally {
    decrementBusy()
  }
}
