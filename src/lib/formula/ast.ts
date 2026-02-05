/**
 * Excel Formula AST Types
 *
 * Abstract Syntax Tree node definitions for parsed Excel-like formulas.
 */

export type ASTNode =
  | BinaryExpression
  | UnaryExpression
  | FunctionCall
  | ColumnRef
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | InExpression

export interface BinaryExpression {
  type: 'BinaryExpression'
  operator: BinaryOperator
  left: ASTNode
  right: ASTNode
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '='
  | '<>'
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '&' // String concatenation

export interface UnaryExpression {
  type: 'UnaryExpression'
  operator: '-' | 'NOT'
  argument: ASTNode
}

export interface FunctionCall {
  type: 'FunctionCall'
  name: FunctionName
  arguments: ASTNode[]
}

/**
 * Supported Excel functions.
 * All function names are normalized to uppercase during parsing.
 */
export type FunctionName =
  // Conditional
  | 'IF'
  | 'IFERROR'
  // String functions
  | 'LEN'
  | 'UPPER'
  | 'LOWER'
  | 'LEFT'
  | 'RIGHT'
  | 'MID'
  | 'TRIM'
  | 'CONCAT'
  | 'SUBSTITUTE'
  | 'PROPER'
  | 'SPLIT'
  | 'LPAD'
  // Numeric functions
  | 'ROUND'
  | 'ABS'
  | 'CEILING'
  | 'FLOOR'
  | 'MOD'
  | 'POWER'
  | 'SQRT'
  // Logical functions
  | 'AND'
  | 'OR'
  | 'NOT'
  // Null handling
  | 'COALESCE'
  | 'ISBLANK'
  // Comparison functions
  | 'CONTAINS'
  | 'ICONTAINS'
  | 'STARTSWITH'
  | 'ENDSWITH'
  | 'LIKE'
  | 'ILIKE'
  | 'REGEX'
  | 'REGEXEXTRACT'
  | 'REGEXREPLACE'
  | 'BETWEEN'
  // Date functions
  | 'YEAR'
  | 'MONTH'
  | 'DAY'
  | 'DATEDIFF'

export interface ColumnRef {
  type: 'ColumnRef'
  columnName: string
}

export interface StringLiteral {
  type: 'StringLiteral'
  value: string
}

export interface NumberLiteral {
  type: 'NumberLiteral'
  value: number
}

export interface BooleanLiteral {
  type: 'BooleanLiteral'
  value: boolean
}

export interface InExpression {
  type: 'InExpression'
  value: ASTNode
  list: ASTNode[]
  negated: boolean // true for NOT IN
}

/**
 * Parse result with either success (AST) or error information.
 */
export interface ParseResult {
  success: boolean
  ast?: ASTNode
  error?: string
  errorPosition?: number
}

/**
 * Validation result for formula transpilation.
 */
export interface ValidationResult {
  isValid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  /** Column names referenced in the formula */
  referencedColumns: string[]
}

export interface ValidationError {
  message: string
  position?: number
}

export interface ValidationWarning {
  message: string
}

/**
 * Transpilation result with SQL expression or error.
 */
export interface TranspileResult {
  success: boolean
  sql?: string
  error?: string
  /** Column names that need to exist in the table */
  referencedColumns: string[]
}
