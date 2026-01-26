import { useState, useRef, useEffect, useMemo } from 'react'
import { FileText } from 'lucide-react'
import { AppLayout } from '@/components/layout/AppLayout'
import { MobileBlocker } from '@/components/layout/MobileBlocker'
import { Toaster } from '@/components/ui/sonner'
import { FileDropzone } from '@/components/common/FileDropzone'
import { IngestionWizard } from '@/components/common/IngestionWizard'
import { DataGrid } from '@/components/grid/DataGrid'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Panels
import { CleanPanel } from '@/components/panels/CleanPanel'
import { CombinePanel } from '@/components/panels/CombinePanel'
import { ScrubPanel } from '@/components/panels/ScrubPanel'

// Full-screen overlay views
import { DiffView } from '@/components/diff'
import { MatchView } from '@/features/matcher'
import { StandardizeView } from '@/features/standardizer'

// Stores and hooks
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useAuditStore } from '@/stores/auditStore'
import { useDiffStore } from '@/stores/diffStore'
import { useMatcherStore } from '@/stores/matcherStore'
import { useStandardizerStore } from '@/stores/standardizerStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { usePersistence } from '@/hooks/usePersistence'
import { useBeforeUnload } from '@/hooks/useBeforeUnload'
import { useUnifiedUndo } from '@/hooks/useUnifiedUndo'
import { toast } from 'sonner'
import { reorderColumns } from '@/lib/commands/utils/column-ordering'

import type { CSVIngestionSettings } from '@/types'

