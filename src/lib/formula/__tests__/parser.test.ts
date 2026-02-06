/**
 * Formula Builder Parser Tests
 *
 * Tests for parsing spreadsheet-style formulas into AST.
 */

import { describe, it, expect } from 'vitest'
import { parseFormula, extractColumnRefs, validateFormulaSyntax } from '../parser'

describe('parseFormula', () => {
  describe('literals', () => {
    it('parses string literals', () => {
      const result = parseFormula('"hello"')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'StringLiteral',
        value: 'hello',
      })
    })

    it('parses number literals', () => {
      const result = parseFormula('42')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'NumberLiteral',
        value: 42,
      })
    })

    it('parses decimal numbers', () => {
      const result = parseFormula('3.14')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'NumberLiteral',
        value: 3.14,
      })
    })

    it('parses negative numbers as unary expression', () => {
      const result = parseFormula('-100')
      expect(result.success).toBe(true)
      // Negative numbers are parsed as unary minus applied to positive number
      expect(result.ast).toMatchObject({
        type: 'UnaryExpression',
        operator: '-',
        argument: { type: 'NumberLiteral', value: 100 },
      })
    })

    it('parses TRUE boolean', () => {
      const result = parseFormula('TRUE')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'BooleanLiteral',
        value: true,
      })
    })

    it('parses FALSE boolean (case-insensitive)', () => {
      const result = parseFormula('false')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'BooleanLiteral',
        value: false,
      })
    })
  })

  describe('column references', () => {
    it('parses simple column reference', () => {
      const result = parseFormula('@name')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'ColumnRef',
        columnName: 'name',
      })
    })

    it('parses column reference with underscores', () => {
      const result = parseFormula('@first_name')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'ColumnRef',
        columnName: 'first_name',
      })
    })

    it('parses bracketed column reference', () => {
      const result = parseFormula('@[Column Name]')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'ColumnRef',
        columnName: 'Column Name',
      })
    })

    it('parses bracketed column with special characters', () => {
      const result = parseFormula('@[Total Revenue ($)]')
      expect(result.success).toBe(true)
      expect(result.ast).toEqual({
        type: 'ColumnRef',
        columnName: 'Total Revenue ($)',
      })
    })
  })

  describe('binary expressions', () => {
    it('parses addition', () => {
      const result = parseFormula('@a + @b')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'BinaryExpression',
        operator: '+',
        left: { type: 'ColumnRef', columnName: 'a' },
        right: { type: 'ColumnRef', columnName: 'b' },
      })
    })

    it('parses multiplication with precedence', () => {
      const result = parseFormula('@a + @b * @c')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'BinaryExpression',
        operator: '+',
        left: { type: 'ColumnRef', columnName: 'a' },
        right: {
          type: 'BinaryExpression',
          operator: '*',
          left: { type: 'ColumnRef', columnName: 'b' },
          right: { type: 'ColumnRef', columnName: 'c' },
        },
      })
    })

    it('parses equality comparison', () => {
      const result = parseFormula('@status = "active"')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'BinaryExpression',
        operator: '=',
        left: { type: 'ColumnRef', columnName: 'status' },
        right: { type: 'StringLiteral', value: 'active' },
      })
    })

    it('parses not equal comparison', () => {
      const result = parseFormula('@value <> 0')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'BinaryExpression',
        operator: '<>',
      })
    })

    it('parses string concatenation with &', () => {
      const result = parseFormula('@first & " " & @last')
      expect(result.success).toBe(true)
      expect(result.ast?.type).toBe('BinaryExpression')
      expect((result.ast as { operator: string }).operator).toBe('&')
    })
  })

  describe('function calls', () => {
    it('parses UPPER function', () => {
      const result = parseFormula('UPPER(@name)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'UPPER',
        arguments: [{ type: 'ColumnRef', columnName: 'name' }],
      })
    })

    it('parses function names case-insensitively', () => {
      const resultUpper = parseFormula('UPPER(@x)')
      const resultLower = parseFormula('upper(@x)')
      const resultMixed = parseFormula('Upper(@x)')

      expect(resultUpper.success).toBe(true)
      expect(resultLower.success).toBe(true)
      expect(resultMixed.success).toBe(true)

      expect(resultUpper.ast).toMatchObject({ name: 'UPPER' })
      expect(resultLower.ast).toMatchObject({ name: 'UPPER' })
      expect(resultMixed.ast).toMatchObject({ name: 'UPPER' })
    })

    it('parses IF with three arguments', () => {
      const result = parseFormula('IF(@value > 10, "high", "low")')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'IF',
        arguments: [
          { type: 'BinaryExpression', operator: '>' },
          { type: 'StringLiteral', value: 'high' },
          { type: 'StringLiteral', value: 'low' },
        ],
      })
    })

    it('parses nested functions', () => {
      const result = parseFormula('UPPER(TRIM(@name))')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'UPPER',
        arguments: [{
          type: 'FunctionCall',
          name: 'TRIM',
          arguments: [{ type: 'ColumnRef', columnName: 'name' }],
        }],
      })
    })

    it('parses LEN function', () => {
      const result = parseFormula('LEN(@text)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'LEN',
      })
    })

    it('parses CONCAT with multiple arguments', () => {
      const result = parseFormula('CONCAT(@a, " ", @b, " ", @c)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'CONCAT',
      })
      expect((result.ast as { arguments: unknown[] }).arguments).toHaveLength(5)
    })

    it('parses MID function', () => {
      const result = parseFormula('MID(@text, 1, 5)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'MID',
      })
      expect((result.ast as { arguments: unknown[] }).arguments).toHaveLength(3)
    })

    it('parses PROPER function', () => {
      const result = parseFormula('PROPER(@name)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'PROPER',
        arguments: [{ type: 'ColumnRef', columnName: 'name' }],
      })
    })

    it('parses SPLIT function', () => {
      const result = parseFormula('SPLIT(@name, " ", 1)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'SPLIT',
      })
      expect((result.ast as { arguments: unknown[] }).arguments).toHaveLength(3)
    })

    it('parses date functions YEAR, MONTH, DAY', () => {
      for (const fn of ['YEAR', 'MONTH', 'DAY']) {
        const result = parseFormula(`${fn}(@date_col)`)
        expect(result.success).toBe(true)
        expect(result.ast).toMatchObject({
          type: 'FunctionCall',
          name: fn,
          arguments: [{ type: 'ColumnRef', columnName: 'date_col' }],
        })
      }
    })

    it('parses DATEDIFF function', () => {
      const result = parseFormula('DATEDIFF(@start, @end)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'DATEDIFF',
        arguments: [
          { type: 'ColumnRef', columnName: 'start' },
          { type: 'ColumnRef', columnName: 'end' },
        ],
      })
    })

    it('parses REGEXEXTRACT function', () => {
      const result = parseFormula('REGEXEXTRACT(@email, "^[^@]+")')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'REGEXEXTRACT',
      })
      expect((result.ast as { arguments: unknown[] }).arguments).toHaveLength(2)
    })
  })

  describe('logical operators', () => {
    it('parses AND expression', () => {
      const result = parseFormula('@a > 0 AND @b > 0')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'AND',
      })
    })

    it('parses OR expression', () => {
      const result = parseFormula('@status = "active" OR @status = "pending"')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'OR',
      })
    })

    it('parses NOT expression', () => {
      const result = parseFormula('NOT @disabled')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'UnaryExpression',
        operator: 'NOT',
        argument: { type: 'ColumnRef', columnName: 'disabled' },
      })
    })
  })

  describe('error handling', () => {
    it('returns error for empty formula', () => {
      const result = parseFormula('')
      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
    })

    it('returns error for whitespace-only formula', () => {
      const result = parseFormula('   ')
      expect(result.success).toBe(false)
    })

    it('returns error for unclosed parenthesis', () => {
      const result = parseFormula('UPPER(@name')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Syntax error')
    })

    it('returns error for invalid operator', () => {
      const result = parseFormula('@a ** @b')
      expect(result.success).toBe(false)
    })
  })

  describe('leading = sign', () => {
    it('removes leading = sign (spreadsheet-style)', () => {
      const result = parseFormula('=UPPER(@name)')
      expect(result.success).toBe(true)
      expect(result.ast).toMatchObject({
        type: 'FunctionCall',
        name: 'UPPER',
      })
    })
  })
})

