/**
 * Dialog shown when importing a file whose derived table name already exists.
 *
 * Offers two paths:
 *  1. Import with a new (editable) name — real-time uniqueness validation
 *  2. Replace the existing table (destructive)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AlertTriangle, Check, Copy, RefreshCw, X } from 'lucide-react'

interface TableConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The derived table name that conflicts */
  tableName: string
  /** Auto-generated unique suggestion (e.g. "table_2") */
  suggestedName: string
  /** All existing table names — used for uniqueness validation */
  existingTableNames: string[]
  /** Called with the chosen custom name */
  onRename: (newName: string) => void
  /** Called to replace (delete existing + import with original name) */
  onReplace: () => void
  onCancel: () => void
}

function validateTableName(
  name: string,
  existingNames: string[]
): { valid: boolean; error?: string } {
  if (!name.trim()) {
    return { valid: false, error: 'Name cannot be empty' }
  }
  if (!/^[a-zA-Z_]/.test(name)) {
    return { valid: false, error: 'Must start with a letter or underscore' }
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return { valid: false, error: 'Only letters, numbers, and underscores allowed' }
  }
  const lower = name.toLowerCase()
  if (existingNames.some((n) => n.toLowerCase() === lower)) {
    return { valid: false, error: 'A table with this name already exists' }
  }
  return { valid: true }
}

export function TableConflictDialog({
  open,
  onOpenChange,
  tableName,
  suggestedName,
  existingTableNames,
  onRename,
  onReplace,
  onCancel,
}: TableConflictDialogProps) {
  const [customName, setCustomName] = useState(suggestedName)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset state when dialog opens with a new suggestion
  useEffect(() => {
    if (open) {
      setCustomName(suggestedName)
      // Auto-focus + select the input after mount
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [open, suggestedName])

  const validation = validateTableName(customName, existingTableNames)

  const handleRename = useCallback(() => {
    if (validation.valid) {
      onRename(customName)
    }
  }, [validation.valid, customName, onRename])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && validation.valid) {
        e.preventDefault()
        handleRename()
      }
    },
    [validation.valid, handleRename]
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel()
        onOpenChange(isOpen)
      }}
    >
      <DialogContent className="sm:max-w-[480px] gap-0 p-0 overflow-hidden">
        {/* ── Header ────────────────────────────────────────── */}
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
              <Copy className="h-4 w-4 text-amber-500" />
            </div>
            Duplicate table name
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] leading-relaxed">
            A table named{' '}
            <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {tableName}
            </span>{' '}
            already exists in your workspace.
          </DialogDescription>
        </DialogHeader>

        {/* ── Option 1: Import with new name ────────────────── */}
        <div className="border-t border-border/50 px-6 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <label
              htmlFor="conflict-table-name"
              className="text-sm font-medium"
            >
              Import as new table
            </label>
            {customName !== suggestedName && (
              <button
                type="button"
                onClick={() => setCustomName(suggestedName)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>

          <div className="relative">
            <Input
              ref={inputRef}
              id="conflict-table-name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoComplete="off"
              className={`font-mono text-sm pr-9 ${
                !validation.valid && customName
                  ? 'border-destructive/60 focus-visible:ring-destructive/30'
                  : validation.valid
                    ? 'border-emerald-500/40 focus-visible:ring-emerald-500/30'
                    : ''
              }`}
            />
            {/* Inline status icon */}
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {validation.valid ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : customName ? (
                <X className="h-4 w-4 text-destructive/70" />
              ) : null}
            </div>
          </div>

          {/* Validation message */}
          {!validation.valid && customName && (
            <p className="text-xs text-destructive/80">{validation.error}</p>
          )}

          <Button
            onClick={handleRename}
            disabled={!validation.valid}
            className="w-full"
          >
            Import as &ldquo;{validation.valid ? customName : '...'}&rdquo;
          </Button>
        </div>

        {/* ── Divider ───────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-6">
          <div className="h-px flex-1 bg-border/50" />
          <span className="text-xs text-muted-foreground/60 uppercase tracking-widest select-none">
            or
          </span>
          <div className="h-px flex-1 bg-border/50" />
        </div>

        {/* ── Option 2: Replace existing ────────────────────── */}
        <div className="px-6 pt-3 pb-6 space-y-2">
          <Button
            variant="outline"
            onClick={onReplace}
            className="w-full group border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40"
          >
            <AlertTriangle className="h-3.5 w-3.5 mr-1.5 opacity-70" />
            Replace existing table
          </Button>
          <p className="text-[11px] text-muted-foreground/70 text-center">
            The current &ldquo;{tableName}&rdquo; table and its history will be permanently deleted.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
