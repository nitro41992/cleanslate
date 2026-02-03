/**
 * Recipe Step Builder
 *
 * Allows building recipe steps without executing them on the current table.
 * Users can add transform steps that will be stored in the recipe for later execution.
 */

import { useState, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useRecipeStore } from '@/stores/recipeStore'
import { generateId } from '@/lib/utils'

interface RecipeStepBuilderProps {
  recipeId: string
  tableColumns: string[]
  onStepAdded: () => void
}

/**
 * Transform categories for organization in the builder UI
 */
const TRANSFORM_CATEGORIES = {
  'Text Cleaning': [
    { id: 'trim', label: 'Trim Whitespace', requiresColumn: true },
    { id: 'lowercase', label: 'Lowercase', requiresColumn: true },
    { id: 'uppercase', label: 'Uppercase', requiresColumn: true },
    { id: 'title_case', label: 'Title Case', requiresColumn: true },
    { id: 'sentence_case', label: 'Sentence Case', requiresColumn: true },
    { id: 'collapse_spaces', label: 'Collapse Spaces', requiresColumn: true },
    { id: 'remove_accents', label: 'Remove Accents', requiresColumn: true },
    { id: 'remove_non_printable', label: 'Remove Non-Printable', requiresColumn: true },
  ],
  'Data Quality': [
    { id: 'remove_duplicates', label: 'Remove Duplicates', requiresColumn: true },
    { id: 'fill_down', label: 'Fill Down', requiresColumn: true },
    { id: 'replace_empty', label: 'Replace Empty', requiresColumn: true, params: ['replacement'] },
    { id: 'replace', label: 'Find & Replace', requiresColumn: true, params: ['find', 'replace'] },
  ],
  'Format': [
    { id: 'standardize_date', label: 'Standardize Date', requiresColumn: true, params: ['format'] },
    { id: 'pad_zeros', label: 'Pad Zeros', requiresColumn: true, params: ['length'] },
    { id: 'unformat_currency', label: 'Unformat Currency', requiresColumn: true },
    { id: 'calculate_age', label: 'Calculate Age', requiresColumn: true },
  ],
  'Structure': [
    { id: 'split_column', label: 'Split Column', requiresColumn: true, params: ['delimiter'] },
    { id: 'combine_columns', label: 'Combine Columns', requiresColumn: false, params: ['columns', 'delimiter', 'newColumnName'] },
    { id: 'rename_column', label: 'Rename Column', requiresColumn: true, params: ['newName'] },
  ],
  'Security': [
    { id: 'hash', label: 'Hash (SHA-256)', requiresColumn: true },
    { id: 'mask', label: 'Mask', requiresColumn: true, params: ['maskChar', 'showLast'] },
    { id: 'redact', label: 'Redact', requiresColumn: true },
    { id: 'year_only', label: 'Year Only', requiresColumn: true },
  ],
} as const

type TransformCategory = keyof typeof TRANSFORM_CATEGORIES

interface TransformInfo {
  id: string
  label: string
  requiresColumn: boolean
  params?: string[]
}

/**
 * Generate a human-readable step label
 */
function generateStepLabel(
  transform: string,
  column: string | null,
  params: Record<string, unknown>
): string {
  const transformLabel = Object.values(TRANSFORM_CATEGORIES)
    .flat()
    .find((t) => t.id === transform)?.label || transform

  let label = transformLabel
  if (column) {
    label += ` → ${column}`
  }

  // Add key params to label
  if (params.find) {
    label += ` ("${params.find}" → "${params.replace || ''}")`
  }
  if (params.delimiter) {
    label += ` (by "${params.delimiter}")`
  }
  if (params.length) {
    label += ` (${params.length} digits)`
  }

  return label
}

