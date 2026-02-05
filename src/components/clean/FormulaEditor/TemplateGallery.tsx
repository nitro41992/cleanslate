/**
 * TemplateGallery Component
 *
 * Clean list-based formula templates organized by category.
 * Shows all template information inline without heavy nesting.
 */

import { useState } from 'react'
import { ChevronDown, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { FormulaTemplate, TemplateGalleryProps } from './types'

// Pre-defined templates
const TEMPLATES: FormulaTemplate[] = [
  {
    id: 'conditional-simple',
    label: 'IF Condition',
    description: 'Return different values based on a condition',
    formula: 'IF(@column = "value", "Yes", "No")',
    category: 'conditional',
  },
  {
    id: 'conditional-range',
    label: 'Categorize',
    description: 'Group values into categories',
    formula: 'IF(@amount > 1000, "High", IF(@amount > 100, "Medium", "Low"))',
    category: 'conditional',
  },
  {
    id: 'comparison-contains',
    label: 'Contains',
    description: 'Check if column contains text',
    formula: 'IF(CONTAINS(@column, "search"), "Yes", "No")',
    category: 'comparison',
  },
  {
    id: 'comparison-in',
    label: 'In List',
    description: 'Check if value is in a list',
    formula: 'IF(@status IN ("active", "pending"), "Open", "Closed")',
    category: 'comparison',
  },
  {
    id: 'comparison-between',
    label: 'In Range',
    description: 'Check if value is within a range',
    formula: 'IF(BETWEEN(@age, 18, 65), "Working age", "Other")',
    category: 'comparison',
  },
  {
    id: 'comparison-startswith',
    label: 'Starts With',
    description: 'Check if text starts with prefix',
    formula: 'IF(STARTSWITH(@code, "A"), "Type A", "Other")',
    category: 'comparison',
  },
  {
    id: 'text-combine',
    label: 'Combine',
    description: 'Join multiple columns with a separator',
    formula: 'CONCAT(@first, " ", @last)',
    category: 'text',
  },
  {
    id: 'text-extract',
    label: 'Extract',
    description: 'Get first N characters from a column',
    formula: 'LEFT(@column, 5)',
    category: 'text',
  },
  {
    id: 'text-clean',
    label: 'Clean',
    description: 'Trim and convert to uppercase',
    formula: 'UPPER(TRIM(@column))',
    category: 'text',
  },
  {
    id: 'math-calculation',
    label: 'Math',
    description: 'Multiply two columns',
    formula: '@price * @quantity',
    category: 'math',
  },
  {
    id: 'math-percentage',
    label: 'Percentage',
    description: 'Calculate percentage of total',
    formula: 'ROUND(@value / @total * 100, 2)',
    category: 'math',
  },
  {
    id: 'null-handle',
    label: 'Default',
    description: 'Replace null/empty with default',
    formula: 'COALESCE(@column, "N/A")',
    category: 'null',
  },
  {
    id: 'null-check',
    label: 'Is Empty',
    description: 'Return different values for empty cells',
    formula: 'IF(ISBLANK(@column), "Missing", @column)',
    category: 'null',
  },
]

// Category styling
const CATEGORY_STYLES: Record<FormulaTemplate['category'], {
  text: string
  label: string
}> = {
  conditional: { text: 'text-blue-600 dark:text-blue-400', label: 'Logic' },
  comparison: { text: 'text-rose-600 dark:text-rose-400', label: 'Compare' },
  text: { text: 'text-emerald-600 dark:text-emerald-400', label: 'Text' },
  math: { text: 'text-purple-600 dark:text-purple-400', label: 'Math' },
  null: { text: 'text-amber-600 dark:text-amber-400', label: 'Null' },
}

const CATEGORY_ORDER: FormulaTemplate['category'][] = ['conditional', 'comparison', 'text', 'math', 'null']

export function TemplateGallery({ onInsert, disabled }: TemplateGalleryProps) {
  const [isOpen, setIsOpen] = useState(false)

  const templatesByCategory = CATEGORY_ORDER.reduce((acc, cat) => {
    acc[cat] = TEMPLATES.filter(t => t.category === cat)
    return acc
  }, {} as Record<FormulaTemplate['category'], FormulaTemplate[]>)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between text-muted-foreground hover:text-foreground"
          disabled={disabled}
        >
          <span className="flex items-center gap-2">
            <Lightbulb className="w-4 h-4" />
            Quick Start Templates
          </span>
          <ChevronDown className={cn(
            'w-4 h-4 transition-transform duration-200',
            isOpen && 'rotate-180'
          )} />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2">
        <div className="space-y-3">
          {CATEGORY_ORDER.map(category => {
            const templates = templatesByCategory[category]
            const style = CATEGORY_STYLES[category]

            return (
              <div key={category}>
                {/* Category header */}
                <div className={cn(
                  'text-[10px] font-semibold uppercase tracking-wider mb-1.5 px-1',
                  style.text
                )}>
                  {style.label}
                </div>

                {/* Template list */}
                <div className="divide-y divide-border/40">
                  {templates.map(template => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => onInsert(template.formula)}
                      disabled={disabled}
                      className={cn(
                        'w-full text-left px-2.5 py-2.5 transition-colors',
                        'hover:bg-muted/50 focus:outline-none focus:bg-muted/50',
                        disabled && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      {/* Title + Description on same line */}
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-sm font-medium text-foreground">
                          {template.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {template.description}
                        </span>
                      </div>
                      {/* Formula */}
                      <code className="text-[11px] font-mono text-amber-700 dark:text-amber-400/90">
                        {template.formula}
                      </code>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