describe('extractColumnRefs', () => {
  it('extracts single column reference', () => {
    const cols = extractColumnRefs('@name')
    expect(cols).toEqual(['name'])
  })

  it('extracts multiple column references', () => {
    const cols = extractColumnRefs('@first & " " & @last')
    expect(cols).toContain('first')
    expect(cols).toContain('last')
  })

  it('extracts columns from nested expressions', () => {
    const cols = extractColumnRefs('IF(@a > @b, @c, @d)')
    expect(cols).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']))
  })

  it('deduplicates column references', () => {
    const cols = extractColumnRefs('@name & " " & @name')
    expect(cols).toEqual(['name'])
  })

  it('extracts bracketed column names', () => {
    const cols = extractColumnRefs('@[Column Name] + @regular')
    expect(cols).toContain('Column Name')
    expect(cols).toContain('regular')
  })

  it('returns empty array for invalid formula', () => {
    const cols = extractColumnRefs('invalid @@@ syntax')
    expect(cols).toEqual([])
  })
})

describe('validateFormulaSyntax', () => {
  it('returns valid for correct formula', () => {
    const result = validateFormulaSyntax('UPPER(@name)')
    expect(result.valid).toBe(true)
  })

  it('returns invalid for syntax error', () => {
    const result = validateFormulaSyntax('UPPER(@name')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns valid for all supported functions', () => {
    // Function call syntax formulas
    const functionFormulas = [
      'IF(@a, @b, @c)',
      'IFERROR(@a, @b)',
      'LEN(@a)',
      'UPPER(@a)',
      'LOWER(@a)',
      'LEFT(@a, 3)',
      'RIGHT(@a, 3)',
      'MID(@a, 1, 5)',
      'TRIM(@a)',
      'CONCAT(@a, @b)',
      'ROUND(@a, 2)',
      'ABS(@a)',
      'AND(@a, @b)',
      'OR(@a, @b)',
      'COALESCE(@a, @b)',
      'ISBLANK(@a)',
      // New functions
      'PROPER(@a)',
      'SPLIT(@a, ",", 1)',
      'YEAR(@a)',
      'MONTH(@a)',
      'DAY(@a)',
      'DATEDIFF(@a, @b)',
      'REGEXEXTRACT(@a, "pattern")',
    ]

    for (const formula of functionFormulas) {
      const result = validateFormulaSyntax(formula)
      expect(result.valid, `Formula "${formula}" should be valid but got error: ${result.error}`).toBe(true)
    }
  })

  it('returns valid for NOT as unary operator', () => {
    // NOT(@a) parses as a unary expression, not a function call
    const result = validateFormulaSyntax('NOT @a')
    expect(result.valid).toBe(true)
  })
})
