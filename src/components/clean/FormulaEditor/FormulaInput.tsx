/**
 * FormulaInput Component
 *
 * Textarea with syntax highlighting and IDE-like autocomplete.
 * Uses shadcn Command + Popover for suggestions that appear at cursor position.
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import { AtSign, FunctionSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover'
import type { Token, TokenType, FormulaInputProps, AutocompleteSuggestion } from './types'
import { FUNCTION_SPECS, getSupportedFunctions } from '@/lib/formula'

/**
 * Tokenize a formula string for syntax highlighting.
 */
function tokenize(formula: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  const supportedFunctions = getSupportedFunctions()

  while (i < formula.length) {
    const char = formula[i]

    // Whitespace - keep as text
    if (/\s/.test(char)) {
      const start = i
      while (i < formula.length && /\s/.test(formula[i])) i++
      tokens.push({ type: 'text', value: formula.slice(start, i), start, end: i })
      continue
    }

    // Column reference: @name or @[Name With Spaces]
    if (char === '@') {
      const start = i
      i++ // Skip @
      if (i < formula.length && formula[i] === '[') {
        // Bracketed name
        i++ // Skip [
        while (i < formula.length && formula[i] !== ']') i++
        if (i < formula.length) i++ // Skip ]
      } else {
        // Simple name
        while (i < formula.length && /[a-zA-Z0-9_]/.test(formula[i])) i++
      }
      tokens.push({ type: 'column', value: formula.slice(start, i), start, end: i })
      continue
    }

    // String literal: "..."
    if (char === '"') {
      const start = i
      i++ // Skip opening quote
      while (i < formula.length && formula[i] !== '"') i++
      if (i < formula.length) i++ // Skip closing quote
      tokens.push({ type: 'string', value: formula.slice(start, i), start, end: i })
      continue
    }

    // Number literal
    if (/[0-9]/.test(char) || (char === '-' && i + 1 < formula.length && /[0-9]/.test(formula[i + 1]))) {
      const start = i
      if (char === '-') i++
      while (i < formula.length && /[0-9]/.test(formula[i])) i++
      if (i < formula.length && formula[i] === '.') {
        i++
        while (i < formula.length && /[0-9]/.test(formula[i])) i++
      }
      tokens.push({ type: 'number', value: formula.slice(start, i), start, end: i })
      continue
    }

    // Operators and parentheses
    if ('+-*/=<>!&'.includes(char)) {
      const start = i
      // Handle two-character operators
      if (i + 1 < formula.length) {
        const twoChar = formula.slice(i, i + 2)
        if (['<=', '>=', '<>', '!='].includes(twoChar)) {
          i += 2
          tokens.push({ type: 'operator', value: twoChar, start, end: i })
          continue
        }
      }
      i++
      tokens.push({ type: 'operator', value: char, start, end: i })
      continue
    }

    if ('(),'.includes(char)) {
      tokens.push({ type: 'paren', value: char, start: i, end: i + 1 })
      i++
      continue
    }

    // Identifier (function name or boolean)
    if (/[a-zA-Z_]/.test(char)) {
      const start = i
      while (i < formula.length && /[a-zA-Z0-9_]/.test(formula[i])) i++
      const value = formula.slice(start, i)
      const upperValue = value.toUpperCase()

      // Check if it's a boolean
      if (upperValue === 'TRUE' || upperValue === 'FALSE') {
        tokens.push({ type: 'boolean', value, start, end: i })
      }
      // Check if it's a function name
      else if (supportedFunctions.includes(upperValue as typeof supportedFunctions[number])) {
        tokens.push({ type: 'function', value, start, end: i })
      }
      // Otherwise it's just text
      else {
        tokens.push({ type: 'text', value, start, end: i })
      }
      continue
    }

    // Anything else is plain text
    tokens.push({ type: 'text', value: char, start: i, end: i + 1 })
    i++
  }

  return tokens
}

/**
 * Get CSS class for a token type
 */
function getTokenClass(type: TokenType): string {
  switch (type) {
    case 'function':
      return 'text-amber-400 font-medium'
    case 'column':
      // NO padding/margin - must not affect text width or caret will misalign
      return 'text-cyan-400'
    case 'string':
      return 'text-emerald-400'
    case 'number':
      return 'text-purple-400'
    case 'operator':
      return 'text-slate-400'
    case 'boolean':
      return 'text-orange-400 font-medium'
    case 'paren':
      return 'text-slate-500'
    default:
      return ''
  }
}

/**
 * Calculate caret coordinates within a textarea
 */
function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): { top: number; left: number } {
  const { offsetLeft, offsetTop } = textarea
  const div = document.createElement('div')
  const style = getComputedStyle(textarea)

  // Copy textarea styles to mirror div
  const properties = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'lineHeight', 'width'
  ] as const

  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.overflow = 'hidden'

  properties.forEach(prop => {
    div.style[prop] = style[prop]
  })

  div.textContent = textarea.value.substring(0, position)

  const span = document.createElement('span')
  span.textContent = textarea.value.substring(position) || '.'
  div.appendChild(span)

  document.body.appendChild(div)

  const coordinates = {
    top: span.offsetTop + offsetTop - textarea.scrollTop,
    left: span.offsetLeft + offsetLeft - textarea.scrollLeft,
  }

  document.body.removeChild(div)

  return coordinates
}

