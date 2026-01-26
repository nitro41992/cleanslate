/**
 * Hook for executing commands with confirmation when discarding redo states.
 *
 * When the user is in the middle of the undo/redo history (after undoing some actions)
 * and performs a new action, this hook manages the confirmation flow before proceeding.
 * The new action will discard all undone (redo-able) operations.
 *
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   const {
 *     executeWithConfirmation,
 *     confirmDialogProps,
 *   } = useExecuteWithConfirmation()
 *
 *   const handleApply = async () => {
 *     const result = await executeWithConfirmation(command, tableId)
 *     if (result?.success) {
 *       toast.success('Applied!')
 *     }
 *   }
 *
 *   return (
 *     <>
 *       <Button onClick={handleApply}>Apply</Button>
 *       <ConfirmDiscardDialog {...confirmDialogProps} />
 *     </>
 *   )
 * }
 * ```
 */

import { useState, useCallback, useRef } from 'react'
import { getCommandExecutor } from '@/lib/commands'
import type { Command, ExecutorResult, ExecuteOptions } from '@/lib/commands/types'

interface PendingExecution {
  command: Command
  options?: ExecuteOptions
  resolve: (result: ExecutorResult | undefined) => void
}

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  futureStatesCount: number
  onConfirm: () => void
  onCancel: () => void
}

interface UseExecuteWithConfirmationResult {
  /**
   * Execute a command, showing confirmation dialog if there are undone states to discard.
   * Returns the execution result, or undefined if user cancelled.
   *
   * @param command - The command to execute
   * @param tableId - The table ID (used to check for future states)
   * @param options - Optional executor options (e.g., onProgress callback)
   */
  executeWithConfirmation: (
    command: Command,
    tableId: string,
    options?: ExecuteOptions
  ) => Promise<ExecutorResult | undefined>

  /**
   * Check if there are future states that would be discarded.
   */
  getFutureStatesCount: (tableId: string) => number

  /**
   * Props to pass to ConfirmDiscardDialog component.
   */
  confirmDialogProps: ConfirmDialogProps
}

export function useExecuteWithConfirmation(): UseExecuteWithConfirmationResult {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [futureCount, setFutureCount] = useState(0)
  const pendingRef = useRef<PendingExecution | null>(null)
  // Track if we're intentionally closing dialog (vs user pressing Escape)
  const isIntentionalCloseRef = useRef(false)

  const getFutureStatesCount = useCallback((tableId: string): number => {
    const executor = getCommandExecutor()
    return executor.getFutureStatesCount(tableId)
  }, [])

  const executeWithConfirmation = useCallback(
    (command: Command, tableId: string, options?: ExecuteOptions): Promise<ExecutorResult | undefined> => {
      return new Promise((resolve) => {
        const executor = getCommandExecutor()
        const count = executor.getFutureStatesCount(tableId)

        // If no future states, execute immediately
        if (count === 0) {
          executor.execute(command, options).then(resolve)
          return
        }

        // Store pending execution and show dialog
        pendingRef.current = { command, options, resolve }
        setFutureCount(count)
        setDialogOpen(true)
      })
    },
    []
  )

  const handleConfirm = useCallback(() => {
    const pending = pendingRef.current
    if (pending) {
      const executor = getCommandExecutor()
      // Mark as intentional close to prevent handleOpenChange from calling cancel
      isIntentionalCloseRef.current = true
      pendingRef.current = null
      setDialogOpen(false)
      executor
        .execute(pending.command, pending.options)
        .then(pending.resolve)
        .catch((error) => {
          // Resolve with error result instead of rejecting
          pending.resolve({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    } else {
      isIntentionalCloseRef.current = true
      setDialogOpen(false)
    }
  }, [])

  const handleCancel = useCallback(() => {
    const pending = pendingRef.current
    if (pending) {
      pending.resolve(undefined)
      pendingRef.current = null
    }
    isIntentionalCloseRef.current = true
    setDialogOpen(false)
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // Only call cancel if dialog was closed externally (e.g., Escape key)
      // not when we intentionally closed it from handleConfirm or handleCancel
      if (!isIntentionalCloseRef.current) {
        handleCancel()
      }
      // Reset the flag for next time
      isIntentionalCloseRef.current = false
    }
  }, [handleCancel])

  const confirmDialogProps: ConfirmDialogProps = {
    open: dialogOpen,
    onOpenChange: handleOpenChange,
    futureStatesCount: futureCount,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  }

  return {
    executeWithConfirmation,
    getFutureStatesCount,
    confirmDialogProps,
  }
}
