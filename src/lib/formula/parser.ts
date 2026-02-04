/**
 * Excel Formula Parser (Ohm.js)
 *
 * Parses Excel-like formulas into an AST for transpilation to DuckDB SQL.
 * Supports case-insensitive function names and @column syntax.
 */

import * as ohm from 'ohm-js'
import type {
  ASTNode,
  BinaryExpression,
  UnaryExpression,
  FunctionCall,
  ColumnRef,
  StringLiteral,
  NumberLiteral,
  BooleanLiteral,
  ParseResult,
  FunctionName,
} from './ast'
import { isSupportedFunction } from './functions'

/**
 * Ohm.js grammar for Excel-like formulas.
 *
 * Grammar features:
 * - Case-insensitive function names
 * - Column references: @name or @[Name With Spaces]
 * - Standard operators: +, -, *, /, =, <>, <, >, <=, >=, &
 * - String literals with double quotes
 * - Number literals (integers and decimals)
 * - Boolean literals (TRUE, FALSE)
 */
const grammarSource = `
ExcelFormula {
  Formula = Expression

  Expression = ConditionalExpr

  // IF is handled as a function call, but we allow it at expression level
  ConditionalExpr = LogicalOr

  // Logical operators (lowest precedence)
  LogicalOr = LogicalOr orOp LogicalAnd  -- or
            | LogicalAnd

  LogicalAnd = LogicalAnd andOp Comparison  -- and
             | Comparison

  orOp = caseInsensitive<"OR">
  andOp = caseInsensitive<"AND">

  // Comparison operators
  Comparison = AddExpr compOp AddExpr  -- compare
             | AddExpr

  compOp = "<=" | ">=" | "<>" | "!=" | "=" | "<" | ">"

  // Additive: + - &
  AddExpr = AddExpr "+" MulExpr  -- add
          | AddExpr "-" MulExpr  -- sub
          | AddExpr "&" MulExpr  -- concat
          | MulExpr

  // Multiplicative: * /
  MulExpr = MulExpr "*" UnaryExpr  -- mul
          | MulExpr "/" UnaryExpr  -- div
          | UnaryExpr

  // Unary: - NOT
  UnaryExpr = "-" UnaryExpr         -- neg
            | notOp UnaryExpr       -- not
            | Primary

  notOp = caseInsensitive<"NOT">

  // Primary expressions
  Primary = FunctionCall
          | ColumnRef
          | BooleanLiteral
          | NumberLiteral
          | StringLiteral
          | "(" Expression ")"  -- paren

  // Function call: FUNC(arg1, arg2, ...)
  FunctionCall = functionName "(" ListOf<Expression, ","> ")"

  // Supported function names (case-insensitive)
  // NOTE: Longer names MUST come before shorter prefixes (IFERROR before IF)
  functionName = caseInsensitive<"IFERROR">
               | caseInsensitive<"ISBLANK">
               | caseInsensitive<"IF">
               | caseInsensitive<"LEN">
               | caseInsensitive<"UPPER">
               | caseInsensitive<"LOWER">
               | caseInsensitive<"LEFT">
               | caseInsensitive<"RIGHT">
               | caseInsensitive<"MID">
               | caseInsensitive<"TRIM">
               | caseInsensitive<"CONCAT">
               | caseInsensitive<"SUBSTITUTE">
               | caseInsensitive<"ROUND">
               | caseInsensitive<"ABS">
               | caseInsensitive<"CEILING">
               | caseInsensitive<"FLOOR">
               | caseInsensitive<"MOD">
               | caseInsensitive<"POWER">
               | caseInsensitive<"SQRT">
               | caseInsensitive<"AND">
               | caseInsensitive<"OR">
               | caseInsensitive<"NOT">
               | caseInsensitive<"COALESCE">

  // Column reference: @name or @[Name With Spaces]
  ColumnRef = "@" (bracketedName | simpleName)
  bracketedName = "[" (~"]" any)+ "]"
  simpleName = letter (letter | digit | "_")*

  // Literals
  BooleanLiteral = caseInsensitive<"TRUE"> | caseInsensitive<"FALSE">
  NumberLiteral = "-"? digit+ ("." digit+)?
  StringLiteral = "\\"" (~"\\"" any)* "\\""

  // Whitespace handling (implicit)
  space += " " | "\\t" | "\\n" | "\\r"
}
`

