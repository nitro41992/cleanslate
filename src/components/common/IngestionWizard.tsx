import { useState, useEffect, useMemo } from 'react'
import { FileText, Settings2 } from 'lucide-react'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  readFilePreview,
  readFilePreviewFromBuffer,
  parseLine,
  getDelimiterLabel,
  type Delimiter,
  type FilePreviewResult,
} from '@/lib/fileUtils'
import type { CSVIngestionSettings } from '@/types'
import { useUIStore } from '@/stores/uiStore'

// Rainbow color palettes — dark uses bright/saturated, light uses deeper shades
const darkRainbowColors = [
  'rgb(255, 71, 87)',   // Coral Red
  'rgb(255, 168, 0)',   // Orange
  'rgb(255, 214, 0)',   // Gold
  'rgb(163, 255, 0)',   // Lime
  'rgb(0, 255, 163)',   // Mint
  'rgb(0, 214, 255)',   // Cyan
  'rgb(0, 168, 255)',   // Sky Blue
  'rgb(71, 87, 255)',   // Blue
  'rgb(163, 0, 255)',   // Purple
  'rgb(255, 0, 214)',   // Magenta
  'rgb(255, 0, 87)',    // Hot Pink
  'rgb(255, 102, 0)',   // Tangerine
]

const lightRainbowColors = [
  'rgb(200, 30, 45)',   // Coral Red
  'rgb(190, 120, 0)',   // Orange
  'rgb(160, 135, 0)',   // Gold
  'rgb(80, 140, 0)',    // Lime
  'rgb(0, 140, 90)',    // Mint
  'rgb(0, 140, 170)',   // Cyan
  'rgb(0, 110, 190)',   // Sky Blue
  'rgb(50, 60, 200)',   // Blue
  'rgb(120, 0, 200)',   // Purple
  'rgb(185, 0, 155)',   // Magenta
  'rgb(200, 0, 60)',    // Hot Pink
  'rgb(195, 75, 0)',    // Tangerine
]

interface IngestionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: File | null
  preloadedBuffer?: ArrayBuffer
  onConfirm: (settings: CSVIngestionSettings) => void
}

