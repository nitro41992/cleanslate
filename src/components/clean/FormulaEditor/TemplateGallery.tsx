/**
 * TemplateGallery Component
 *
 * Compact quick-start formula templates organized by category.
 * Uses a space-efficient grid layout with hover tooltips for formula preview.
 */

import { useState } from 'react'
import { ChevronDown, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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

// Category styling - compact pill format
const CATEGORY_STYLES: Record<FormulaTemplate['category'], {
  bg: string
  text: string
  border: string
  label: string
}> = {
  conditional: {
    bg: 'bg-blue-500/10 hover:bg-blue-500/20',
    text: 'text-blue-400',
    border: 'border-blue-500/25 hover:border-blue-400/50',
    label: 'Logic'
  },
  text: {
    bg: 'bg-emerald-500/10 hover:bg-emerald-500/20',
    text: 'text-emerald-400',
    border: 'border-emerald-500/25 hover:border-emerald-400/50',
    label: 'Text'
  },
  math: {
    bg: 'bg-purple-500/10 hover:bg-purple-500/20',
    text: 'text-purple-400',
    border: 'border-purple-500/25 hover:border-purple-400/50',
    label: 'Math'
  },
  null: {
    bg: 'bg-amber-500/10 hover:bg-amber-500/20',
    text: 'text-amber-400',
    border: 'border-amber-500/25 hover:border-amber-400/50',
    label: 'Null'
  },
}

// Group templates by category for organized display
const CATEGORY_ORDER: FormulaTemplate['category'][] = ['conditional', 'text', 'math', 'null']

export function TemplateGallery({ onInsert, disabled }: TemplateGalleryProps) {
  const [isOpen, setIsOpen] = useState(false)

  // Group templates
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
          className="w-full justify-between text-slate-400 hover:text-slate-200"
          disabled={disabled}
        >
          <span className="flex items-center gap-2">
            <Lightbulb className="w-4 h-4" />
            Quick Start Templates
          </span>
          <ChevronDown className={cn(
            'w-4 h-4 transition-transform',
            isOpen && 'rotate-180'
          )} />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2">
        <TooltipProvider delayDuration={200}>
          <div className="space-y-2.5 p-2 rounded-lg bg-slate-900/30 border border-slate-700/50">
            {CATEGORY_ORDER.map(category => {
              const templates = templatesByCategory[category]
              const style = CATEGORY_STYLES[category]

              return (
                <div key={category} className="space-y-1.5">
                  {/* Category label */}
                  <div className={cn('text-[10px] font-medium uppercase tracking-wider', style.text)}>
                    {style.label}
                  </div>
                  {/* Template pills */}
                  <div className="flex flex-wrap gap-1.5">
                    {templates.map(template => (
                      <Tooltip key={template.id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'px-2.5 py-1 rounded-md text-xs font-medium border',
                              'transition-all duration-150',
                              'focus:outline-none focus:ring-2 focus:ring-primary/50',
                              style.bg,
                              style.text,
                              style.border,
                              disabled && 'opacity-50 cursor-not-allowed'
                            )}
                            onClick={() => onInsert(template.formula)}
                            disabled={disabled}
                          >
                            {template.label}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-[280px] bg-slate-800 border-slate-700"
                        >
                          <div className="space-y-1">
                            <p className="text-xs text-slate-300">{template.description}</p>
                            <code className="block text-[11px] font-mono text-amber-400 bg-slate-900/50 px-2 py-1 rounded">
                              {template.formula}
                            </code>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </TooltipProvider>
      </CollapsibleContent>
    </Collapsible>
  )
}