function App() {
  const { loadFile, isLoading, isReady, duplicateTable } = useDuckDB()
  useBeforeUnload() // Ensure pending debounced flush completes before tab closes
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = tables.find((t) => t.id === activeTableId)
  const addTable = useTableStore((s) => s.addTable)

  // Compute display columns in correct order using columnOrder from tableStore
  const displayColumns = useMemo(() => {
    if (!activeTable?.columns) {
      return []
    }

    // If no columnOrder is set, use DuckDB order as-is (legacy/first load)
    if (!activeTable.columnOrder) {
      return activeTable.columns.map((c) => c.name)
    }

    // Reorder columns according to stored columnOrder
    const reordered = reorderColumns(activeTable.columns, activeTable.columnOrder)
    return reordered.map((c) => c.name)
  }, [activeTable?.columns, activeTable?.columnOrder, activeTable?.dataVersion])
  const setActiveTable = useTableStore((s) => s.setActiveTable)

  const activePanel = usePreviewStore((s) => s.activePanel)
  const setPreviewActiveTable = usePreviewStore((s) => s.setActiveTable)
  const clearPendingOperations = usePreviewStore((s) => s.clearPendingOperations)

  // Ingestion wizard state
  const [pendingFile, setPendingFile] = useState<{
    file: File
    buffer: ArrayBuffer
  } | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Persist dialog state
  const [showPersistDialog, setShowPersistDialog] = useState(false)
  const [persistTableName, setPersistTableName] = useState('')
  const [isPersisting, setIsPersisting] = useState(false)

  // Persistence - auto-hydrates on mount via Parquet files in OPFS
  const { isRestoring } = usePersistence()

  // Unified undo/redo hook - single entry point for all undo/redo operations
  const { undo, redo } = useUnifiedUndo(activeTableId ?? null)

  // Audit logging for table persistence operations
  const addAuditEntry = useAuditStore((s) => s.addEntry)

  // Diff view state
  const isDiffViewOpen = useDiffStore((s) => s.isViewOpen)
  const closeDiffView = useDiffStore((s) => s.closeView)

  // Match view state
  const isMatchViewOpen = useMatcherStore((s) => s.isViewOpen)
  const closeMatchView = useMatcherStore((s) => s.closeView)

  // Standardize view state
  const isStandardizeViewOpen = useStandardizerStore((s) => s.isViewOpen)
  const closeStandardizeView = useStandardizerStore((s) => s.closeView)

  // Sync table selection to preview store
  useEffect(() => {
    if (activeTableId && activeTable) {
      setPreviewActiveTable(activeTableId, activeTable.name)
    }
  }, [activeTableId, activeTable, setPreviewActiveTable])

  // Persistence hydration handled by usePersistence hook

  // Keyboard shortcuts for undo/redo - uses useUnifiedUndo hook
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo])

  // Listen for file upload trigger from header
  useEffect(() => {
    const handler = () => fileInputRef.current?.click()
    window.addEventListener('trigger-file-upload', handler)
    return () => window.removeEventListener('trigger-file-upload', handler)
  }, [])

  // Show loading screen while restoring data from OPFS
  // Note: hydrate() in usePersistence has finally { setIsRestoring(false) } as fail-safe
  // IMPORTANT: This must be AFTER all hooks to comply with Rules of Hooks
  if (isRestoring) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
          <p className="text-muted-foreground">Restoring your workspace...</p>
        </div>
      </div>
    )
  }

  const handleFileDrop = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()

    if (ext === 'csv') {
      // Read buffer immediately to avoid race condition (Mac Chrome issue)
      const buffer = await file.arrayBuffer()
      setPendingFile({ file, buffer })
      setShowWizard(true)
      return
    }

    await loadFile(file)
  }

  const handleWizardConfirm = async (settings: CSVIngestionSettings) => {
    if (pendingFile) {
      await loadFile(pendingFile.file, settings)
      setPendingFile(null)
    }
  }

  const handleWizardCancel = () => {
    setPendingFile(null)
    setShowWizard(false)
  }

  const handleNewTable = () => {
    fileInputRef.current?.click()
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileDrop(file)
      e.target.value = ''
    }
  }

  const handlePersist = () => {
    if (activeTable) {
      setPersistTableName(`${activeTable.name}_final`)
      setShowPersistDialog(true)
    }
  }

  const handleConfirmPersist = async () => {
    if (!persistTableName.trim()) {
      toast.error('Please enter a table name')
      return
    }

    if (!activeTable || !activeTableId) {
      toast.error('No active table selected')
      return
    }

    // Check if table name already exists
    const tableNameExists = tables.some(
      (t) => t.name.toLowerCase() === persistTableName.trim().toLowerCase()
    )
    if (tableNameExists) {
      toast.error('A table with this name already exists')
      return
    }

    setIsPersisting(true)
    try {
      // 1. Create new table as copy of current table
      const result = await duplicateTable(activeTable.name, persistTableName.trim())

      // 2. Convert columns to ColumnInfo format
      const columns = result.columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: true,
      }))

      // 3. Add to tableStore and get new table ID
      const newTableId = addTable(persistTableName.trim(), columns, result.rowCount)

      // 4. Add audit entry for the source table
      addAuditEntry(
        activeTableId,
        activeTable.name,
        'Table Persisted',
        `Saved as new table: ${persistTableName.trim()}`,
        'A'
      )

      // 5. Add audit entry for the new table
      addAuditEntry(
        newTableId,
        persistTableName.trim(),
        'Table Created',
        `Persisted from ${activeTable.name} (${result.rowCount} rows, ${result.columns.length} columns)`,
        'A'
      )

      // 6. Clear pending operations
      clearPendingOperations()

      // 7. Switch to new table
      setActiveTable(newTableId)

      toast.success('Table Persisted', {
        description: `Created new table: ${persistTableName}`,
      })
      setShowPersistDialog(false)
      setPersistTableName('')
    } catch (error) {
      console.error('Failed to persist table:', error)
      toast.error('Failed to persist table')
    } finally {
      setIsPersisting(false)
    }
  }

  // Get panel content based on active panel
  // Note: Diff and Match are handled as full-screen overlays, not side panels
  const getPanelContent = () => {
    switch (activePanel) {
      case 'clean':
        return <CleanPanel />
      case 'combine':
        return <CombinePanel />
      case 'scrub':
        return <ScrubPanel />
      case 'match':
        // Match is handled as full-screen overlay via MatchView
        return null
      case 'diff':
        // Diff is handled as full-screen overlay via DiffView
        return null
      default:
        return null
    }
  }

  return (
    <>
      <MobileBlocker />
      <AppLayout
        panelContent={getPanelContent()}
        onNewTable={handleNewTable}
        onPersist={handlePersist}
        isPersisting={isPersisting}
      >
        {/* Main Preview Area */}
        <div className="flex-1 flex flex-col min-h-0 p-4">
          {!activeTable ? (
            /* Empty State */
            <div className="flex-1 flex items-center justify-center">
              <div className="max-w-md w-full">
                <FileDropzone onFileDrop={handleFileDrop} isLoading={isLoading} />
                {!isReady && (
                  <p className="text-center text-sm text-muted-foreground mt-4">
                    Initializing data engine...
                  </p>
                )}
              </div>
            </div>
          ) : (
            /* Data Preview */
            <Card className="flex-1 flex flex-col overflow-hidden">
              <CardHeader className="py-3 shrink-0 border-b border-border/50">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <span>{activeTable.name}</span>
                  <span className="text-muted-foreground font-normal">
                    {activeTable.rowCount.toLocaleString()} rows
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 p-0 min-h-0 overflow-hidden relative">
                <div className="absolute inset-0">
                  <DataGrid
                    tableName={activeTable.name}
                    rowCount={activeTable.rowCount}
                    columns={displayColumns}
                    editable={true}
                    tableId={activeTable.id}
                    dataVersion={activeTable.dataVersion}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </AppLayout>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.json,.parquet,.xlsx,.xls"
        onChange={handleFileInputChange}
        className="hidden"
        data-testid="file-input"
      />

      {/* CSV Ingestion Wizard */}
      <IngestionWizard
        open={showWizard}
        onOpenChange={(open) => {
          setShowWizard(open)
          if (!open) handleWizardCancel()
        }}
        file={pendingFile?.file ?? null}
        preloadedBuffer={pendingFile?.buffer}
        onConfirm={handleWizardConfirm}
      />

      {/* Persist as Table Dialog */}
      <Dialog open={showPersistDialog} onOpenChange={setShowPersistDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Persist as Table</DialogTitle>
            <DialogDescription>
              Save all pending changes as a new table. This will create a permanent
              snapshot of your current data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="table-name">New Table Name</Label>
            <Input
              id="table-name"
              value={persistTableName}
              onChange={(e) => setPersistTableName(e.target.value)}
              placeholder="e.g., cleaned_customers"
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPersistDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmPersist} disabled={isPersisting}>
              {isPersisting ? 'Saving...' : 'Create Table'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diff View Full-Screen Overlay */}
      <DiffView open={isDiffViewOpen} onClose={closeDiffView} />

      {/* Match View Full-Screen Overlay */}
      <MatchView open={isMatchViewOpen} onClose={closeMatchView} />

      {/* Standardize View Full-Screen Overlay */}
      <StandardizeView open={isStandardizeViewOpen} onClose={closeStandardizeView} />

      {/* Sonner Toaster */}
      <Toaster />
    </>
  )
}

export default App
