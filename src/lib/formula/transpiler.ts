/**
 * Formula Builder → DuckDB SQL Transpiler
 *
 * Converts parsed AST to DuckDB SQL expressions with:
 * - Type coercion for mixed return types in IF/IFERROR
 * - SQL injection prevention via column quoting
 * - Column existence validation
 */

import type {
  ASTNode,
  BinaryExpression,
  UnaryExpression,
  FunctionCall,
  InExpression,
  TranspileResult,
  ValidationResult,
  ValidationError,
} from './ast'
import { parseFormula, extractColumnRefs } from './parser'
import { FUNCTION_SPECS, getFunctionSpec } from './functions'
import { quoteColumn as quoteColumnSafe, escapeSqlString } from '@/lib/commands/utils/sql'

/**
 * Transpilation context for column validation.
 */
interface TranspileContext {
  /** Available column names in the table */
  availableColumns: string[]
  /** Collected errors during transpilation */
  errors: ValidationError[]
}

/**
 * Infer the return type of an AST node for type coercion.
 */
function inferType(node: ASTNode): 'string' | 'number' | 'boolean' | 'unknown' {
  switch (node.type) {
    case 'StringLiteral':
      return 'string'
    case 'NumberLiteral':
      return 'number'
    case 'BooleanLiteral':
      return 'boolean'
    case 'ColumnRef':
      return 'unknown' // Could be any type
    case 'BinaryExpression':
      // Comparisons return boolean
      if (['=', '<>', '!=', '<', '>', '<=', '>='].includes(node.operator)) {
        return 'boolean'
      }
      // String concat returns string
      if (node.operator === '&') {
        return 'string'
      }
      // Arithmetic returns number
      return 'number'
    case 'UnaryExpression':
      if (node.operator === 'NOT') return 'boolean'
      return 'number' // negation
    case 'FunctionCall': {
      const spec = FUNCTION_SPECS[node.name]
      if (spec?.returnsString) return 'string'
      if (spec?.returnsNumber) return 'number'
      if (spec?.returnsBoolean) return 'boolean'
      return 'unknown'
    }
    case 'InExpression':
      return 'boolean'
    default:
      return 'unknown'
  }
}

/**
 * Wrap an SQL expression with a cast to the target type if needed.
 */
function coerceToType(sql: string, fromType: string, toType: string): string {
  if (fromType === toType || toType === 'unknown') {
    return sql
  }

  switch (toType) {
    case 'string':
      return `CAST(${sql} AS VARCHAR)`
    case 'number':
      return `TRY_CAST(${sql} AS DOUBLE)`
    case 'boolean':
      // Numbers: 0 = false, non-0 = true
      // Strings: empty/null = false, else true
      return `(${sql} IS NOT NULL AND ${sql} != 0 AND ${sql} != '' AND ${sql} != FALSE)`
    default:
      return sql
  }
}

/**
 * Find the common type for IF/IFERROR branches.
 * String wins over number (safer coercion).
 */
function findCommonType(types: ReturnType<typeof inferType>[]): ReturnType<typeof inferType> {
  // If any is string, use string (safest coercion)
  if (types.includes('string')) return 'string'
  // If all are number, use number
  if (types.every((t) => t === 'number')) return 'number'
  // If all are boolean, use boolean
  if (types.every((t) => t === 'boolean')) return 'boolean'
  // Otherwise, use string as fallback (most flexible)
  return 'string'
}

/**
 * Transpile an AST node to DuckDB SQL.
 */
function transpileNode(node: ASTNode, ctx: TranspileContext): string {
  switch (node.type) {
    case 'StringLiteral':
      return `'${escapeSqlString(node.value)}'`

    case 'NumberLiteral':
      return String(node.value)

    case 'BooleanLiteral':
      return node.value ? 'TRUE' : 'FALSE'

    case 'ColumnRef': {
      // Validate column exists
      if (!ctx.availableColumns.includes(node.columnName)) {
        ctx.errors.push({
          message: `Column "${node.columnName}" not found. Available columns: ${ctx.availableColumns.join(', ')}`,
        })
        // Still generate SQL for preview (will fail at runtime)
      }
      // CRITICAL: Use safe quoting to prevent SQL injection
      return quoteColumnSafe(node.columnName)
    }

    case 'BinaryExpression':
      return transpileBinaryExpression(node, ctx)

    case 'UnaryExpression':
      return transpileUnaryExpression(node, ctx)

    case 'FunctionCall':
      return transpileFunctionCall(node, ctx)

    case 'InExpression':
      return transpileInExpression(node, ctx)

    default:
      ctx.errors.push({ message: `Unknown AST node type: ${(node as ASTNode).type}` })
      return 'NULL'
  }
}

