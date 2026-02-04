import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Layers, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'

interface EmptyStateLandingProps {
  onFileDrop: (file: File) => void
  isLoading?: boolean
  isReady?: boolean
}

export function EmptyStateLanding({
  onFileDrop,
  isLoading = false,
  isReady = true,
}: EmptyStateLandingProps) {
  const loadingMessage = useUIStore((s) => s.loadingMessage)
  const [isHoveringDropzone, setIsHoveringDropzone] = useState(false)

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
        <div className="flex flex-col items-center mb-12">
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

        {/* Dropzone - simple, no animations */}
        <div
          {...getRootProps()}
          data-testid="file-dropzone"
          onMouseEnter={() => setIsHoveringDropzone(true)}
          onMouseLeave={() => setIsHoveringDropzone(false)}
          className={cn(
            'w-full rounded-xl border-2 border-dashed p-8 cursor-pointer',
            isDragActive
              ? 'border-primary bg-primary/5'
              : 'border-border bg-muted/20 hover:bg-muted/40',
            isLoading && 'pointer-events-none opacity-60'
          )}
        >
          <input {...getInputProps()} data-testid="file-input" />

          <div className="flex flex-col items-center gap-4">
            <div
              className={cn(
                'w-12 h-12 rounded-full flex items-center justify-center',
                isDragActive ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
              )}
            >
              <Upload className="w-6 h-6" />
            </div>

            <div className="text-center">
              <p className="font-medium">
                {isDragActive
                  ? 'Drop your file here'
                  : isLoading
                    ? loadingMessage || 'Processing...'
                    : 'Drop a CSV file here'}
              </p>
              {!isLoading && (
                <p className="text-sm text-muted-foreground mt-1">
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
