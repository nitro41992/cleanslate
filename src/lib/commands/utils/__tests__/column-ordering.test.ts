import { describe, it, expect } from 'vitest'
import { reorderColumns, updateColumnOrder } from '../column-ordering'
import type { ColumnInfo } from '@/types'

describe('column-ordering utilities', () => {
  describe('reorderColumns', () => {
    it('preserves original column order', () => {
      const fetched: ColumnInfo[] = [
        { name: 'status', type: 'VARCHAR', nullable: true },
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'email', type: 'VARCHAR', nullable: true },
        { name: 'name', type: 'VARCHAR', nullable: true }
      ]
      const originalOrder = ['id', 'name', 'email', 'status']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(originalOrder)
    })

    it('appends new columns at end', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'email', type: 'VARCHAR', nullable: true },
        { name: 'new_column', type: 'VARCHAR', nullable: true }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(['id', 'email', 'new_column'])
    })

    it('filters out dropped columns', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'email', type: 'VARCHAR', nullable: true }
      ]
      const originalOrder = ['id', 'name', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(['id', 'email'])
    })

    it('applies rename mappings to original order', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'email_address', type: 'VARCHAR', nullable: true },
        { name: 'status', type: 'VARCHAR', nullable: true }
      ]
      const originalOrder = ['id', 'email', 'status']
      const renameMappings = { 'email': 'email_address' }

      const result = reorderColumns(fetched, originalOrder, renameMappings)

      expect(result.map(c => c.name)).toEqual(['id', 'email_address', 'status'])
    })

    it('excludes internal columns (_cs_id, __base)', () => {
      const fetched: ColumnInfo[] = [
        { name: '_cs_id', type: 'VARCHAR', nullable: false },
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'email', type: 'VARCHAR', nullable: true },
        { name: 'email__base', type: 'VARCHAR', nullable: true }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result.map(c => c.name)).toEqual(['id', 'email'])
      expect(result.some(c => c.name === '_cs_id')).toBe(false)
      expect(result.some(c => c.name.endsWith('__base'))).toBe(false)
    })

    it('handles phantom columns by appending at end', () => {
      const fetched: ColumnInfo[] = [
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'phantom', type: 'VARCHAR', nullable: true },
        { name: 'email', type: 'VARCHAR', nullable: true }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      // Phantom column not in originalOrder or newColumns → append at end
      expect(result.map(c => c.name)).toEqual(['id', 'email', 'phantom'])
    })

    it('returns fetched order when originalOrder is undefined', () => {
      const fetched: ColumnInfo[] = [
        { name: 'status', type: 'VARCHAR', nullable: true },
        { name: 'id', type: 'INTEGER', nullable: false }
      ]

      const result = reorderColumns(fetched, undefined)

      expect(result.map(c => c.name)).toEqual(['status', 'id'])
    })

    it('preserves ColumnInfo properties while reordering', () => {
      const fetched: ColumnInfo[] = [
        { name: 'email', type: 'VARCHAR', nullable: true },
        { name: 'id', type: 'INTEGER', nullable: false }
      ]
      const originalOrder = ['id', 'email']

      const result = reorderColumns(fetched, originalOrder)

      expect(result[0]).toEqual({ name: 'id', type: 'INTEGER', nullable: false })
      expect(result[1]).toEqual({ name: 'email', type: 'VARCHAR', nullable: true })
    })
  })

  describe('updateColumnOrder', () => {
    it('applies rename to current order', () => {
      const currentOrder = ['id', 'email', 'status']
      const renameMappings = { 'email': 'email_address' }

      const result = updateColumnOrder(currentOrder, [], [], renameMappings)

      expect(result).toEqual(['id', 'email_address', 'status'])
    })

    it('removes dropped columns from order', () => {
      const currentOrder = ['id', 'name', 'email', 'status']
      const droppedColumnNames = ['name']

      const result = updateColumnOrder(currentOrder, [], droppedColumnNames)

      expect(result).toEqual(['id', 'email', 'status'])
    })

    it('appends new user columns at end', () => {
      const currentOrder = ['id', 'email']
      const newColumnNames = ['status', 'role']

      const result = updateColumnOrder(currentOrder, newColumnNames, [])

      expect(result).toEqual(['id', 'email', 'status', 'role'])
    })

    it('filters internal columns from new columns', () => {
      const currentOrder = ['id', 'email']
      const newColumnNames = ['status', '_cs_id', 'email__base']

      const result = updateColumnOrder(currentOrder, newColumnNames, [])

      expect(result).toEqual(['id', 'email', 'status'])
    })

    it('handles all operations (rename + add + drop)', () => {
      const currentOrder = ['id', 'name', 'email', 'status']
      const newColumnNames = ['name_1', 'name_2']
      const droppedColumnNames = ['name']
      const renameMappings = { 'email': 'email_address' }

      const result = updateColumnOrder(
        currentOrder,
        newColumnNames,
        droppedColumnNames,
        renameMappings
      )

      expect(result).toEqual(['id', 'email_address', 'status', 'name_1', 'name_2'])
    })

    it('handles undefined current order', () => {
      const currentOrder = undefined
      const newColumnNames = ['id', 'email', 'status']

      const result = updateColumnOrder(currentOrder, newColumnNames, [])

      expect(result).toEqual(['id', 'email', 'status'])
    })

    it('preserves order when no changes', () => {
      const currentOrder = ['id', 'email', 'status']

      const result = updateColumnOrder(currentOrder, [], [])

      expect(result).toEqual(['id', 'email', 'status'])
    })

    it('handles multiple renames', () => {
      const currentOrder = ['id', 'first_name', 'last_name', 'email']
      const renameMappings = {
        'first_name': 'fname',
        'last_name': 'lname'
      }

      const result = updateColumnOrder(currentOrder, [], [], renameMappings)

      expect(result).toEqual(['id', 'fname', 'lname', 'email'])
    })

    it('handles drop and add in same operation', () => {
      const currentOrder = ['id', 'full_name', 'email']
      const newColumnNames = ['first_name', 'last_name']
      const droppedColumnNames = ['full_name']

      const result = updateColumnOrder(currentOrder, newColumnNames, droppedColumnNames)

      expect(result).toEqual(['id', 'email', 'first_name', 'last_name'])
    })

    describe('insertAfter parameter', () => {
      it('inserts new column after specified column', () => {
        const currentOrder = ['id', 'name', 'email']
        const newColumnNames = ['new_col']

        const result = updateColumnOrder(
          currentOrder,
          newColumnNames,
          [],
          undefined,
          'name' // insertAfter
        )

        expect(result).toEqual(['id', 'name', 'new_col', 'email'])
      })

      it('inserts new column at beginning when insertAfter is null', () => {
        const currentOrder = ['id', 'name', 'email']
        const newColumnNames = ['new_col']

        const result = updateColumnOrder(
          currentOrder,
          newColumnNames,
          [],
          undefined,
          null // insertAfter = null means beginning
        )

        expect(result).toEqual(['new_col', 'id', 'name', 'email'])
      })

      it('appends at end when insertAfter is undefined (default behavior)', () => {
        const currentOrder = ['id', 'name', 'email']
        const newColumnNames = ['new_col']

        const result = updateColumnOrder(
          currentOrder,
          newColumnNames,
          [],
          undefined,
          undefined // no insertAfter = append at end
        )

        expect(result).toEqual(['id', 'name', 'email', 'new_col'])
      })

      it('inserts after last column correctly', () => {
        const currentOrder = ['id', 'name', 'email']
        const newColumnNames = ['new_col']

        const result = updateColumnOrder(
          currentOrder,
          newColumnNames,
          [],
          undefined,
          'email' // insert after last
        )

        expect(result).toEqual(['id', 'name', 'email', 'new_col'])
      })

      it('inserts after first column correctly', () => {
        const currentOrder = ['id', 'name', 'email']
        const newColumnNames = ['new_col']

        const result = updateColumnOrder(
          currentOrder,
          newColumnNames,
          [],
          undefined,
          'id' // insert after first
        )

        expect(result).toEqual(['id', 'new_col', 'name', 'email'])
      })

      it('falls back to append when insertAfter column not found', () => {
        const currentOrder = ['id', 'name', 'email']
        const newColumnNames = ['new_col']

        const result = updateColumnOrder(
          currentOrder,
          newColumnNames,
          [],
          undefined,
          'nonexistent' // column doesn't exist
        )

        expect(result).toEqual(['id', 'name', 'email', 'new_col'])
      })
    })
  })
})
