import { useState } from 'react'
import { Download, Play, Plus, Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileDropzone } from '@/components/common/FileDropzone'
import { DataGrid } from '@/components/grid/DataGrid'
import { AuditLogPanel } from '@/components/common/AuditLogPanel'
import { RecipePanel } from './components/RecipePanel'
import { TransformationPicker } from './components/TransformationPicker'
import { useTableStore } from '@/stores/tableStore'
import { useDuckDB } from '@/hooks/useDuckDB'
import type { TransformationStep } from '@/types'

export function LaundromaPage() {
  const { loadFile, isLoading, exportTable, isReady } = useDuckDB()
  const tables = useTableStore((s) => s.tables)
  const activeTableId = useTableStore((s) => s.activeTableId)
  const activeTable = tables.find((t) => t.id === activeTableId)

  const [recipe, setRecipe] = useState<TransformationStep[]>([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('data')

  const handleFileDrop = async (file: File) => {
    await loadFile(file)
    setRecipe([])
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
            <Button variant="outline" size="sm" onClick={handleExport}>
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
                        onClick={() => loadFile}
                        className="text-muted-foreground"
                      >
                        <Plus className="w-4 h-4 mr-1" />
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
    </div>
  )
}
