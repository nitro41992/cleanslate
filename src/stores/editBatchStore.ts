/**
 * Edit Batch Store
 *
 * Accumulates rapid cell edits before committing them as a single batch.
 * This prevents audit log clutter when users make multiple quick edits.
 *
 * Flow:
 * 1. Cell edit → addEdit() → start debounce timer
 * 2. More edits within BATCH_WINDOW → accumulate, reset timer
 * 3. Timer fires → flushBatch() → execute batch command
 */

import { create } from 'zustand'

export interface PendingEdit {
  csId: string
  columnName: string
  previousValue: unknown
  newValue: unknown
  timestamp: number
}

interface EditBatchState {
  // Map of tableId -> pending edits for that table
  pendingEdits: Map<string, PendingEdit[]>
  // Map of tableId -> debounce timeout
  batchTimeouts: Map<string, NodeJS.Timeout>

  // Actions
  addEdit: (tableId: string, edit: PendingEdit) => void
  getPendingEdits: (tableId: string) => PendingEdit[]
  clearBatch: (tableId: string) => void
  hasPendingEdits: (tableId: string) => boolean
  /** Flush all pending edits immediately (for tests or urgent saves) */
  flushAll: () => Promise<void>

  // Internal: set flush callback (called by DataGrid)
  _setFlushCallback: (callback: (tableId: string, edits: PendingEdit[]) => Promise<void>) => void
}

// Batch window in ms - edits within this window are grouped
// Set to 0 to disable batching (immediate execution)
let BATCH_WINDOW = 500

// Store the flush callback externally to avoid serialization issues
let flushCallback: ((tableId: string, edits: PendingEdit[]) => Promise<void>) | null = null

/**
 * Set the batch window for testing purposes.
 * Set to 0 to disable batching (immediate execution).
 */
export function setBatchWindow(ms: number): void {
  BATCH_WINDOW = ms
}

/**
 * Check if batching is currently enabled.
 * Returns true if BATCH_WINDOW > 0.
 */
export function isBatchingEnabled(): boolean {
  return BATCH_WINDOW > 0
}

export const useEditBatchStore = create<EditBatchState>((set, get) => ({
  pendingEdits: new Map(),
  batchTimeouts: new Map(),

  addEdit: (tableId: string, edit: PendingEdit) => {
    const state = get()

    // Get or create pending edits for this table
    const tableEdits = state.pendingEdits.get(tableId) || []

    // Check if we're editing the same cell - update instead of append
    const existingIndex = tableEdits.findIndex(
      (e) => e.csId === edit.csId && e.columnName === edit.columnName
    )

    let updatedEdits: PendingEdit[]
    if (existingIndex >= 0) {
      // Same cell edited again - keep original previousValue, update newValue
      updatedEdits = [...tableEdits]
      updatedEdits[existingIndex] = {
        ...updatedEdits[existingIndex],
        newValue: edit.newValue,
        timestamp: edit.timestamp,
      }
    } else {
      // New cell - append
      updatedEdits = [...tableEdits, edit]
    }

    // Update pending edits
    const newPendingEdits = new Map(state.pendingEdits)
    newPendingEdits.set(tableId, updatedEdits)

    // Clear existing timeout
    const existingTimeout = state.batchTimeouts.get(tableId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    // Set new timeout (or flush immediately if BATCH_WINDOW is 0)
    if (BATCH_WINDOW === 0) {
      // Immediate execution mode (for tests)
      const editsToFlush = [...updatedEdits]
      if (flushCallback) {
        flushCallback(tableId, editsToFlush).then(() => {
          get().clearBatch(tableId)
        })
      }
      return
    }

    const timeout = setTimeout(() => {
      const currentEdits = get().pendingEdits.get(tableId) || []
      if (currentEdits.length > 0 && flushCallback) {
        flushCallback(tableId, currentEdits)
        get().clearBatch(tableId)
      }
    }, BATCH_WINDOW)

    const newTimeouts = new Map(state.batchTimeouts)
    newTimeouts.set(tableId, timeout)

    set({
      pendingEdits: newPendingEdits,
      batchTimeouts: newTimeouts,
    })
  },

  getPendingEdits: (tableId: string) => {
    return get().pendingEdits.get(tableId) || []
  },

  clearBatch: (tableId: string) => {
    const state = get()

    // Clear timeout
    const existingTimeout = state.batchTimeouts.get(tableId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    // Clear edits
    const newPendingEdits = new Map(state.pendingEdits)
    newPendingEdits.delete(tableId)

    const newTimeouts = new Map(state.batchTimeouts)
    newTimeouts.delete(tableId)

    set({
      pendingEdits: newPendingEdits,
      batchTimeouts: newTimeouts,
    })
  },

  hasPendingEdits: (tableId: string) => {
    const edits = get().pendingEdits.get(tableId)
    return edits !== undefined && edits.length > 0
  },

  flushAll: async () => {
    const state = get()
    const promises: Promise<void>[] = []

    for (const [tableId, edits] of state.pendingEdits.entries()) {
      if (edits.length > 0 && flushCallback) {
        promises.push(flushCallback(tableId, edits))
      }
    }

    // Wait for all flushes to complete
    await Promise.all(promises)

    // Clear all batches
    for (const tableId of state.pendingEdits.keys()) {
      get().clearBatch(tableId)
    }
  },

  _setFlushCallback: (callback) => {
    flushCallback = callback
  },
}))
