/**
 * FormulaEditor Component
 *
 * A rich formula editor with syntax highlighting, autocomplete, function browser,
 * and template gallery. Designed for Excel power users who want to apply
 * formula-based transformations without writing SQL.
 *
 * Features:
 * - Syntax highlighting (functions, columns, strings, numbers, operators)
 * - Autocomplete for @columns and function names
 * - Collapsible function reference organized by category
 * - Quick-start template gallery
 * - Output mode toggle (new column vs replace existing)
 */

import { useCallback, useMemo } from 'react'
import { FunctionSquare, Plus, RefreshCw } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ColumnCombobox } from '@/components/ui/combobox'
import { cn } from '@/lib/utils'
import { FormulaInput } from './FormulaInput'
import { FunctionBrowser } from './FunctionBrowser'
import { TemplateGallery } from './TemplateGallery'
import type { FormulaEditorProps, ColumnWithType } from './types'

/**
 * Check if columns array contains type info
 */
function hasTypeInfo(columns: string[] | ColumnWithType[]): columns is ColumnWithType[] {
  return columns.length > 0 && typeof columns[0] === 'object'
}

/**
 * Get column names from columns array (handles both formats)
 */
function getColumnNames(columns: string[] | ColumnWithType[]): string[] {
  if (hasTypeInfo(columns)) {
    return columns.map(c => c.name)
  }
  return columns
}

export function FormulaEditor({
  value,
  onChange,
  columns,
  outputMode,
  onOutputModeChange,
  outputColumn,
  onOutputColumnChange,
  targetColumn,
  onTargetColumnChange,
  disabled,
}: FormulaEditorProps) {

  // Get column names array for display
  const columnNames = useMemo(() => getColumnNames(columns), [columns])

  // Insert function at cursor (appends parenthesis)
  const handleFunctionInsert = useCallback((functionName: string) => {
    const insertion = `${functionName}(`
    // If there's existing value, append at the end
    // In a more sophisticated version, we'd insert at cursor position
    if (value) {
      onChange(value + insertion)
    } else {
      onChange(insertion)
    }
  }, [value, onChange])

  // Insert template formula (replaces entire value)
  const handleTemplateInsert = useCallback((formula: string) => {
    onChange(formula)
  }, [onChange])

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Header with inline columns */}
      <div className="bg-muted rounded-lg p-3">
        <div className="flex items-center gap-2">
          <FunctionSquare className="w-5 h-5 text-amber-400" />
          <h3 className="font-medium">Formula Builder</h3>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Create Excel-like formulas to transform your data. Use @column to reference columns.
        </p>
      </div>

      {/* Formula Input */}
      <div className="space-y-2">
        <Label className="flex items-center gap-2">
          Formula
          <span className="text-[10px] text-muted-foreground font-normal">
            (type @ to insert columns)
          </span>
        </Label>
        <FormulaInput
          value={value}
          onChange={onChange}
          columns={columns}
          disabled={disabled}
          placeholder='e.g., IF(@score > 80, "Pass", "Fail")'
        />
      </div>

      {/* Available Columns - RIGHT BELOW FORMULA INPUT */}
      <div className="flex flex-wrap gap-1.5 -mt-1">
        {columnNames.slice(0, 12).map(colName => (
          <button
            key={colName}
            type="button"
            onClick={() => {
              const ref = colName.includes(' ') ? `@[${colName}]` : `@${colName}`
              onChange(value + ref)
            }}
            className={cn(
              'text-[11px] font-mono px-2 py-1 rounded-md',
              'bg-cyan-950/40 text-cyan-400 border border-cyan-500/20',
              'hover:bg-cyan-900/50 hover:border-cyan-400/40 transition-all',
              'shadow-sm shadow-cyan-950/30',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
            disabled={disabled}
          >
            @{colName}
          </button>
        ))}
        {columnNames.length > 12 && (
          <span className="text-[10px] text-muted-foreground self-center px-1">
            +{columnNames.length - 12} more (type @ to see all)
          </span>
        )}
      </div>

      {/* Output Mode Toggle */}
      <div className="space-y-3 pt-3 border-t border-border/30">
        <Label>Output</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={outputMode === 'new' ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'flex-1 gap-2',
              outputMode === 'new' && 'bg-emerald-600 hover:bg-emerald-700'
            )}
            onClick={() => onOutputModeChange('new')}
            disabled={disabled}
          >
            <Plus className="w-3.5 h-3.5" />
            New Column
          </Button>
          <Button
            type="button"
            variant={outputMode === 'replace' ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'flex-1 gap-2',
              outputMode === 'replace' && 'bg-amber-600 hover:bg-amber-700'
            )}
            onClick={() => onOutputModeChange('replace')}
            disabled={disabled}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Replace Column
          </Button>
        </div>
      </div>

      {/* Conditional Output Column Fields */}
      {outputMode === 'new' ? (
        <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
          <Label htmlFor="new-column-name">New Column Name</Label>
          <Input
            id="new-column-name"
            value={outputColumn}
            onChange={(e) => onOutputColumnChange(e.target.value)}
            placeholder="e.g., result, category, score"
            disabled={disabled}
            className="bg-slate-900/50"
          />
        </div>
      ) : (
        <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
          <Label>Column to Replace</Label>
          <ColumnCombobox
            columns={columnNames}
            value={targetColumn}
            onValueChange={onTargetColumnChange}
            placeholder="Select column to replace..."
            disabled={disabled}
          />
        </div>
      )}

      {/* Collapsible Sections - Templates & Functions */}
      <div className="space-y-2 pt-2 border-t border-border/50">
        <TemplateGallery
          onInsert={handleTemplateInsert}
          disabled={disabled}
        />

        <FunctionBrowser
          onInsert={handleFunctionInsert}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

// Re-export types and subcomponents
export type { FormulaEditorProps } from './types'
export type { OutputMode } from './types'
export { FormulaInput } from './FormulaInput'
export { FunctionBrowser } from './FunctionBrowser'
export { TemplateGallery } from './TemplateGallery'
