import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Layers, Upload, Table, ChevronRight, Snowflake } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'

interface ExistingTable {
  id: string
  name: string
  rowCount: number
  isFrozen?: boolean
  isCheckpoint?: boolean
}

interface EmptyStateLandingProps {
  onFileDrop: (file: File) => void
  isLoading?: boolean
  isReady?: boolean
  existingTables?: ExistingTable[]
  onSelectTable?: (tableId: string) => void
}

export function EmptyStateLanding({
  onFileDrop,
  isLoading = false,
  isReady = true,
  existingTables = [],
  onSelectTable,
}: EmptyStateLandingProps) {
  const loadingMessage = useUIStore((s) => s.loadingMessage)
  const [isHoveringDropzone, setIsHoveringDropzone] = useState(false)

  const hasExistingTables = existingTables.length > 0

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onFileDrop(acceptedFiles[0])
      }
    },
    [onFileDrop]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
    },
    maxFiles: 1,
    disabled: isLoading,
  })

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center relative overflow-hidden">
      {/* Subtle gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/[0.02] via-transparent to-primary/[0.03]" />

      {/* Subtle grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.015]"
        style={{
          backgroundImage: `
            linear-gradient(to right, currentColor 1px, transparent 1px),
            linear-gradient(to bottom, currentColor 1px, transparent 1px)
          `,
          backgroundSize: '64px 64px',
        }}
      />

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center max-w-lg w-full px-6">
        {/* Logo section */}
        <div className="flex flex-col items-center mb-10">
          {/* Logo mark with subtle glow */}
          <div className="relative mb-5">
            <div
              className={cn(
                "absolute inset-0 bg-primary/20 blur-2xl rounded-full transition-all duration-700",
                (isDragActive || isHoveringDropzone) && "bg-primary/30 blur-3xl scale-150"
              )}
            />
            <div
              className={cn(
                "relative w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-lg transition-all duration-300",
                (isDragActive || isHoveringDropzone) && "scale-110 shadow-xl shadow-primary/25"
              )}
            >
              <Layers className="w-8 h-8 text-primary-foreground" />
            </div>
          </div>

          {/* Wordmark */}
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            CleanSlate
          </h1>
          <p className="text-sm text-muted-foreground mt-2 text-center max-w-xs">
            Local-first data cleaning for regulated industries
          </p>
        </div>

        {/* Existing tables section */}
        {hasExistingTables && (
          <div className="w-full mb-6">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Open a table
            </p>
            <div className="space-y-1.5">
              {existingTables.map((table) => (
                <button
                  key={table.id}
                  onClick={() => onSelectTable?.(table.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 rounded-lg',
                    'border border-border/60 bg-card/50',
                    'hover:bg-accent hover:border-border',
                    'transition-colors duration-150 cursor-pointer',
                    'group text-left'
                  )}
                >
                  {table.isFrozen ? (
                    <Snowflake className="w-4 h-4 shrink-0 text-blue-400" />
                  ) : (
                    <Table className="w-4 h-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {table.name}
                      {table.isCheckpoint && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">(checkpoint)</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatNumber(table.rowCount)} rows
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                </button>
              ))}
            </div>

            {/* Divider with "or" */}
            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 h-px bg-border/60" />
              <span className="text-xs text-muted-foreground/60">or import new data</span>
              <div className="flex-1 h-px bg-border/60" />
            </div>
          </div>
        )}

        {/* Dropzone */}
        <div
          {...getRootProps()}
          data-testid="file-dropzone"
          onMouseEnter={() => setIsHoveringDropzone(true)}
          onMouseLeave={() => setIsHoveringDropzone(false)}
          className={cn(
            'w-full rounded-xl border-2 border-dashed cursor-pointer',
            hasExistingTables ? 'p-5' : 'p-8',
            isDragActive
              ? 'border-primary bg-primary/5'
              : 'border-border bg-muted/20 hover:bg-muted/40',
            isLoading && 'pointer-events-none opacity-60'
          )}
        >
          <input {...getInputProps()} data-testid="file-input" />

          <div className={cn(
            'flex items-center gap-4',
            hasExistingTables ? 'flex-row' : 'flex-col'
          )}>
            <div
              className={cn(
                'rounded-full flex items-center justify-center shrink-0',
                hasExistingTables ? 'w-10 h-10' : 'w-12 h-12',
                isDragActive ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
              )}
            >
              <Upload className={hasExistingTables ? 'w-5 h-5' : 'w-6 h-6'} />
            </div>

            <div className={cn(hasExistingTables ? 'text-left' : 'text-center')}>
              <p className={cn('font-medium', hasExistingTables && 'text-sm')}>
                {isDragActive
                  ? 'Drop your file here'
                  : isLoading
                    ? loadingMessage || 'Processing...'
                    : 'Drop a CSV file here'}
              </p>
              {!isLoading && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  or click to browse
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Engine status */}
        {!isReady && (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span>Initializing data engine...</span>
          </div>
        )}

        {/* Privacy note */}
        <p className="mt-8 text-xs text-muted-foreground/50 text-center">
          All processing happens locally in your browser
        </p>
      </div>
    </div>
  )
}
