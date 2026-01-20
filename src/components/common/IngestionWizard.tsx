import { useState, useEffect, useMemo } from 'react'
import { FileText, Settings2 } from 'lucide-react'
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
  parseLine,
  getDelimiterLabel,
  type Delimiter,
  type FilePreviewResult,
} from '@/lib/fileUtils'
import type { CSVIngestionSettings } from '@/types'

interface IngestionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: File | null
  onConfirm: (settings: CSVIngestionSettings) => void
}

export function IngestionWizard({
  open,
  onOpenChange,
  file,
  onConfirm,
}: IngestionWizardProps) {
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Settings state
  const [headerRow, setHeaderRow] = useState(1)
  const [encoding, setEncoding] = useState<'auto' | 'utf-8' | 'latin-1'>('auto')
  const [delimiter, setDelimiter] = useState<'auto' | Delimiter>('auto')

  // Load file preview when file changes
  useEffect(() => {
    if (!file || !open) {
      setPreview(null)
      return
    }

    setIsLoading(true)
    readFilePreview(file, 50)
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
  }, [file, open])

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            CSV Import Settings
          </DialogTitle>
          <DialogDescription>
            Configure how to parse {file?.name || 'your CSV file'}
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
                  onValueChange={(v) => setEncoding(v as 'auto' | 'utf-8' | 'latin-1')}
                >
                  <SelectTrigger id="encoding" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      Auto ({preview?.encoding || 'detecting...'})
                    </SelectItem>
                    <SelectItem value="utf-8">UTF-8</SelectItem>
                    <SelectItem value="latin-1">Latin-1 (ISO-8859-1)</SelectItem>
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

            {/* Detected Columns */}
            {headerColumns.length > 0 && (
              <div className="rounded-lg border border-border/50 p-3 bg-muted/30">
                <div className="flex items-center gap-2 mb-2">
                  <Settings2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    Detected {headerColumns.length} columns from row {headerRow}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {headerColumns.slice(0, 15).map((col, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 text-xs rounded bg-primary/10 text-primary"
                    >
                      {col || `(empty)`}
                    </span>
                  ))}
                  {headerColumns.length > 15 && (
                    <span className="px-2 py-0.5 text-xs text-muted-foreground">
                      +{headerColumns.length - 15} more
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Raw Preview */}
            <div className="flex-1 min-h-0 flex flex-col">
              <Label className="text-xs text-muted-foreground mb-2">
                Raw File Preview (first {preview?.lines.length || 0} lines)
              </Label>
              <ScrollArea className="flex-1 rounded-lg border border-border/50 bg-background">
                <div className="p-3 font-mono text-xs">
                  {preview?.lines.map((line, i) => {
                    const lineNum = i + 1
                    const isHeader = lineNum === headerRow
                    return (
                      <div
                        key={i}
                        className={`flex hover:bg-muted/50 ${
                          isHeader ? 'bg-primary/10 font-semibold' : ''
                        }`}
                      >
                        <span className="w-8 text-right pr-3 text-muted-foreground select-none shrink-0">
                          {lineNum}
                        </span>
                        <span className={`whitespace-pre overflow-hidden text-ellipsis ${
                          isHeader ? 'text-primary' : ''
                        }`}>
                          {line || ' '}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isLoading || !preview}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