export function RecipeStepBuilder({
  recipeId,
  tableColumns,
  onStepAdded,
}: RecipeStepBuilderProps) {
  const [category, setCategory] = useState<TransformCategory | null>(null)
  const [transform, setTransform] = useState<TransformInfo | null>(null)
  const [column, setColumn] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, string>>({})

  const addStep = useRecipeStore((s) => s.addStep)

  // Get transforms for selected category
  const availableTransforms = useMemo((): TransformInfo[] => {
    if (!category) return []
    return [...TRANSFORM_CATEGORIES[category]] as TransformInfo[]
  }, [category])

  // Check if form is valid
  const isFormValid = useMemo(() => {
    if (!transform) return false
    if (transform.requiresColumn && !column) return false

    // Check required params
    if (transform.params) {
      for (const param of transform.params) {
        // delimiter is optional for combine_columns
        if (param === 'delimiter' && transform.id === 'combine_columns') continue
        // Some params are required
        if (['find', 'newName', 'newColumnName', 'length'].includes(param)) {
          if (!params[param]) return false
        }
      }
    }

    return true
  }, [transform, column, params])

  // Handle adding step
  const handleAddStep = () => {
    if (!transform) return

    // Build the step
    const stepParams: Record<string, unknown> = {}

    // Add custom params
    if (transform.params) {
      for (const param of transform.params) {
        if (params[param]) {
          // Convert length to number
          if (param === 'length') {
            stepParams[param] = parseInt(params[param], 10)
          } else if (param === 'showLast') {
            stepParams[param] = parseInt(params[param], 10)
          } else if (param === 'columns') {
            // columns is a comma-separated list
            stepParams[param] = params[param].split(',').map((c) => c.trim())
          } else {
            stepParams[param] = params[param]
          }
        }
      }
    }

    // Determine the command type prefix based on transform category
    let typePrefix = 'transform'
    if (['hash', 'mask', 'redact', 'year_only'].includes(transform.id)) {
      typePrefix = 'scrub'
    }

    const step = {
      id: generateId(),
      type: `${typePrefix}:${transform.id}`,
      label: generateStepLabel(transform.id, column, stepParams),
      column: transform.requiresColumn ? (column || undefined) : undefined,
      params: Object.keys(stepParams).length > 0 ? stepParams : undefined,
      enabled: true,
    }

    addStep(recipeId, step)
    onStepAdded()

    // Reset form
    setTransform(null)
    setColumn(null)
    setParams({})
  }

  // Reset transform and column when category changes
  const handleCategoryChange = (value: string) => {
    setCategory(value as TransformCategory)
    setTransform(null)
    setColumn(null)
    setParams({})
  }

  // Reset column and params when transform changes
  const handleTransformChange = (value: string) => {
    const selected = availableTransforms.find((t) => t.id === value) || null
    setTransform(selected)
    setColumn(null)
    setParams({})
  }

  return (
    <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
      <p className="text-xs font-medium text-muted-foreground">ADD STEP</p>

      {/* Category selector */}
      <div className="space-y-1">
        <Label className="text-xs">Category</Label>
        <Select value={category || ''} onValueChange={handleCategoryChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select category..." />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(TRANSFORM_CATEGORIES).map((cat) => (
              <SelectItem key={cat} value={cat}>
                {cat}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Transform selector */}
      {category && (
        <div className="space-y-1">
          <Label className="text-xs">Transform</Label>
          <Select value={transform?.id || ''} onValueChange={handleTransformChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select transform..." />
            </SelectTrigger>
            <SelectContent>
              {availableTransforms.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Column selector */}
      {transform?.requiresColumn && (
        <div className="space-y-1">
          <Label className="text-xs">Column</Label>
          {tableColumns.length > 0 ? (
            <Select value={column || ''} onValueChange={setColumn}>
              <SelectTrigger>
                <SelectValue placeholder="Select column..." />
              </SelectTrigger>
              <SelectContent>
                {tableColumns.map((col) => (
                  <SelectItem key={col} value={col}>
                    {col}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder="Enter column name..."
              value={column || ''}
              onChange={(e) => setColumn(e.target.value)}
            />
          )}
        </div>
      )}

      {/* Dynamic params based on transform */}
      {transform?.params?.map((param) => (
        <div key={param} className="space-y-1">
          <Label className="text-xs capitalize">{param.replace(/([A-Z])/g, ' $1').trim()}</Label>
          {param === 'columns' ? (
            <Input
              placeholder="col1, col2, col3..."
              value={params[param] || ''}
              onChange={(e) => setParams((p) => ({ ...p, [param]: e.target.value }))}
            />
          ) : param === 'length' || param === 'showLast' ? (
            <Input
              type="number"
              placeholder={param === 'length' ? '9' : '4'}
              min={1}
              value={params[param] || ''}
              onChange={(e) => setParams((p) => ({ ...p, [param]: e.target.value }))}
            />
          ) : param === 'format' ? (
            <Select
              value={params[param] || ''}
              onValueChange={(value) => setParams((p) => ({ ...p, [param]: value }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select format..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="YYYY-MM-DD">YYYY-MM-DD (ISO)</SelectItem>
                <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                <SelectItem value="YYYY/MM/DD">YYYY/MM/DD</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={
                param === 'find'
                  ? 'Text to find...'
                  : param === 'replace'
                    ? 'Replace with...'
                    : param === 'delimiter'
                      ? ', (comma)'
                      : param === 'maskChar'
                        ? '*'
                        : param === 'newName' || param === 'newColumnName'
                          ? 'New name...'
                          : param === 'replacement'
                            ? 'Replace empty with...'
                            : `${param}...`
              }
              value={params[param] || ''}
              onChange={(e) => setParams((p) => ({ ...p, [param]: e.target.value }))}
            />
          )}
        </div>
      ))}

      {/* Add button */}
      <Button
        onClick={handleAddStep}
        disabled={!isFormValid}
        size="sm"
        className="w-full"
      >
        <Plus className="w-4 h-4 mr-2" />
        Add Step
      </Button>
    </div>
  )
}