// Create the Ohm grammar
const grammar = ohm.grammar(grammarSource)

// Create semantics for AST generation
// Use 'unknown' as return type to avoid strict typing issues with ohm-js
const semantics = grammar.createSemantics()

semantics.addOperation<unknown>('toAST', {
  Formula(expr) {
    return expr.toAST()
  },

  Expression(expr) {
    return expr.toAST()
  },

  ConditionalExpr(expr) {
    return expr.toAST()
  },

  // Logical OR
  LogicalOr_or(left, _op, right) {
    return {
      type: 'FunctionCall',
      name: 'OR',
      arguments: [left.toAST(), right.toAST()],
    } as FunctionCall
  },
  LogicalOr(expr) {
    return expr.toAST()
  },

  // Logical AND
  LogicalAnd_and(left, _op, right) {
    return {
      type: 'FunctionCall',
      name: 'AND',
      arguments: [left.toAST(), right.toAST()],
    } as FunctionCall
  },
  LogicalAnd(expr) {
    return expr.toAST()
  },

  // Comparison
  Comparison_compare(left, op, right) {
    const opStr = op.sourceString.trim()
    return {
      type: 'BinaryExpression',
      operator: opStr as BinaryExpression['operator'],
      left: left.toAST(),
      right: right.toAST(),
    } as BinaryExpression
  },
  Comparison(expr) {
    return expr.toAST()
  },

  // Additive expressions
  AddExpr_add(left, _op, right) {
    return {
      type: 'BinaryExpression',
      operator: '+',
      left: left.toAST(),
      right: right.toAST(),
    } as BinaryExpression
  },
  AddExpr_sub(left, _op, right) {
    return {
      type: 'BinaryExpression',
      operator: '-',
      left: left.toAST(),
      right: right.toAST(),
    } as BinaryExpression
  },
  AddExpr_concat(left, _op, right) {
    return {
      type: 'BinaryExpression',
      operator: '&',
      left: left.toAST(),
      right: right.toAST(),
    } as BinaryExpression
  },
  AddExpr(expr) {
    return expr.toAST()
  },

  // Multiplicative expressions
  MulExpr_mul(left, _op, right) {
    return {
      type: 'BinaryExpression',
      operator: '*',
      left: left.toAST(),
      right: right.toAST(),
    } as BinaryExpression
  },
  MulExpr_div(left, _op, right) {
    return {
      type: 'BinaryExpression',
      operator: '/',
      left: left.toAST(),
      right: right.toAST(),
    } as BinaryExpression
  },
  MulExpr(expr) {
    return expr.toAST()
  },

  // Unary expressions
  UnaryExpr_neg(_op, expr) {
    return {
      type: 'UnaryExpression',
      operator: '-',
      argument: expr.toAST(),
    } as UnaryExpression
  },
  UnaryExpr_not(_op, expr) {
    return {
      type: 'UnaryExpression',
      operator: 'NOT',
      argument: expr.toAST(),
    } as UnaryExpression
  },
  UnaryExpr(expr) {
    return expr.toAST()
  },

  // Primary expressions
  Primary_paren(_lparen, expr, _rparen) {
    return expr.toAST()
  },
  Primary(expr) {
    return expr.toAST()
  },

  // Function call
  FunctionCall(name, _lparen, args, _rparen) {
    const funcName = name.sourceString.toUpperCase() as FunctionName
    const argList = args.asIteration().children.map((child) => child.toAST()) as ASTNode[]
    return {
      type: 'FunctionCall',
      name: funcName,
      arguments: argList,
    } as FunctionCall
  },

  // Column reference
  ColumnRef(_at, name) {
    const columnName = name.sourceString
    // Remove brackets if present
    const cleanName = columnName.startsWith('[') && columnName.endsWith(']')
      ? columnName.slice(1, -1)
      : columnName
    return {
      type: 'ColumnRef',
      columnName: cleanName,
    } as ColumnRef
  },

  // Literals
  BooleanLiteral(val) {
    return {
      type: 'BooleanLiteral',
      value: val.sourceString.toUpperCase() === 'TRUE',
    } as BooleanLiteral
  },

  NumberLiteral(minus, intPart, dot, decPart) {
    const numStr = minus.sourceString + intPart.sourceString + dot.sourceString + decPart.sourceString
    return {
      type: 'NumberLiteral',
      value: parseFloat(numStr),
    } as NumberLiteral
  },

  StringLiteral(_openQuote, chars, _closeQuote) {
    return {
      type: 'StringLiteral',
      value: chars.sourceString,
    } as StringLiteral
  },

  // Handle iteration (ListOf)
  NonemptyListOf(first, _sep, rest) {
    return [first.toAST(), ...rest.children.map((child) => child.toAST())]
  },

  EmptyListOf() {
    return []
  },

  // Handle remaining terminals
  _terminal() {
    return this.sourceString
  },

  _iter(...children) {
    return children.map((child) => child.toAST())
  },
})

