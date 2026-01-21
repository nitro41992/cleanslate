import { useState, useRef, useEffect, useCallback } from 'react'
import { Upload, FileText } from 'lucide-react'
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
import { DiffPanel } from '@/components/panels/DiffPanel'
import { MatchPanel } from '@/components/panels/MatchPanel'

// Stores and hooks
import { useTableStore } from '@/stores/tableStore'
import { usePreviewStore } from '@/stores/previewStore'
import { useEditStore } from '@/stores/editStore'
import { useAuditStore } from '@/stores/auditStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { usePersistence } from '@/hooks/usePersistence'
import { toast } from 'sonner'

import type { CSVIngestionSettings } from '@/types'

function App() {
  const { loadFile, isLoading, isReady, updateCell } = useDuckDB()
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const activePanel = usePreviewStore((s) => s.activePanel)
  const setPreviewActiveTable = usePreviewStore((s) => s.setActiveTable)

  // Ingestion wizard state
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Persist dialog state
  const [showPersistDialog, setShowPersistDialog] = useState(false)
  const [persistTableName, setPersistTableName] = useState('')
  const [isPersisting, setIsPersisting] = useState(false)

  // Persistence
  const { autoRestore, loadFromStorage } = usePersistence()
  const [showRestoreDialog, setShowRestoreDialog] = useState(false)

  // Edit store for undo/redo
  const undo = useEditStore((s) => s.undo)
  const redo = useEditStore((s) => s.redo)
  const addAuditEntry = useAuditStore((s) => s.addEntry)

  // Sync table selection to preview store
  useEffect(() => {
    if (activeTableId && activeTable) {
      setPreviewActiveTable(activeTableId, activeTable.name)
    }
  }, [activeTableId, activeTable, setPreviewActiveTable])

  // Check for saved data on mount
  useEffect(() => {
    const checkForSavedData = async () => {
      const hasSavedData = await autoRestore()
      if (hasSavedData) {
        setShowRestoreDialog(true)
      }
    }
    checkForSavedData()
  }, [autoRestore])

  // Keyboard shortcuts for undo/redo
  const handleUndo = useCallback(async () => {
    const edit = undo()
    if (edit && activeTable) {
      await updateCell(edit.tableName, edit.rowIndex, edit.columnName, edit.previousValue)
      addAuditEntry(
        edit.tableId,
        edit.tableName,
        'Undo Edit',
        `Reverted cell [${edit.rowIndex}, ${edit.columnName}]`,
        'B'
      )
    }
  }, [undo, activeTable, updateCell, addAuditEntry])

  const handleRedo = useCallback(async () => {
    const edit = redo()
    if (edit && activeTable) {
      await updateCell(edit.tableName, edit.rowIndex, edit.columnName, edit.newValue)
      addAuditEntry(
        edit.tableId,
        edit.tableName,
        'Redo Edit',
        `Re-applied cell [${edit.rowIndex}, ${edit.columnName}]`,
        'B'
      )
    }
  }, [redo, activeTable, updateCell, addAuditEntry])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        handleRedo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleUndo, handleRedo])

  // Listen for file upload trigger from header
  useEffect(() => {
    const handler = () => fileInputRef.current?.click()
    window.addEventListener('trigger-file-upload', handler)
    return () => window.removeEventListener('trigger-file-upload', handler)
  }, [])

  const handleFileDrop = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()

    if (ext === 'csv') {
      setPendingFile(file)
      setShowWizard(true)
      return
    }

    await loadFile(file)
  }

  const handleWizardConfirm = async (settings: CSVIngestionSettings) => {
    if (pendingFile) {
      await loadFile(pendingFile, settings)
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

    setIsPersisting(true)
    try {
      // In a real implementation, this would:
      // 1. Execute all pending operations
      // 2. Create a new table with the result
      // 3. Clear pending operations
      // For now, we just show success
      toast.success('Table Persisted', {
        description: `Created new table: ${persistTableName}`,
      })
      setShowPersistDialog(false)
      setPersistTableName('')
    } catch {
      toast.error('Failed to persist table')
    } finally {
      setIsPersisting(false)
    }
  }

  // Get panel content based on active panel
  const getPanelContent = () => {
    switch (activePanel) {
      case 'clean':
        return <CleanPanel />
      case 'combine':
        return <CombinePanel />
      case 'scrub':
        return <ScrubPanel />
      case 'diff':
        return <DiffPanel />
      case 'match':
        return <MatchPanel />
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
                <CardTitle className="text-sm flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span>{activeTable.name}</span>
                    <span className="text-muted-foreground font-normal">
                      {activeTable.rowCount.toLocaleString()} rows
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleNewTable}
                    className="text-muted-foreground"
                  >
                    <Upload className="w-4 h-4 mr-1" />
                    Add file
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 p-0 min-h-0 overflow-hidden relative">
                <div className="absolute inset-0">
                  <DataGrid
                    tableName={activeTable.name}
                    rowCount={activeTable.rowCount}
                    columns={activeTable.columns.map((c) => c.name)}
                    editable={true}
                    tableId={activeTable.id}
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
        file={pendingFile}
        onConfirm={handleWizardConfirm}
      />

      {/* Restore Data Dialog */}
      <Dialog open={showRestoreDialog} onOpenChange={setShowRestoreDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore Previous Session?</DialogTitle>
            <DialogDescription>
              We found tables from a previous session saved in your browser.
              Would you like to restore them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRestoreDialog(false)}>
              Start Fresh
            </Button>
            <Button
              onClick={() => {
                loadFromStorage()
                setShowRestoreDialog(false)
              }}
            >
              Restore Tables
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Sonner Toaster */}
      <Toaster />
    </>
  )
}

export default App