export function FormulaInput({
  value,
  onChange,
  columns,
  disabled,
  placeholder = 'Enter formula...',
  onCursorChange,
}: FormulaInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  // Autocomplete state
  const [isOpen, setIsOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([])
  const [triggerStart, setTriggerStart] = useState<number | null>(null)
  const [anchorPosition, setAnchorPosition] = useState({ top: 0, left: 0 })
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Refs to avoid stale closures in event handlers
  // Updated synchronously alongside state to ensure keydown handlers see latest values
  const isOpenRef = useRef(false)
  const suggestionsRef = useRef<AutocompleteSuggestion[]>([])
  const selectedIndexRef = useRef(0)
  // Flag to skip trigger check immediately after selection (prevents race condition)
  const justSelectedRef = useRef(false)

  // Wrapper functions that update both state and ref synchronously
  const updateIsOpen = useCallback((open: boolean) => {
    isOpenRef.current = open
    setIsOpen(open)
  }, [])

  const updateSuggestions = useCallback((newSuggestions: AutocompleteSuggestion[]) => {
    suggestionsRef.current = newSuggestions
    setSuggestions(newSuggestions)
    // Reset selection when suggestions change
    selectedIndexRef.current = 0
    setSelectedIndex(0)
  }, [])

  const updateSelectedIndex = useCallback((indexOrUpdater: number | ((prev: number) => number)) => {
    if (typeof indexOrUpdater === 'function') {
      setSelectedIndex(prev => {
        const newIndex = indexOrUpdater(prev)
        selectedIndexRef.current = newIndex
        return newIndex
      })
    } else {
      selectedIndexRef.current = indexOrUpdater
      setSelectedIndex(indexOrUpdater)
    }
  }, [])

  // Tokenize the formula
  const tokens = tokenize(value)

  // Sync scroll between textarea and highlight overlay
  const handleScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  // Check for autocomplete triggers and update suggestions
  const checkForTriggers = useCallback(() => {
    // Skip if we just made a selection (prevents race condition with onChange)
    if (justSelectedRef.current) {
      justSelectedRef.current = false
      return
    }

    if (!textareaRef.current) return

    const cursorPos = textareaRef.current.selectionStart
    onCursorChange?.(cursorPos)

    const textBeforeCursor = value.slice(0, cursorPos)

    // Check for @ trigger (column reference)
    const atMatch = textBeforeCursor.match(/@(\[?[^\]\s,()]*)?$/)
    if (atMatch) {
      const query = atMatch[1]?.replace('[', '') || ''
      const filteredColumns = columns
        .filter(col => col.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8)

      if (filteredColumns.length > 0) {
        const columnSuggestions: AutocompleteSuggestion[] = filteredColumns.map(col => ({
          type: 'column',
          value: col.includes(' ') ? `@[${col}]` : `@${col}`,
          label: col,
        }))

        updateSuggestions(columnSuggestions)
        setTriggerStart(cursorPos - atMatch[0].length)

        // Position anchor at cursor
        const coords = getCaretCoordinates(textareaRef.current, cursorPos)
        setAnchorPosition({ top: coords.top + 20, left: coords.left })
        updateIsOpen(true)
        return
      }
    }

    // Check for function name trigger (letters at start or after operator/paren)
    const funcMatch = textBeforeCursor.match(/(?:^|[\s,+\-*/=<>!&(])([A-Za-z][A-Za-z]*)$/)
    if (funcMatch && funcMatch[1].length >= 2) {
      const query = funcMatch[1].toUpperCase()
      const supportedFunctions = getSupportedFunctions()
      const filteredFunctions = supportedFunctions
        .filter(fn => fn.startsWith(query))
        .slice(0, 8)

      if (filteredFunctions.length > 0) {
        const funcSuggestions: AutocompleteSuggestion[] = filteredFunctions.map(fn => ({
          type: 'function',
          value: fn,
          label: fn,
          description: FUNCTION_SPECS[fn].signature || FUNCTION_SPECS[fn].description,
        }))

        updateSuggestions(funcSuggestions)
        setTriggerStart(cursorPos - funcMatch[1].length)

        // Position anchor at cursor
        const coords = getCaretCoordinates(textareaRef.current, cursorPos)
        setAnchorPosition({ top: coords.top + 20, left: coords.left })
        updateIsOpen(true)
        return
      }
    }

    // Close if no match
    updateIsOpen(false)
  }, [value, columns, onCursorChange, updateSuggestions, updateIsOpen])

  // Handle selection from autocomplete
  const handleSelect = useCallback((suggestion: AutocompleteSuggestion) => {
    if (triggerStart === null || !textareaRef.current) return

    const cursorPos = textareaRef.current.selectionStart
    const before = value.slice(0, triggerStart)
    const after = value.slice(cursorPos)

    let insertValue = suggestion.value
    if (suggestion.type === 'function') {
      insertValue = `${suggestion.value}(`
    }

    const newValue = before + insertValue + after

    // Set flag to prevent checkForTriggers from re-opening dropdown
    justSelectedRef.current = true
    onChange(newValue)

    // Set cursor position after insertion
    const newCursorPos = triggerStart + insertValue.length
    setTimeout(() => {
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
      textareaRef.current?.focus()
    }, 0)

    updateIsOpen(false)
  }, [triggerStart, value, onChange, updateIsOpen])

  // Handle keyboard navigation - uses refs to avoid stale closure issues
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Use refs for latest values to avoid stale closures
    const currentSuggestions = suggestionsRef.current
    const currentIsOpen = isOpenRef.current
    const currentIndex = selectedIndexRef.current

    if (!currentIsOpen || currentSuggestions.length === 0) return

    if (e.key === 'Escape') {
      e.preventDefault()
      updateIsOpen(false)
      return
    }

    // Handle arrow navigation ourselves since textarea has focus, not Command
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      updateSelectedIndex(prev => (prev + 1) % currentSuggestions.length)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      updateSelectedIndex(prev => (prev - 1 + currentSuggestions.length) % currentSuggestions.length)
      return
    }

    // Select the currently highlighted suggestion
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      handleSelect(currentSuggestions[currentIndex])
    }
  }, [handleSelect, updateIsOpen, updateSelectedIndex])


  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        updateIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [updateIsOpen])

  return (
    <div ref={containerRef} className="relative">
      <Popover open={isOpen} onOpenChange={updateIsOpen}>
        {/* Invisible anchor positioned at cursor */}
        <PopoverAnchor asChild>
          <div
            ref={anchorRef}
            className="absolute w-0 h-0 pointer-events-none"
            style={{ top: anchorPosition.top, left: anchorPosition.left }}
          />
        </PopoverAnchor>

        {/* Syntax-highlighted overlay */}
        <pre
          ref={highlightRef}
          className={cn(
            'absolute inset-0 overflow-hidden pointer-events-none',
            'px-3 py-2 text-sm font-mono whitespace-pre-wrap break-words',
            'bg-transparent rounded-md',
            'm-0',
            'border border-transparent'
          )}
          aria-hidden="true"
        >
          {tokens.map((token, i) => (
            <span key={i} className={getTokenClass(token.type)}>
              {token.value}
            </span>
          ))}
          {value === '' && <span className="text-transparent">{placeholder}</span>}
        </pre>

        {/* Actual textarea (transparent text) */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setTimeout(checkForTriggers, 0)
          }}
          onScroll={handleScroll}
          onSelect={checkForTriggers}
          onKeyDown={handleKeyDown}
          onClick={checkForTriggers}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(
            'w-full min-h-[100px] px-3 py-2 text-sm font-mono',
            'bg-slate-900/80 border border-slate-700 rounded-md',
            'resize-y',
            'focus:outline-none focus:ring-2 focus:ring-primary/50',
            'placeholder:text-slate-600',
            'text-transparent caret-slate-300',
            'selection:bg-cyan-500/30',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          style={{ WebkitTextFillColor: 'transparent' }}
        />

        {/* Autocomplete dropdown using shadcn Command */}
        <PopoverContent
          className="w-64 p-0 shadow-lg"
          side="bottom"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Command className="bg-slate-800 border-slate-700" shouldFilter={false}>
            <CommandList>
              <CommandGroup>
                {suggestions.map((suggestion, index) => (
                  <CommandItem
                    key={`${suggestion.type}-${suggestion.value}`}
                    value={suggestion.value}
                    onSelect={() => handleSelect(suggestion)}
                    onMouseEnter={() => updateSelectedIndex(index)}
                    data-selected={index === selectedIndex}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    {suggestion.type === 'column' ? (
                      <AtSign className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    ) : (
                      <FunctionSquare className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className={cn(
                        'font-mono text-sm',
                        suggestion.type === 'column' ? 'text-cyan-300' : 'text-amber-300'
                      )}>
                        {suggestion.label}
                      </div>
                      {suggestion.description && (
                        <div className="text-[10px] text-slate-400 truncate">
                          {suggestion.description}
                        </div>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            {/* Keyboard hints */}
            <div className="px-2 py-1.5 text-[10px] text-slate-500 border-t border-slate-700 flex items-center gap-3">
              <span><kbd className="px-1 py-0.5 bg-slate-700 rounded text-[9px]">↑↓</kbd> navigate</span>
              <span><kbd className="px-1 py-0.5 bg-slate-700 rounded text-[9px]">Enter</kbd> select</span>
              <span><kbd className="px-1 py-0.5 bg-slate-700 rounded text-[9px]">Esc</kbd> close</span>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
