import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, Play, Plus, Sparkles, Upload, Undo2, Redo2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileDropzone } from '@/components/common/FileDropzone'
import { DataGrid } from '@/components/grid/DataGrid'
import { AuditLogPanel } from '@/components/common/AuditLogPanel'
import { RecipePanel } from './components/RecipePanel'
import { TransformationPicker } from './components/TransformationPicker'
import { IngestionWizard } from '@/components/common/IngestionWizard'
import { useTableStore } from '@/stores/tableStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import { useEditStore } from '@/stores/editStore'
import { useAuditStore } from '@/stores/auditStore'
import type { TransformationStep, CSVIngestionSettings } from '@/types'

export function LaundromaPage() {
  const { loadFile, isLoading, exportTable, isReady, updateCell } = useDuckDB()
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const [recipe, setRecipe] = useState<TransformationStep[]>([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('data')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Ingestion wizard state
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [showWizard, setShowWizard] = useState(false)

  // Edit store for undo/redo
  const undo = useEditStore((s) => s.undo)
  const redo = useEditStore((s) => s.redo)
  const canUndo = useEditStore((s) => s.canUndo)
  const canRedo = useEditStore((s) => s.canRedo)

  // Force re-render on undo/redo stack changes for button state
  const undoStackLength = useEditStore((s) => s.undoStack.length)
  const redoStackLength = useEditStore((s) => s.redoStack.length)

  // Audit store for logging undo/redo
  const addAuditEntry = useAuditStore((s) => s.addEntry)

  // Handle undo action
  const handleUndo = useCallback(async () => {
    const edit = undo()
    if (edit && activeTable) {
      // Revert the cell value in DuckDB
      await updateCell(edit.tableName, edit.rowIndex, edit.columnName, edit.previousValue)

      // Log undo action to audit
      addAuditEntry(
        edit.tableId,
        edit.tableName,
        'Undo Edit',
        `Reverted cell [${edit.rowIndex}, ${edit.columnName}] from "${edit.newValue}" to "${edit.previousValue}"`,
        'B'
      )
    }
  }, [undo, activeTable, updateCell, addAuditEntry])

  // Handle redo action
  const handleRedo = useCallback(async () => {
    const edit = redo()
    if (edit && activeTable) {
      // Re-apply the cell value in DuckDB
      await updateCell(edit.tableName, edit.rowIndex, edit.columnName, edit.newValue)

      // Log redo action to audit
      addAuditEntry(
        edit.tableId,
        edit.tableName,
        'Redo Edit',
        `Re-applied cell [${edit.rowIndex}, ${edit.columnName}] from "${edit.previousValue}" to "${edit.newValue}"`,
        'B'
      )
    }
  }, [redo, activeTable, updateCell, addAuditEntry])

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Z for undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      }
      // Ctrl+Y or Ctrl+Shift+Z for redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        handleRedo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleUndo, handleRedo])

  const handleAddFileClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileDrop(file)
      // Reset the input so the same file can be selected again
      e.target.value = ''
    }
  }

  const handleFileDrop = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()

    // Show wizard for CSV files
    if (ext === 'csv') {
      setPendingFile(file)
      setShowWizard(true)
      return
    }

    // Load other file types directly
    await loadFile(file)
    setRecipe([])
  }

  const handleWizardConfirm = async (settings: CSVIngestionSettings) => {
    if (pendingFile) {
      await loadFile(pendingFile, settings)
      setPendingFile(null)
      setRecipe([])
    }
  }

  const handleWizardCancel = () => {
    setPendingFile(null)
    setShowWizard(false)
  }

  const handleAddStep = (step: TransformationStep) => {
    setRecipe([...recipe, step])
    setIsPickerOpen(false)
  }

  const handleRemoveStep = (index: number) => {
    setRecipe(recipe.filter((_, i) => i !== index))
  }

  const handleExport = () => {
    if (activeTable) {
      exportTable(activeTable.name, `${activeTable.name}_cleaned.csv`)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-6 border-b border-border/50 bg-card/30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-semibold">Data Laundromat</h1>
            <p className="text-xs text-muted-foreground">
              Clean and transform your data
            </p>
          </div>
        </div>

        {activeTable && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleUndo}
              disabled={!canUndo() || undoStackLength === 0}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRedo}
              disabled={!canRedo() || redoStackLength === 0}
              title="Redo (Ctrl+Y)"
            >
              <Redo2 className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} data-testid="export-csv-btn">
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0">
        {/* Left Panel - Data View */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border/50">
          {!activeTable ? (
            <div className="flex-1 flex items-center justify-center p-8">
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
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="flex-1 flex flex-col"
            >
              <div className="px-4 pt-4">
                <TabsList className="grid w-full max-w-xs grid-cols-2">
                  <TabsTrigger value="data">Data Preview</TabsTrigger>
                  <TabsTrigger value="audit">Audit Log</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="data" className="flex-1 m-0 p-4 min-h-0">
                <Card className="h-full flex flex-col overflow-hidden">
                  <CardHeader className="py-3 shrink-0">
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>
                        {activeTable.name}
                        <span className="text-muted-foreground font-normal ml-2">
                          {activeTable.rowCount.toLocaleString()} rows
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleAddFileClick}
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
              </TabsContent>

              <TabsContent value="audit" className="flex-1 m-0 p-4">
                <Card className="h-full">
                  <AuditLogPanel tableId={activeTableId || undefined} />
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>

        {/* Right Panel - Recipe Builder */}
        <div className="w-80 flex flex-col bg-card/30">
          <div className="p-4 border-b border-border/50">
            <h2 className="font-semibold flex items-center gap-2">
              <Play className="w-4 h-4" />
              Recipe Builder
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Add transformations to clean your data
            </p>
          </div>

          <RecipePanel
            recipe={recipe}
            columns={activeTable?.columns.map((c) => c.name) || []}
            tableName={activeTable?.name || ''}
            tableId={activeTableId || ''}
            onRemoveStep={handleRemoveStep}
            onClearRecipe={() => setRecipe([])}
          />

          <div className="p-4 border-t border-border/50">
            <Button
              className="w-full"
              onClick={() => setIsPickerOpen(true)}
              disabled={!activeTable}
              data-testid="add-transformation-btn"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Transformation
            </Button>
          </div>
        </div>
      </div>

      {/* Transformation Picker Dialog */}
      <TransformationPicker
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        columns={activeTable?.columns.map((c) => c.name) || []}
        onSelect={handleAddStep}
      />

      {/* Hidden file input for "Add file" button */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.json,.parquet,.xlsx,.xls"
        onChange={handleFileInputChange}
        className="hidden"
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
    </div>
  )
}
