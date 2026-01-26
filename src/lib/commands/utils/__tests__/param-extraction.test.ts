import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  extractCustomParams,
  hasCustomParams,
  getCustomParamKeys,
  validateParamSync,
  getExpectedCustomParams,
  COMMANDS_WITH_CUSTOM_PARAMS,
} from '../param-extraction'

describe('param-extraction utilities', () => {
  describe('extractCustomParams', () => {
    it('extracts custom params excluding base params', () => {
      const params = {
        tableId: 'table-123',
        column: 'name',
        length: 9,
        fillChar: '0',
      }

      const result = extractCustomParams(params)

      expect(result).toEqual({ length: 9, fillChar: '0' })
    })

    it('excludes tableName as well', () => {
      const params = {
        tableId: 'table-123',
        tableName: 'my_table',
        column: 'name',
        delimiter: ',',
      }

      const result = extractCustomParams(params)

      expect(result).toEqual({ delimiter: ',' })
    })

    it('returns empty object when only base params present', () => {
      const params = {
        tableId: 'table-123',
        column: 'name',
      }

      const result = extractCustomParams(params)

      expect(result).toEqual({})
    })

    it('handles params without column', () => {
      const params = {
        tableId: 'table-123',
        newColumnName: 'combined',
        delimiter: '-',
      }

      const result = extractCustomParams(params)

      expect(result).toEqual({ newColumnName: 'combined', delimiter: '-' })
    })

    it('preserves complex param values', () => {
      const params = {
        tableId: 'table-123',
        column: 'name',
        mappings: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }],
        options: { caseSensitive: true },
      }

      const result = extractCustomParams(params)

      expect(result).toEqual({
        mappings: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }],
        options: { caseSensitive: true },
      })
    })

    it('preserves boolean and null values', () => {
      const params = {
        tableId: 'table-123',
        column: 'name',
        caseSensitive: true,
        useRegex: false,
        replacement: null,
      }

      const result = extractCustomParams(params)

      expect(result).toEqual({
        caseSensitive: true,
        useRegex: false,
        replacement: null,
      })
    })
  })

  describe('hasCustomParams', () => {
    it('returns true when custom params exist', () => {
      const params = { tableId: 'x', column: 'y', length: 9 }
      expect(hasCustomParams(params)).toBe(true)
    })

    it('returns false when only base params exist', () => {
      const params = { tableId: 'x', column: 'y' }
      expect(hasCustomParams(params)).toBe(false)
    })

    it('returns false for empty object', () => {
      expect(hasCustomParams({})).toBe(false)
    })
  })

  describe('getCustomParamKeys', () => {
    it('returns array of custom param keys', () => {
      const params = { tableId: 'x', column: 'y', length: 9, fillChar: '0' }
      const keys = getCustomParamKeys(params)
      expect(keys.sort()).toEqual(['fillChar', 'length'])
    })

    it('returns empty array when no custom params', () => {
      const params = { tableId: 'x', column: 'y' }
      expect(getCustomParamKeys(params)).toEqual([])
    })
  })

  describe('validateParamSync', () => {
    const originalEnv = process.env.NODE_ENV

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      process.env.NODE_ENV = originalEnv
      vi.restoreAllMocks()
    })

    it('warns when custom param is missing in timeline params (dev mode)', () => {
      process.env.NODE_ENV = 'development'

      const commandParams = { tableId: 'x', column: 'y', length: 9 }
      const timelineParams = { params: {} } // Missing 'length'

      validateParamSync(commandParams, timelineParams, 'transform:pad_zeros')

      expect(console.warn).toHaveBeenCalled()
    })

    it('warns when param values mismatch (dev mode)', () => {
      process.env.NODE_ENV = 'development'

      const commandParams = { tableId: 'x', column: 'y', length: 9 }
      const timelineParams = { params: { length: 5 } } // Different value

      validateParamSync(commandParams, timelineParams, 'transform:pad_zeros')

      expect(console.warn).toHaveBeenCalled()
    })

    it('does not warn when params match', () => {
      process.env.NODE_ENV = 'development'

      const commandParams = { tableId: 'x', column: 'y', length: 9 }
      const timelineParams = { params: { length: 9 } }

      validateParamSync(commandParams, timelineParams, 'transform:pad_zeros')

      expect(console.warn).not.toHaveBeenCalled()
    })

    it('does nothing in production mode', () => {
      process.env.NODE_ENV = 'production'

      const commandParams = { tableId: 'x', column: 'y', length: 9 }
      const timelineParams = { params: {} } // Would normally warn

      validateParamSync(commandParams, timelineParams, 'transform:pad_zeros')

      expect(console.warn).not.toHaveBeenCalled()
    })

    it('does not warn when no custom params exist', () => {
      process.env.NODE_ENV = 'development'

      const commandParams = { tableId: 'x', column: 'y' }
      const timelineParams = {}

      validateParamSync(commandParams, timelineParams, 'transform:trim')

      expect(console.warn).not.toHaveBeenCalled()
    })
  })

  describe('getExpectedCustomParams', () => {
    it('returns expected params for known command types', () => {
      expect(getExpectedCustomParams('transform:pad_zeros')).toContain('length')
      expect(getExpectedCustomParams('transform:replace')).toContain('find')
      expect(getExpectedCustomParams('transform:split_column')).toContain('delimiter')
    })

    it('returns undefined for unknown command types', () => {
      expect(getExpectedCustomParams('unknown:command')).toBeUndefined()
    })
  })

  describe('COMMANDS_WITH_CUSTOM_PARAMS', () => {
    it('includes high-risk Tier 3 commands', () => {
      expect(COMMANDS_WITH_CUSTOM_PARAMS['transform:split_column']).toBeDefined()
      expect(COMMANDS_WITH_CUSTOM_PARAMS['transform:combine_columns']).toBeDefined()
      expect(COMMANDS_WITH_CUSTOM_PARAMS['match:merge']).toBeDefined()
    })

    it('includes all expected param names for pad_zeros', () => {
      const padZerosParams = COMMANDS_WITH_CUSTOM_PARAMS['transform:pad_zeros']
      expect(padZerosParams).toContain('length')
      expect(padZerosParams).toContain('fillChar')
      expect(padZerosParams).toContain('position')
    })
  })
})