/**
 * Transpile binary expressions with operator mapping.
 */
function transpileBinaryExpression(node: BinaryExpression, ctx: TranspileContext): string {
  const left = transpileNode(node.left, ctx)
  const right = transpileNode(node.right, ctx)

  switch (node.operator) {
    // Spreadsheet-style single = for equality
    case '=':
      return `(${left} = ${right})`
    case '<>':
    case '!=':
      return `(${left} != ${right})`
    case '<':
      return `(${left} < ${right})`
    case '>':
      return `(${left} > ${right})`
    case '<=':
      return `(${left} <= ${right})`
    case '>=':
      return `(${left} >= ${right})`
    case '+':
      return `(${left} + ${right})`
    case '-':
      return `(${left} - ${right})`
    case '*':
      return `(${left} * ${right})`
    case '/':
      return `(${left} / ${right})`
    case '&':
      // String concatenation - cast both sides to VARCHAR
      return `CONCAT(CAST(${left} AS VARCHAR), CAST(${right} AS VARCHAR))`
    default:
      ctx.errors.push({ message: `Unknown operator: ${node.operator}` })
      return 'NULL'
  }
}

/**
 * Transpile unary expressions.
 */
function transpileUnaryExpression(node: UnaryExpression, ctx: TranspileContext): string {
  const arg = transpileNode(node.argument, ctx)

  switch (node.operator) {
    case '-':
      return `(-(${arg}))`
    case 'NOT':
      return `(NOT (${arg}))`
    default:
      ctx.errors.push({ message: `Unknown unary operator: ${node.operator}` })
      return 'NULL'
  }
}

/**
 * Transpile IN / NOT IN expressions.
 */
function transpileInExpression(node: InExpression, ctx: TranspileContext): string {
  const value = transpileNode(node.value, ctx)
  const list = node.list.map((item) => transpileNode(item, ctx))
  const op = node.negated ? 'NOT IN' : 'IN'
  return `(${value} ${op} (${list.join(', ')}))`
}

/**
 * Transpile function calls with argument validation and type coercion.
 */
function transpileFunctionCall(node: FunctionCall, ctx: TranspileContext): string {
  const spec = getFunctionSpec(node.name)

  if (!spec) {
    ctx.errors.push({ message: `Unknown function: ${node.name}` })
    return 'NULL'
  }

  // Validate argument count
  if (node.arguments.length < spec.minArgs) {
    ctx.errors.push({
      message: `${spec.description} - requires at least ${spec.minArgs} argument(s), got ${node.arguments.length}`,
    })
    return 'NULL'
  }

  if (spec.maxArgs !== -1 && node.arguments.length > spec.maxArgs) {
    ctx.errors.push({
      message: `${spec.description} - accepts at most ${spec.maxArgs} argument(s), got ${node.arguments.length}`,
    })
    return 'NULL'
  }

  // Special handling for IF to ensure consistent return types
  if (node.name === 'IF' && node.arguments.length === 3) {
    return transpileIfFunction(node, ctx)
  }

  // Special handling for IFERROR
  if (node.name === 'IFERROR' && node.arguments.length === 2) {
    return transpileIferrorFunction(node, ctx)
  }

  // Standard function transpilation
  const args = node.arguments.map((arg) => transpileNode(arg, ctx))
  return spec.toSQL(args)
}

/**
 * Transpile IF function with type coercion for mixed return types.
 *
 * Formulas allow: IF(A > 10, "High", 0) - mixed String/Number
 * DuckDB requires: CASE WHEN ... THEN 'High' ELSE CAST(0 AS VARCHAR) END
 */