export function IngestionWizard({
  open,
  onOpenChange,
  file,
  preloadedBuffer,
  onConfirm,
}: IngestionWizardProps) {
  const themeMode = useUIStore((s) => s.themeMode)
  const rainbowColors = themeMode === 'dark' ? darkRainbowColors : lightRainbowColors

  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Settings state
  const [headerRow, setHeaderRow] = useState(1)
  const [encoding, setEncoding] = useState<'auto' | 'utf-8' | 'iso-8859-1'>('auto')
  const [delimiter, setDelimiter] = useState<'auto' | Delimiter>('auto')

  // Load file preview when file changes
  useEffect(() => {
    if (!file || !open) {
      setPreview(null)
      return
    }

    setIsLoading(true)

    // Use preloaded buffer if available (avoids Mac Chrome race condition)
    const previewPromise = preloadedBuffer
      ? readFilePreviewFromBuffer(preloadedBuffer, 50)
      : readFilePreview(file, 50)

    previewPromise
      .then((result) => {
        setPreview(result)
        // Reset settings to detected values
        setHeaderRow(1)
        setEncoding('auto')
        setDelimiter('auto')
      })
      .catch((err) => {
        console.error('Error reading file preview:', err)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [file, open, preloadedBuffer])

  // Compute effective delimiter (auto resolves to detected)
  const effectiveDelimiter = useMemo(() => {
    if (delimiter !== 'auto') return delimiter
    return preview?.detectedDelimiter || ','
  }, [delimiter, preview])

  // Compute effective encoding
  const effectiveEncoding = useMemo(() => {
    if (encoding !== 'auto') return encoding
    return preview?.encoding || 'utf-8'
  }, [encoding, preview])

  // Parse header row to show column names
  const headerColumns = useMemo(() => {
    if (!preview || preview.lines.length < headerRow) return []
    const line = preview.lines[headerRow - 1]
    return parseLine(line, effectiveDelimiter)
  }, [preview, headerRow, effectiveDelimiter])

  const handleConfirm = () => {
    const settings: CSVIngestionSettings = {
      headerRow,
      encoding: effectiveEncoding,
      delimiter: effectiveDelimiter,
    }
    onConfirm(settings)
    onOpenChange(false)
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  // Render a line with rainbow-colored columns (VS Code style)
  const renderRainbowLine = (line: string, isHeader: boolean) => {
    const fields = parseLine(line, effectiveDelimiter)

    return (
      <span className="inline-flex items-baseline whitespace-nowrap">
        {fields.map((field, idx) => {
          const color = rainbowColors[idx % rainbowColors.length]
          const isLast = idx === fields.length - 1
          return (
            <span key={idx} className="inline-flex items-baseline">
              <span
                style={{
                  color,
                  fontWeight: isHeader ? 600 : 400,
                }}
              >
                {field || '(empty)'}
              </span>
              {!isLast && (
                <span className="text-muted-foreground/30 mx-1">
                  {effectiveDelimiter === '\t' ? '→' : effectiveDelimiter}
                </span>
              )}
            </span>
          )
        })}
      </span>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] max-h-[90vh] w-full h-full flex flex-col"
        data-testid="ingestion-wizard"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-2xl">
            <div className="p-2 rounded-lg bg-primary/10">
              <FileText className="w-6 h-6 text-primary" />
            </div>
            <span className="bg-gradient-to-r from-primary via-primary/80 to-primary bg-clip-text text-transparent">
              Data Inspection Terminal
            </span>
          </DialogTitle>
          <DialogDescription className="text-base mt-2">
            Configure how to parse <span className="font-semibold text-foreground">{file?.name || 'your CSV file'}</span>
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading preview...</div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-4">
            {/* Settings Row */}
            <div className="flex gap-4 items-end">
              <div className="flex-1">
                <Label htmlFor="header-row" className="text-xs text-muted-foreground">
                  Header Row
                </Label>
                <Select
                  value={String(headerRow)}
                  onValueChange={(v) => setHeaderRow(Number(v))}
                >
                  <SelectTrigger id="header-row" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((row) => (
                      <SelectItem key={row} value={String(row)}>
                        Row {row}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label htmlFor="encoding" className="text-xs text-muted-foreground">
                  Encoding
                </Label>
                <Select
                  value={encoding}
                  onValueChange={(v) => setEncoding(v as 'auto' | 'utf-8' | 'iso-8859-1')}
                >
                  <SelectTrigger id="encoding" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      Auto ({preview?.encoding || 'detecting...'})
                    </SelectItem>
                    <SelectItem value="utf-8">UTF-8</SelectItem>
                    <SelectItem value="iso-8859-1">Latin-1 (ISO-8859-1)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label htmlFor="delimiter" className="text-xs text-muted-foreground">
                  Delimiter
                </Label>
                <Select
                  value={delimiter}
                  onValueChange={(v) => setDelimiter(v as 'auto' | Delimiter)}
                >
                  <SelectTrigger id="delimiter" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      Auto ({preview ? getDelimiterLabel(preview.detectedDelimiter) : 'detecting...'})
                    </SelectItem>
                    <SelectItem value=",">Comma</SelectItem>
                    <SelectItem value="	">Tab</SelectItem>
                    <SelectItem value="|">Pipe</SelectItem>
                    <SelectItem value=";">Semicolon</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Detected Columns with Rainbow Colors */}
            {headerColumns.length > 0 && (
              <div className="rounded-xl border border-border/50 p-4 bg-muted/30">
                <div className="flex items-center gap-2 mb-3">
                  <Settings2 className="w-5 h-5 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    Detected {headerColumns.length} columns from row {headerRow}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                  {headerColumns.slice(0, 20).map((col, i) => {
                    const color = rainbowColors[i % rainbowColors.length]
                    return (
                      <span
                        key={i}
                        style={{
                          backgroundColor: `${color}20`,
                          color: color,
                          border: `1px solid ${color}40`,
                          animationDelay: `${i * 30}ms`
                        }}
                        className="px-3 py-1.5 text-sm rounded-lg font-medium animate-in truncate max-w-[200px]"
                        title={col || '(empty)'}
                      >
                        {col || `(empty)`}
                      </span>
                    )
                  })}
                  {headerColumns.length > 20 && (
                    <span className="px-3 py-1.5 text-sm text-muted-foreground">
                      +{headerColumns.length - 20} more
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Raw Preview with Rainbow Columns */}
            <div className="flex-1 min-h-0 flex flex-col">
              <Label className="text-sm font-medium text-foreground mb-3">
                Data Canvas <span className="text-muted-foreground font-normal">(first {preview?.lines.length || 0} lines)</span>
              </Label>
              <ScrollArea className="flex-1 rounded-xl border-2 border-border/50 bg-background" data-testid="raw-preview">
                <div className="p-4" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                  {preview?.lines.map((line, i) => {
                    const lineNum = i + 1
                    const isHeader = lineNum === headerRow
                    return (
                      <div
                        key={i}
                        className={`flex py-2 hover:bg-muted/30 transition-colors ${
                          isHeader ? 'bg-primary/5 border-l-2 border-primary' : ''
                        }`}
                      >
                        <span className="w-12 text-right pr-4 text-muted-foreground select-none shrink-0 text-xs">
                          {lineNum}
                        </span>
                        <div className="flex-1 text-sm leading-relaxed overflow-x-auto">
                          {renderRainbowLine(line, isHeader)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>
        )}

        <DialogFooter className="mt-6 gap-3">
          <Button
            variant="outline"
            onClick={handleCancel}
            data-testid="cancel-btn"
            className="px-6"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isLoading || !preview}
            data-testid="import-btn"
            className="px-8 bg-primary hover:bg-primary/90"
          >
            Import CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
