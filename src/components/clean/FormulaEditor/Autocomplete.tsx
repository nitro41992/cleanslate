/**
 * Autocomplete Component
 *
 * Dropdown for column and function suggestions in the formula editor.
 * Supports keyboard navigation and mouse selection.
 */

import { useRef, useEffect } from 'react'
import { AtSign, FunctionSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AutocompleteProps } from './types'

export function Autocomplete({
  suggestions,
  isOpen,
  onSelect,
  onClose: _onClose,
  selectedIndex,
  onSelectedIndexChange,
  position,
}: AutocompleteProps) {
  // Note: _onClose is available for parent components to pass but handled via keyboard in FormulaInput
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return

    const selectedItem = listRef.current.children[selectedIndex] as HTMLElement
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!isOpen || suggestions.length === 0) return null

  return (
    <div
      className={cn(
        'absolute z-50 w-64 max-h-48 overflow-auto',
        'bg-popover border border-border rounded-lg shadow-xl',
        'py-1'
      )}
      style={{ top: position.top, left: position.left }}
    >
      <div ref={listRef}>
        {suggestions.map((suggestion, index) => (
          <button
            key={`${suggestion.type}-${suggestion.value}`}
            type="button"
            className={cn(
              'w-full px-3 py-1.5 text-left flex items-center gap-2',
              'text-sm transition-colors',
              index === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'text-popover-foreground hover:bg-muted/50'
            )}
            onClick={() => onSelect(suggestion)}
            onMouseEnter={() => onSelectedIndexChange(index)}
          >
            {/* Icon */}
            {suggestion.type === 'column' ? (
              <AtSign className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 shrink-0" />
            ) : (
              <FunctionSquare className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 shrink-0" />
            )}

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className={cn(
                'font-mono truncate',
                suggestion.type === 'column' ? 'text-cyan-700 dark:text-cyan-300' : 'text-amber-700 dark:text-amber-300'
              )}>
                {suggestion.label}
              </div>
              {suggestion.description && (
                <div className="text-[10px] text-muted-foreground truncate">
                  {suggestion.description}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Keyboard hint */}
      <div className="px-3 py-1 text-[10px] text-muted-foreground border-t border-border flex items-center justify-between">
        <span>
          <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">Tab</kbd> to select
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">Esc</kbd> to close
        </span>
      </div>
    </div>
  )
}
