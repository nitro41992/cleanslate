/**
 * Formula Builder Parser & Transpiler
 *
 * Parses spreadsheet-style formulas and transpiles them to DuckDB SQL.
 * Target users: Spreadsheet power users who know formulas but avoid SQL.
 *
 * @example
 * ```typescript
 * import { transpileFormula, validateFormula, extractColumnRefs } from '@/lib/formula'
 *
 * // Validate before applying
 * const validation = validateFormula('IF(@State = "NY", "East", "West")', ['State', 'City'])
 * if (!validation.isValid) {
 *   console.error(validation.errors)
 * }
 *
 * // Transpile to SQL
 * const result = transpileFormula('UPPER(@name)', ['name', 'email'])
 * if (result.success) {
 *   console.log(result.sql) // UPPER(CAST("name" AS VARCHAR))
 * }
 *
 * // Extract column references for dependency tracking
 * const columns = extractColumnRefs('@price * @quantity')
 * // ['price', 'quantity']
 * ```
 *
 * ## Supported Syntax
 *
 * **Column References:**
 * - `@name` - Simple column name
 * - `@[Column Name]` - Column name with spaces
 *
 * **Operators:**
 * - Arithmetic: `+`, `-`, `*`, `/`
 * - Comparison: `=`, `<>`, `!=`, `<`, `>`, `<=`, `>=`
 * - Logical: `AND`, `OR`, `NOT`
 * - String concat: `&`
 *
 * **Functions:**
 * - Conditional: `IF`, `IFERROR`
 * - String: `LEN`, `UPPER`, `LOWER`, `LEFT`, `RIGHT`, `MID`, `TRIM`, `CONCAT`, `SUBSTITUTE`
 * - Numeric: `ROUND`, `ABS`, `CEILING`, `FLOOR`, `MOD`, `POWER`, `SQRT`
 * - Logical: `AND`, `OR`, `NOT`
 * - Null handling: `COALESCE`, `ISBLANK`
 *
 * ## Type Coercion
 *
 * The transpiler handles loose typing (like spreadsheets):
 * - `IF(@A > 10, "High", 0)` → Both branches cast to VARCHAR
 * - `LEN(@number_column)` → Column cast to VARCHAR before LENGTH()
 */

// Parser
export { parseFormula, extractColumnRefs, validateFormulaSyntax } from './parser'

// Transpiler
export { transpileFormula, validateFormula } from './transpiler'

// Function specs
export { FUNCTION_SPECS, getFunctionSpec, isSupportedFunction, getSupportedFunctions } from './functions'
export type { FunctionCategory } from './functions'

// AST types
export type {
  ASTNode,
  BinaryExpression,
  UnaryExpression,
  FunctionCall,
  ColumnRef,
  StringLiteral,
  NumberLiteral,
  BooleanLiteral,
  FunctionName,
  ParseResult,
  TranspileResult,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from './ast'
