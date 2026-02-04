/**
 * PrivacySubPanel Component
 *
 * Multi-column privacy configuration panel shown when privacy_batch transform is selected.
 * Allows users to configure multiple columns with different privacy methods and apply them all at once.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Shield,
  Loader2,
  Key,
  Play,
  X,
  Info,
  Lock,
  EyeOff,
  Hash,
  Calendar,
  Shuffle,
  ArrowRight,
  BookOpen,
  Plus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ColumnCombobox } from '@/components/ui/combobox'
import { useTableStore } from '@/stores/tableStore'
import { useRecipeStore } from '@/stores/recipeStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { createCommand } from '@/lib/commands'
import { getTableColumns, query } from '@/lib/duckdb'
import { useExecuteWithConfirmation } from '@/hooks/useExecuteWithConfirmation'
import { ConfirmDiscardDialog } from '@/components/common/ConfirmDiscardDialog'
import { obfuscateValue, OBFUSCATION_METHODS } from '@/lib/obfuscation'
import type { ScrubMethod, RecipeStep } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface PrivacyRule {
  column: string
  method: ScrubMethod
}

interface PrivacySubPanelProps {
  onCancel: () => void
  onApplySuccess: () => void
}

// Method icons for visual clarity
const METHOD_ICONS: Record<ScrubMethod, React.ReactNode> = {
  redact: <EyeOff className="w-4 h-4" />,
  mask: <Shield className="w-4 h-4" />,
  hash: <Hash className="w-4 h-4" />,
  scramble: <Shuffle className="w-4 h-4" />,
  last4: <Lock className="w-4 h-4" />,
  zero: <span className="font-mono text-xs font-bold">0</span>,
  year_only: <Calendar className="w-4 h-4" />,
}

// Method labels
const METHOD_LABELS: Record<ScrubMethod, string> = {
  redact: 'Redact',
  mask: 'Mask',
  hash: 'Hash (MD5)',
  scramble: 'Scramble',
  last4: 'Last 4',
  zero: 'Zero Out',
  year_only: 'Year Only',
}

// Method examples
const METHOD_EXAMPLES: Record<ScrubMethod, { before: string; after: string }> = {
  redact: { before: 'John Smith', after: '[REDACTED]' },
  mask: { before: '555-123-4567', after: '5*****7' },
  hash: { before: 'john@email.com', after: 'a8f5e2b1c9d3...' },
  scramble: { before: '123456789', after: '987654321' },
  last4: { before: '4532-1234-5678-9012', after: '****9012' },
  zero: { before: '$50,000', after: '$00,000' },
  year_only: { before: '1985-03-15', after: '1985-01-01' },
}

// All available methods
const ALL_METHODS: ScrubMethod[] = ['redact', 'mask', 'hash', 'last4', 'zero', 'scramble', 'year_only']

interface PreviewRow {
  original: string | null
  result: string | null
}

export function PrivacySubPanel({ onCancel, onApplySuccess }: PrivacySubPanelProps) {
  const activeTableId = useTableStore((s) => s.activeTableId)
  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)
  const setActiveTable = useTableStore((s) => s.setActiveTable)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const { executeWithConfirmation, confirmDialogProps } = useExecuteWithConfirmation()
  const { getData } = useDuckDB()

  // Recipe store access
  const recipes = useRecipeStore((s) => s.recipes)
  const selectedRecipeId = useRecipeStore((s) => s.selectedRecipeId)
  const addRecipe = useRecipeStore((s) => s.addRecipe)
  const addStep = useRecipeStore((s) => s.addStep)
  const setSelectedRecipe = useRecipeStore((s) => s.setSelectedRecipe)
  const setSecondaryPanel = usePreviewStore((s) => s.setSecondaryPanel)
  const secondaryPanel = usePreviewStore((s) => s.secondaryPanel)

  // Get the selected recipe for button display
  const selectedRecipe = recipes.find((r) => r.id === selectedRecipeId)

  // Local state
  const [rules, setRules] = useState<PrivacyRule[]>([])
  const [secret, setSecret] = useState('')
  const [generateKeyMap, setGenerateKeyMap] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedRule, setSelectedRule] = useState<string | null>(null)
  const [secretInfoOpen, setSecretInfoOpen] = useState(false)
  const [keyMapInfoOpen, setKeyMapInfoOpen] = useState(false)

  // Recipe dialog state
  const [showNewRecipeDialog, setShowNewRecipeDialog] = useState(false)
  const [newRecipeName, setNewRecipeName] = useState('')
  const [pendingStep, setPendingStep] = useState<Omit<RecipeStep, 'id'> | null>(null)

  // Preview state
  const [preview, setPreview] = useState<PreviewRow[]>([])
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  const columns = activeTable?.columns.map((c) => c.name) || []
  const availableColumns = columns.filter((col) => !rules.some((r) => r.column === col))

  // Check if hash method is used
  const hasHashRule = rules.some((r) => r.method === 'hash')
  const MIN_SECRET_LENGTH = 5

  // Add a column with default method
  const handleAddColumn = useCallback((column: string) => {
    if (!column || rules.some((r) => r.column === column)) return
    setRules((prev) => [...prev, { column, method: 'redact' }])
    setSelectedRule(column)
  }, [rules])

  // Remove a column
  const handleRemoveColumn = useCallback((column: string) => {
    setRules((prev) => prev.filter((r) => r.column !== column))
    if (selectedRule === column) {
      setSelectedRule(null)
    }
  }, [selectedRule])

  // Update method for a column
  const handleMethodChange = useCallback((column: string, method: ScrubMethod) => {
    setRules((prev) =>
      prev.map((r) => (r.column === column ? { ...r, method } : r))
    )
  }, [])

  // Generate preview for the selected rule
  useEffect(() => {
    if (!activeTable || !selectedRule) {
      setPreview([])
      return
    }

    const rule = rules.find((r) => r.column === selectedRule)
    if (!rule) {
      setPreview([])
      return
    }

    let cancelled = false
    setIsLoadingPreview(true)

    const generatePreview = async () => {
      try {
        const data = await getData(activeTable.name, 0, 8)
        if (cancelled) return

        const effectiveSecret = rule.method === 'hash' && !secret ? 'preview-secret' : secret

        const rows: PreviewRow[] = await Promise.all(
          data.map(async (row) => {
            const originalValue = row[rule.column]
            const strValue = originalValue === null || originalValue === undefined
              ? null
              : String(originalValue)

            if (strValue === null) {
              return { original: null, result: null }
            }

            const result = await obfuscateValue(strValue, rule.method, effectiveSecret)
            return { original: strValue, result }
          })
        )

        if (!cancelled) {
          setPreview(rows)
        }
      } catch (error) {
        console.error('Preview failed:', error)
        if (!cancelled) {
          setPreview([])
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPreview(false)
        }
      }
    }

    const timer = setTimeout(generatePreview, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeTable, selectedRule, rules, secret, getData])

  // Apply all rules
  const handleApply = async () => {
    if (!activeTable || rules.length === 0) return

    // Validate hash secret
    if (hasHashRule && (!secret || secret.length < MIN_SECRET_LENGTH)) {
      toast.error('Secret Required', {
        description: `Enter a secret (min ${MIN_SECRET_LENGTH} characters) for hash method`,
      })
      return
    }

    setIsProcessing(true)

    try {
      // Create batch command with all rules
      const command = createCommand('scrub:batch', {
        tableId: activeTable.id,
        rules: rules.map((r) => ({
          column: r.column,
          method: r.method,
        })),
        secret: hasHashRule ? secret : undefined,
        generateKeyMap,
      })

      const result = await executeWithConfirmation(command, activeTable.id)

      // User cancelled the confirmation dialog
      if (!result) {
        setIsProcessing(false)
        return
      }

      if (!result.success) {
        throw new Error(result.error || 'Privacy batch operation failed')
      }

      // Register the key map table with tableStore if it was generated
      // Note: addTable() makes the new table active, but we want to stay on the main table
      if (generateKeyMap) {
        const keyMapTableName = `${activeTable.name}_keymap`
        const originalTableId = activeTable.id
        try {
          const columns = await getTableColumns(keyMapTableName)
          const rowCountResult = await query<{ count: number }>(
            `SELECT COUNT(*) as count FROM "${keyMapTableName}"`
          )
          const rowCount = Number(rowCountResult[0]?.count ?? 0)
          addTable(keyMapTableName, columns, rowCount)
          // Restore focus to the original table (don't trigger freeze/thaw)
          setActiveTable(originalTableId)
          console.log(`[PrivacySubPanel] Registered key map table: ${keyMapTableName} with ${rowCount} rows`)
        } catch (error) {
          console.error('[PrivacySubPanel] Failed to register key map table:', error)
          // Don't fail the whole operation - the key map was created in DuckDB
        }
      }

      const affected = result.executionResult?.affected ?? 0
      toast.success('Privacy Transforms Applied', {
        description: `${rules.length} column(s) obfuscated. ${affected} rows affected.${generateKeyMap ? ' Key map table created.' : ''}`,
      })

      onApplySuccess()
    } catch (error) {
      console.error('Privacy batch failed:', error)
      toast.error('Operation Failed', {
        description: error instanceof Error ? error.message : 'An error occurred',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  // Build a recipe step from the current form state
  const buildStepFromCurrentForm = (): Omit<RecipeStep, 'id'> | null => {
    if (rules.length === 0) return null

    return {
      type: 'scrub:batch',
      label: `Privacy Transforms (${rules.length} columns)`,
      params: {
        rules: rules.map((r) => ({
          column: r.column,
          method: r.method,
        })),
        generateKeyMap,
      },
      enabled: true,
    }
  }

  // Check if the current form state is valid for adding to a recipe
  const canAddToRecipe = () => {
    if (rules.length === 0) return false
    // Don't require secret for recipe (will be provided at execution time)
    return true
  }

  // Handle "Add to New Recipe" action
  const handleAddToNewRecipe = () => {
    const step = buildStepFromCurrentForm()
    if (!step) return

    setPendingStep(step)
    setNewRecipeName('')
    setShowNewRecipeDialog(true)
  }

  // Handle creating recipe with the pending step
  const handleCreateRecipeWithStep = () => {
    if (!newRecipeName.trim()) {
      toast.error('Please enter a recipe name')
      return
    }

    if (!pendingStep) return

    // Create the recipe first
    const recipeId = addRecipe({
      name: newRecipeName.trim(),
      description: '',
      version: '1.0',
      requiredColumns: rules.map((r) => r.column),
      steps: [],
    })

    // Add the pending step to it
    addStep(recipeId, pendingStep)

    // Open Recipe panel if not already open
    if (secondaryPanel !== 'recipe') {
      setSecondaryPanel('recipe')
    }
    setSelectedRecipe(recipeId)

    setShowNewRecipeDialog(false)
    setPendingStep(null)
    toast.success('Recipe created', {
      description: `Added Privacy Transforms to "${newRecipeName.trim()}"`,
    })
  }

  // Handle "Add to Existing Recipe" action
  const handleAddToExistingRecipe = (recipeId: string) => {
    const step = buildStepFromCurrentForm()
    if (!step) return

    const recipe = recipes.find((r) => r.id === recipeId)
    const added = addStep(recipeId, step)

    if (!added) {
      toast.info('Step already exists in recipe', {
        description: 'This exact step is already in the recipe',
      })
      return
    }

    // Open Recipe panel if not already open and select the recipe
    if (secondaryPanel !== 'recipe') {
      setSecondaryPanel('recipe')
    }
    setSelectedRecipe(recipeId)

    toast.success('Step added to recipe', {
      description: `Added Privacy Transforms to "${recipe?.name}"`,
    })
  }

  // Handle direct add to selected recipe (when recipe panel is open with a selection)
  const handleAddToSelectedRecipe = () => {
    if (!selectedRecipeId) return
    handleAddToExistingRecipe(selectedRecipeId)
  }

  const currentRule = rules.find((r) => r.column === selectedRule)

  return (
    <>
      {/* Single column layout for right panel positioning */}
      <div className="flex flex-col h-full">
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-teal-400" />
              <h3 className="font-semibold">Privacy Transforms</h3>
            </div>

            {/* Empty State - when no columns added yet */}
            {rules.length === 0 && (
              <>
                <div className="flex flex-col items-center justify-center text-center py-6">
                  <div className="w-12 h-12 rounded-full bg-teal-500/10 flex items-center justify-center mb-4">
                    <Shield className="w-6 h-6 text-teal-400" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Select a column to configure privacy transforms
                  </p>
                </div>
                {/* Add Column - initial state */}
                <div className="space-y-2">
                  <Label>Add Column</Label>
                  <ColumnCombobox
                    columns={availableColumns}
                    value=""
                    onValueChange={handleAddColumn}
                    placeholder="Select column to add..."
                    disabled={isProcessing || availableColumns.length === 0}
                  />
                </div>
              </>
            )}

            {/* Main workflow when columns exist */}
            {rules.length > 0 && (
              <>
                {/* 1. Columns List */}
                <div className="space-y-2">
                  <Label>Columns ({rules.length})</Label>
                  <div className="space-y-2">
                    {rules.map((rule) => {
                      const isSelected = selectedRule === rule.column
                      return (
                        <div
                          key={rule.column}
                          className={cn(
                            'flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors',
                            isSelected
                              ? 'bg-teal-500/10 border border-teal-500/30'
                              : 'bg-muted/50 border border-transparent hover:bg-muted/80'
                          )}
                          onClick={() => setSelectedRule(rule.column)}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="text-sm font-medium truncate">{rule.column}</span>
                            <Badge variant="secondary" className="text-xs shrink-0">
                              {METHOD_LABELS[rule.method]}
                            </Badge>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRemoveColumn(rule.column)
                            }}
                            disabled={isProcessing}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* 2. Method Configuration - when a column is selected */}
                {selectedRule && currentRule && (
                  <div className="space-y-4 pt-2 border-t border-border/50 animate-in fade-in duration-200">
                    {/* Method Selector */}
                    <div className="space-y-2">
                      <Label>Privacy Method</Label>
                      <Select
                        value={currentRule.method}
                        onValueChange={(v) => handleMethodChange(selectedRule, v as ScrubMethod)}
                        disabled={isProcessing}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ALL_METHODS.map((method) => (
                            <SelectItem key={method} value={method}>
                              <div className="flex items-center gap-2">
                                {METHOD_ICONS[method]}
                                <span>{METHOD_LABELS[method]}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {/* Method Description */}
                      <p className="text-xs text-muted-foreground">
                        {OBFUSCATION_METHODS.find((m) => m.id === currentRule.method)?.description}
                      </p>
                    </div>

                    {/* Hash Secret Input - Show inline when current column uses hash */}
                    {currentRule.method === 'hash' && (
                      <Collapsible open={secretInfoOpen} onOpenChange={setSecretInfoOpen}>
                        <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="flex items-center gap-1.5 text-sm font-medium">
                              <Key className="w-3.5 h-3.5" />
                              Hash Secret
                              <span className="text-destructive">*</span>
                            </Label>
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                                <Info className="w-3.5 h-3.5 text-muted-foreground" />
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                          <Input
                            type="password"
                            value={secret}
                            onChange={(e) => setSecret(e.target.value)}
                            placeholder="Min 5 characters"
                            disabled={isProcessing}
                            className={cn((!secret || secret.length < MIN_SECRET_LENGTH) && 'border-amber-500/50')}
                          />
                          {!secret ? (
                            <p className="text-xs text-amber-500">Enter a secret phrase (min 5 chars)</p>
                          ) : secret.length < MIN_SECRET_LENGTH && (
                            <p className="text-xs text-amber-500">
                              {MIN_SECRET_LENGTH - secret.length} more character{MIN_SECRET_LENGTH - secret.length !== 1 ? 's' : ''} needed
                            </p>
                          )}
                        </div>
                        <CollapsibleContent className="mt-2">
                          <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-xs">
                            <p className="font-medium text-foreground">Why is this needed?</p>
                            <p className="text-muted-foreground">
                              The secret ensures <strong>consistent, secure hashing</strong>.
                              Same value + same secret = same hash every time.
                            </p>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    )}

                    {/* Info Card with Example */}
                    <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Example</p>
                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span className="text-red-400/80">{METHOD_EXAMPLES[currentRule.method].before}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-green-400/80">{METHOD_EXAMPLES[currentRule.method].after}</span>
                      </div>
                    </div>

                    {/* Live Preview */}
                    {preview.length > 0 && (
                      <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-xs font-medium text-teal-400">
                            <Shield className="w-3.5 h-3.5" />
                            Live Preview
                            {currentRule.method === 'hash' && !secret && (
                              <span className="text-[10px] text-muted-foreground font-normal">(demo secret)</span>
                            )}
                          </div>
                          {isLoadingPreview && <Loader2 className="w-3 h-3 animate-spin text-teal-400" />}
                        </div>
                        <ScrollArea className="h-[100px]">
                          <div className={cn('space-y-0 pr-3 transition-opacity duration-150', isLoadingPreview && 'opacity-50')}>
                            {/* Header row */}
                            <div className="flex items-center gap-3 text-[10px] font-medium text-muted-foreground pb-1.5 border-b border-border/50 mb-1.5">
                              <span className="min-w-[100px] max-w-[120px]">Original</span>
                              <ArrowRight className="w-3 h-3 shrink-0" />
                              <span className="min-w-[100px] max-w-[120px]">Obfuscated</span>
                            </div>
                            {/* Data rows */}
                            {preview.map((row, i) => (
                              <div
                                key={i}
                                className="flex items-center gap-3 text-xs font-mono py-1 border-b border-border/20 last:border-0"
                              >
                                <span
                                  className="text-muted-foreground/80 min-w-[100px] max-w-[120px] truncate"
                                  title={row.original ?? '(null)'}
                                >
                                  {row.original === null ? '(null)' : row.original === '' ? '(empty)' : row.original}
                                </span>
                                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                                <span
                                  className="text-green-400/90 min-w-[100px] max-w-[120px] truncate"
                                  title={row.result ?? '(null)'}
                                >
                                  {row.result === null ? '(null)' : row.result === '' ? '(empty)' : row.result}
                                </span>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                )}

                {/* 3. Add Column - after configuration */}
                <div className="space-y-2 pt-2 border-t border-border/50">
                  <Label>Add Column</Label>
                  <ColumnCombobox
                    columns={availableColumns}
                    value=""
                    onValueChange={handleAddColumn}
                    placeholder="Add more columns..."
                    disabled={isProcessing || availableColumns.length === 0}
                  />
                </div>

                {/* 4. Global Options - at the bottom */}
                <div className="pt-2 border-t border-border/50">
                  <Collapsible open={keyMapInfoOpen} onOpenChange={setKeyMapInfoOpen}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="keymap"
                          checked={generateKeyMap}
                          onCheckedChange={(checked) => setGenerateKeyMap(checked === true)}
                          disabled={isProcessing}
                        />
                        <Label htmlFor="keymap" className="text-sm cursor-pointer">
                          Generate Key Map Table
                        </Label>
                      </div>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                          <Info className="w-3.5 h-3.5 text-muted-foreground" />
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="mt-2">
                      <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-xs">
                        <p className="font-medium text-foreground">What is a Key Map Table?</p>
                        <p className="text-muted-foreground">
                          Creates a table named <code className="bg-muted px-1 rounded">{activeTable?.name}_keymap</code> that maps
                          original values to obfuscated values.
                        </p>
                        <ul className="text-muted-foreground space-y-1 mt-2">
                          <li className="flex items-start gap-1.5">
                            <span className="text-teal-400">•</span>
                            Enables lookup of original values
                          </li>
                          <li className="flex items-start gap-1.5">
                            <span className="text-teal-400">•</span>
                            Works with recipes (auto-generated on replay)
                          </li>
                          <li className="flex items-start gap-1.5">
                            <span className="text-amber-400">•</span>
                            Contains sensitive data - handle securely
                          </li>
                        </ul>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {/* 5. Action Buttons - equal width */}
        <div className="p-4 border-t border-border/50 space-y-2">
          <div className="flex gap-2">
            <Button
              className="flex-1 bg-teal-600 hover:bg-teal-700 transition-all duration-150"
              onClick={handleApply}
              disabled={
                !activeTable ||
                rules.length === 0 ||
                isProcessing ||
                (hasHashRule && (!secret || secret.length < MIN_SECRET_LENGTH))
              }
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Apply All ({rules.length})
                </>
              )}
            </Button>

            {/* Add to Recipe - always rendered but hidden when recipe panel closed */}
            <div
              className={`transition-all duration-150 overflow-hidden ${
                secondaryPanel === 'recipe'
                  ? 'flex-1 opacity-100'
                  : 'w-0 opacity-0'
              }`}
            >
              {selectedRecipeId && selectedRecipe ? (
                // Direct add to selected recipe
                <Button
                  variant="outline"
                  className="w-full whitespace-nowrap"
                  disabled={!canAddToRecipe() || isProcessing}
                  onClick={handleAddToSelectedRecipe}
                  data-testid="privacy-add-to-recipe-btn"
                >
                  <BookOpen className="w-4 h-4 mr-2" />
                  Add to {selectedRecipe.name}
                </Button>
              ) : (
                // Dropdown when no recipe selected
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full whitespace-nowrap"
                      disabled={!canAddToRecipe() || isProcessing}
                      data-testid="privacy-add-to-recipe-btn"
                    >
                      <BookOpen className="w-4 h-4 mr-2" />
                      Add to Recipe
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onClick={handleAddToNewRecipe}>
                      <Plus className="w-4 h-4 mr-2" />
                      Create New Recipe...
                    </DropdownMenuItem>
                    {recipes.length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Add to Existing</DropdownMenuLabel>
                        {recipes.map((recipe) => (
                          <DropdownMenuItem
                            key={recipe.id}
                            onClick={() => handleAddToExistingRecipe(recipe.id)}
                          >
                            {recipe.name}
                            <span className="ml-auto text-xs text-muted-foreground">
                              {recipe.steps.length} steps
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            className="w-full"
            onClick={onCancel}
            disabled={isProcessing}
          >
            Cancel
          </Button>
        </div>
      </div>

      {/* Confirm Discard Undone Operations Dialog */}
      <ConfirmDiscardDialog {...confirmDialogProps} />

      {/* New Recipe Dialog */}
      <Dialog open={showNewRecipeDialog} onOpenChange={setShowNewRecipeDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create New Recipe</DialogTitle>
            <DialogDescription>
              The privacy transforms will be added as the first step.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="new-recipe-name">Recipe Name</Label>
            <Input
              id="new-recipe-name"
              value={newRecipeName}
              onChange={(e) => setNewRecipeName(e.target.value)}
              placeholder="e.g., PII Scrubbing"
              className="mt-2"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewRecipeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateRecipeWithStep}>
              Create & Add Step
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
