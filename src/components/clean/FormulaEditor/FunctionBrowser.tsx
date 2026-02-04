/**
 * FunctionBrowser Component
 *
 * Collapsible panel showing all available functions organized by category.
 * Click a function to insert it at the cursor position.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, FunctionSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { FUNCTION_SPECS, getSupportedFunctions } from '@/lib/formula'
import type { FunctionCategory } from '@/lib/formula'
import type { FunctionBrowserProps } from './types'

// Category metadata
const CATEGORY_INFO: Record<FunctionCategory, { label: string; color: string }> = {
  conditional: { label: 'Conditional', color: 'text-blue-400' },
  text: { label: 'Text', color: 'text-emerald-400' },
  numeric: { label: 'Numeric', color: 'text-purple-400' },
  logical: { label: 'Logical', color: 'text-orange-400' },
  null: { label: 'Null Handling', color: 'text-cyan-400' },
}

// Order of categories
const CATEGORY_ORDER: FunctionCategory[] = ['conditional', 'text', 'numeric', 'logical', 'null']

export function FunctionBrowser({ onInsert, disabled }: FunctionBrowserProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [expandedCategories, setExpandedCategories] = useState<Set<FunctionCategory>>(
    new Set(['conditional', 'text'])
  )

  const functions = getSupportedFunctions()

  // Group functions by category
  const functionsByCategory = CATEGORY_ORDER.reduce((acc, category) => {
    acc[category] = functions.filter(fn => FUNCTION_SPECS[fn].category === category)
    return acc
  }, {} as Record<FunctionCategory, typeof functions>)

  const toggleCategory = (category: FunctionCategory) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(category)) {
        next.delete(category)
      } else {
        next.add(category)
      }
      return next
    })
  }

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
            <FunctionSquare className="w-4 h-4" />
            Function Reference
          </span>
          <ChevronDown className={cn(
            'w-4 h-4 transition-transform',
            isOpen && 'rotate-180'
          )} />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2">
        <div className="border border-slate-700 rounded-lg bg-slate-900/50 overflow-hidden">
          <ScrollArea className="h-[250px]">
            <div className="p-2 space-y-1">
              {CATEGORY_ORDER.map(category => {
                const categoryFunctions = functionsByCategory[category]
                if (!categoryFunctions || categoryFunctions.length === 0) return null

                const { label, color } = CATEGORY_INFO[category]
                const isExpanded = expandedCategories.has(category)

                return (
                  <div key={category}>
                    {/* Category Header */}
                    <button
                      type="button"
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded',
                        'text-sm font-medium',
                        'hover:bg-slate-800/50 transition-colors',
                        color
                      )}
                      onClick={() => toggleCategory(category)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                      {label}
                      <span className="text-[10px] text-slate-500 ml-auto">
                        {categoryFunctions.length}
                      </span>
                    </button>

                    {/* Category Functions */}
                    {isExpanded && (
                      <div className="ml-5 mt-1 space-y-0.5">
                        {categoryFunctions.map(fn => {
                          const spec = FUNCTION_SPECS[fn]
                          return (
                            <button
                              key={fn}
                              type="button"
                              className={cn(
                                'w-full text-left px-2 py-1.5 rounded',
                                'hover:bg-slate-800 transition-colors',
                                'group'
                              )}
                              onClick={() => onInsert(fn)}
                              disabled={disabled}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-xs text-amber-400 group-hover:text-amber-300">
                                  {fn}
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                                {spec.signature || spec.description}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
