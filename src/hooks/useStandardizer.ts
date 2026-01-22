import { useCallback, useRef } from 'react'
import { useStandardizerStore } from '@/stores/standardizerStore'
import {
  validateColumnForClustering,
  buildClusters,
  applyStandardization,
} from '@/lib/standardizer-engine'
import { generateId } from '@/lib/utils'

export function useStandardizer() {
  const cancelRef = useRef(false)

  const {
    tableName,
    columnName,
    algorithm,
    setIsAnalyzing,
    setProgress,
    resetProgress,
    setClusters,
    setValidationError,
    setUniqueValueCount,
    getSelectedMappings,
  } = useStandardizerStore()

  /**
   * Start clustering analysis
   */
  const startClustering = useCallback(async () => {
    if (!tableName || !columnName) {
      setValidationError('Please select a table and column')
      return
    }

    cancelRef.current = false
    setIsAnalyzing(true)
    setValidationError(null)
    resetProgress()

    try {
      // Phase 1: Validate
      setProgress(0, 'validating')
      const validation = await validateColumnForClustering(tableName, columnName)

      if (!validation.valid) {
        setValidationError(validation.error || 'Validation failed')
        setUniqueValueCount(validation.uniqueCount)
        return
      }

      setUniqueValueCount(validation.uniqueCount)

      if (cancelRef.current) return

      // Phase 2: Build clusters
      const clusters = await buildClusters(
        tableName,
        columnName,
        algorithm,
        (progressInfo) => {
          setProgress(
            progressInfo.progress,
            progressInfo.phase,
            progressInfo.currentChunk,
            progressInfo.totalChunks
          )
        },
        () => cancelRef.current
      )

      if (cancelRef.current) return

      setClusters(clusters)
    } catch (error) {
      console.error('Clustering failed:', error)
      setValidationError(
        error instanceof Error ? error.message : 'Clustering failed'
      )
    } finally {
      setIsAnalyzing(false)
      resetProgress()
    }
  }, [
    tableName,
    columnName,
    algorithm,
    setIsAnalyzing,
    setProgress,
    resetProgress,
    setClusters,
    setValidationError,
    setUniqueValueCount,
  ])

  /**
   * Cancel ongoing clustering
   */
  const cancelClustering = useCallback(() => {
    cancelRef.current = true
  }, [])

  /**
   * Apply standardization with selected mappings
   */
  const applyChanges = useCallback(async (): Promise<{
    success: boolean
    rowsAffected: number
    auditEntryId: string | null
    hasRowDetails: boolean
    error?: string
  }> => {
    if (!tableName || !columnName) {
      return {
        success: false,
        rowsAffected: 0,
        auditEntryId: null,
        hasRowDetails: false,
        error: 'No table or column selected',
      }
    }

    const mappings = getSelectedMappings()

    if (mappings.length === 0) {
      return {
        success: false,
        rowsAffected: 0,
        auditEntryId: null,
        hasRowDetails: false,
        error: 'No values selected for standardization',
      }
    }

    try {
      const auditEntryId = generateId()
      const result = await applyStandardization(
        tableName,
        columnName,
        mappings,
        auditEntryId
      )

      return {
        success: true,
        rowsAffected: result.rowsAffected,
        auditEntryId,
        hasRowDetails: result.hasRowDetails,
      }
    } catch (error) {
      console.error('Apply standardization failed:', error)
      return {
        success: false,
        rowsAffected: 0,
        auditEntryId: null,
        hasRowDetails: false,
        error: error instanceof Error ? error.message : 'Apply failed',
      }
    }
  }, [tableName, columnName, getSelectedMappings])

  return {
    startClustering,
    cancelClustering,
    applyChanges,
  }
}
