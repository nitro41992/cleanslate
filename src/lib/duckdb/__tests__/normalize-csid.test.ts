import { describe, it, expect } from 'vitest'
import { normalizeCsId } from '../index'

describe('normalizeCsId', () => {
  it('converts BigInt to string without "n" suffix', () => {
    // This is the actual bug we fixed - DuckDB returns BIGINT which becomes
    // JavaScript BigInt. Without String() conversion, template literals
    // produce "1n:name" instead of "1:name"
    const bigIntValue = BigInt(1)
    const result = normalizeCsId(bigIntValue)

    expect(result).toBe('1')
    expect(result).not.toContain('n') // No BigInt suffix
    expect(typeof result).toBe('string')
  })

  it('converts large BigInt values correctly', () => {
    // Test with a value larger than Number.MAX_SAFE_INTEGER
    const largeBigInt = BigInt('9007199254740993') // MAX_SAFE_INTEGER + 2
    const result = normalizeCsId(largeBigInt)

    expect(result).toBe('9007199254740993')
    expect(typeof result).toBe('string')
  })

  it('converts numbers to string', () => {
    expect(normalizeCsId(42)).toBe('42')
    expect(normalizeCsId(0)).toBe('0')
    expect(normalizeCsId(-1)).toBe('-1')
  })

  it('passes through string values unchanged', () => {
    expect(normalizeCsId('abc')).toBe('abc')
    expect(normalizeCsId('123')).toBe('123')
  })

  it('handles edge cases', () => {
    // These shouldn't happen in practice, but should not throw
    expect(normalizeCsId(null)).toBe('null')
    expect(normalizeCsId(undefined)).toBe('undefined')
  })

  it('produces consistent output for same logical value', () => {
    // The key invariant: same logical value must produce same string
    // This is critical for dirty cell key comparison across sessions
    const bigIntOne = BigInt(1)
    const numberOne = 1
    const stringOne = '1'

    expect(normalizeCsId(bigIntOne)).toBe(normalizeCsId(numberOne))
    expect(normalizeCsId(numberOne)).toBe(stringOne)
  })
})