/**
 * Parse an Excel-like formula string into an AST.
 *
 * @param formula - The formula string (e.g., "IF(@State = \"NY\", \"East\", \"West\")")
 * @returns ParseResult with AST on success or error details on failure
 *
 * @example
 * ```typescript
 * const result = parseFormula('UPPER(@name)')
 * if (result.success) {
 *   console.log(result.ast)
 *   // { type: 'FunctionCall', name: 'UPPER', arguments: [{ type: 'ColumnRef', columnName: 'name' }] }
 * }
 * ```
 */
export function parseFormula(formula: string): ParseResult {
  // Handle empty formula
  if (!formula || formula.trim() === '') {
    return {
      success: false,
      error: 'Formula cannot be empty',
    }
  }

  // Remove leading = if present (Excel style)
  const cleanFormula = formula.trim().replace(/^=/, '').trim()

  if (cleanFormula === '') {
    return {
      success: false,
      error: 'Formula cannot be empty',
    }
  }

  try {
    const matchResult = grammar.match(cleanFormula)

    if (matchResult.failed()) {
      // Extract error position and message
      const errorPos = (matchResult as unknown as { getRightmostFailurePosition: () => number }).getRightmostFailurePosition?.() ?? 0
      return {
        success: false,
        error: `Syntax error at position ${errorPos}: ${matchResult.shortMessage}`,
        errorPosition: errorPos,
      }
    }

    const ast = semantics(matchResult).toAST() as ASTNode
    return {
      success: true,
      ast,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parsing error',
    }
  }
}

/**
 * Extract all column references from a formula string.
 * Useful for validation before transpilation.
 */
export function extractColumnRefs(formula: string): string[] {
  const result = parseFormula(formula)
  if (!result.success || !result.ast) {
    return []
  }

  const columns: string[] = []

  function walk(node: ASTNode) {
    switch (node.type) {
      case 'ColumnRef':
        columns.push(node.columnName)
        break
      case 'BinaryExpression':
        walk(node.left)
        walk(node.right)
        break
      case 'UnaryExpression':
        walk(node.argument)
        break
      case 'FunctionCall':
        node.arguments.forEach(walk)
        break
      // Literals have no column refs
    }
  }

  walk(result.ast)
  return [...new Set(columns)] // Deduplicate
}

/**
 * Validate a formula for syntax and supported functions.
 */
export function validateFormulaSyntax(formula: string): { valid: boolean; error?: string } {
  const result = parseFormula(formula)
  if (!result.success) {
    return { valid: false, error: result.error }
  }

  // Check all function names are supported
  const unsupportedFunctions: string[] = []

  function checkFunctions(node: ASTNode) {
    switch (node.type) {
      case 'FunctionCall':
        if (!isSupportedFunction(node.name)) {
          unsupportedFunctions.push(node.name)
        }
        node.arguments.forEach(checkFunctions)
        break
      case 'BinaryExpression':
        checkFunctions(node.left)
        checkFunctions(node.right)
        break
      case 'UnaryExpression':
        checkFunctions(node.argument)
        break
    }
  }

  checkFunctions(result.ast!)

  if (unsupportedFunctions.length > 0) {
    return {
      valid: false,
      error: `Unsupported function(s): ${unsupportedFunctions.join(', ')}`,
    }
  }

  return { valid: true }
}

export { grammar, semantics }