function transpileIfFunction(node: FunctionCall, ctx: TranspileContext): string {
  const [condition, trueVal, falseVal] = node.arguments

  // Transpile condition
  const conditionSql = transpileNode(condition, ctx)

  // Infer types of true/false branches
  const trueType = inferType(trueVal)
  const falseType = inferType(falseVal)

  // Find common type
  const commonType = findCommonType([trueType, falseType])

  // Transpile branches with coercion if needed
  let trueSql = transpileNode(trueVal, ctx)
  let falseSql = transpileNode(falseVal, ctx)

  if (trueType !== commonType && trueType !== 'unknown') {
    trueSql = coerceToType(trueSql, trueType, commonType)
  }

  if (falseType !== commonType && falseType !== 'unknown') {
    falseSql = coerceToType(falseSql, falseType, commonType)
  }

  return `CASE WHEN ${conditionSql} THEN ${trueSql} ELSE ${falseSql} END`
}

/**
 * Transpile IFERROR function.
 *
 * IFERROR(expr, fallback) - returns fallback if expr evaluates to error/NULL
 */
function transpileIferrorFunction(node: FunctionCall, ctx: TranspileContext): string {
  const [expr, fallback] = node.arguments

  const exprSql = transpileNode(expr, ctx)
  const fallbackSql = transpileNode(fallback, ctx)

  // Infer types for coercion
  const exprType = inferType(expr)
  const fallbackType = inferType(fallback)
  const commonType = findCommonType([exprType, fallbackType])

  let coercedExpr = exprSql
  let coercedFallback = fallbackSql

  if (exprType !== commonType && exprType !== 'unknown') {
    coercedExpr = coerceToType(exprSql, exprType, commonType)
  }

  if (fallbackType !== commonType && fallbackType !== 'unknown') {
    coercedFallback = coerceToType(fallbackSql, fallbackType, commonType)
  }

  // Use TRY to catch errors, COALESCE for NULL handling
  return `COALESCE(TRY(${coercedExpr}), ${coercedFallback})`
}

/**
 * Transpile a formula string to DuckDB SQL expression.
 *
 * @param formula - Spreadsheet-style formula (e.g., "IF(@State = \"NY\", \"East\", \"West\")")
 * @param availableColumns - Column names in the target table
 * @returns TranspileResult with SQL on success or error details on failure
 *
 * @example
 * ```typescript
 * const result = transpileFormula('UPPER(@name)', ['name', 'email'])
 * if (result.success) {
 *   console.log(result.sql) // 'UPPER(CAST("name" AS VARCHAR))'
 * }
 * ```
 */
export function transpileFormula(
  formula: string,
  availableColumns: string[]
): TranspileResult {
  // Parse the formula
  const parseResult = parseFormula(formula)

  if (!parseResult.success || !parseResult.ast) {
    return {
      success: false,
      error: parseResult.error || 'Failed to parse formula',
      referencedColumns: [],
    }
  }

  // Create transpilation context
  const ctx: TranspileContext = {
    availableColumns,
    errors: [],
  }

  // Transpile AST to SQL
  const sql = transpileNode(parseResult.ast, ctx)

  // Extract referenced columns for validation info
  const referencedColumns = extractColumnRefs(formula)

  if (ctx.errors.length > 0) {
    return {
      success: false,
      error: ctx.errors.map((e) => e.message).join('; '),
      referencedColumns,
    }
  }

  return {
    success: true,
    sql,
    referencedColumns,
  }
}

/**
 * Validate a formula against a table schema without transpiling.
 *
 * @param formula - Spreadsheet-style formula
 * @param availableColumns - Column names in the target table
 * @returns ValidationResult with errors and warnings
 */
export function validateFormula(
  formula: string,
  availableColumns: string[]
): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: { message: string }[] = []

  // Parse the formula
  const parseResult = parseFormula(formula)

  if (!parseResult.success) {
    errors.push({ message: parseResult.error || 'Parse error', position: parseResult.errorPosition })
    return { isValid: false, errors, warnings, referencedColumns: [] }
  }

  // Extract and validate column references
  const referencedColumns = extractColumnRefs(formula)
  const missingColumns = referencedColumns.filter((col) => !availableColumns.includes(col))

  if (missingColumns.length > 0) {
    errors.push({
      message: `Column(s) not found: ${missingColumns.join(', ')}. Available: ${availableColumns.join(', ')}`,
    })
  }

  // Try transpiling to catch function/argument errors
  const transpileResult = transpileFormula(formula, availableColumns)

  if (!transpileResult.success && transpileResult.error) {
    // Don't duplicate column errors
    if (!transpileResult.error.includes('not found')) {
      errors.push({ message: transpileResult.error })
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    referencedColumns,
  }
}
