/**
 * Formula Editor Types
 *
 * Shared type definitions for the Formula Builder UI components.
 */

import type { FunctionName } from '@/lib/formula/ast'

/**
 * Category for organizing functions in the UI
 */
export type FunctionCategory = 'conditional' | 'text' | 'numeric' | 'logical' | 'null'

/**
 * Extended function info for UI display
 */
export interface FunctionInfo {
  name: FunctionName
  signature: string
  description: string
  category: FunctionCategory
  example: string
}

/**
 * Token types for syntax highlighting
 */
export type TokenType =
  | 'function'
  | 'column'
  | 'string'
  | 'number'
  | 'operator'
  | 'boolean'
  | 'paren'
  | 'text'

/**
 * Token with position info for highlighting
 */
export interface Token {
  type: TokenType
  value: string
  start: number
  end: number
}

/**
 * Formula template for quick insertion
 */
export interface FormulaTemplate {
  id: string
  label: string
  description: string
  formula: string
  category: 'conditional' | 'text' | 'math' | 'null'
}

/**
 * Autocomplete suggestion
 */
export interface AutocompleteSuggestion {
  type: 'column' | 'function'
  value: string
  label: string
  description?: string
}

/**
 * Output mode for formula results
 */
export type OutputMode = 'new' | 'replace'

/**
 * Props for the main FormulaEditor component
 */
export interface FormulaEditorProps {
  value: string
  onChange: (value: string) => void
  columns: string[]
  outputMode: OutputMode
  onOutputModeChange: (mode: OutputMode) => void
  outputColumn: string
  onOutputColumnChange: (value: string) => void
  targetColumn: string
  onTargetColumnChange: (value: string) => void
  disabled?: boolean
}

/**
 * Props for FormulaInput component
 */
export interface FormulaInputProps {
  value: string
  onChange: (value: string) => void
  columns: string[]
  disabled?: boolean
  placeholder?: string
  onCursorChange?: (position: number) => void
}

/**
 * Props for Autocomplete component
 */
export interface AutocompleteProps {
  suggestions: AutocompleteSuggestion[]
  isOpen: boolean
  onSelect: (suggestion: AutocompleteSuggestion) => void
  onClose: () => void
  selectedIndex: number
  onSelectedIndexChange: (index: number) => void
  position: { top: number; left: number }
}

/**
 * Props for FunctionBrowser component
 */
export interface FunctionBrowserProps {
  onInsert: (functionName: string) => void
  disabled?: boolean
}

/**
 * Props for TemplateGallery component
 */
export interface TemplateGalleryProps {
  onInsert: (formula: string) => void
  disabled?: boolean
}
