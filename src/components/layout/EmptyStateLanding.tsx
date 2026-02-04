import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Layers, Upload, Sparkles } from 'lucide-react'
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
  const [isHovering, setIsHovering] = useState(false)

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
                (isDragActive || isHovering) && "bg-primary/30 blur-3xl scale-150"
              )}
            />
            <div
              className={cn(
                "relative w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-lg transition-all duration-300",
                (isDragActive || isHovering) && "scale-110 shadow-xl shadow-primary/25"
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

        {/* Dropzone */}
        <div
          {...getRootProps()}
          data-testid="file-dropzone"
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          className={cn(
            'w-full relative group cursor-pointer',
            isLoading && 'pointer-events-none'
          )}
        >
          <input {...getInputProps()} data-testid="file-input" />

          {/* Outer glow on active */}
          <div
            className={cn(
              "absolute -inset-1 bg-gradient-to-r from-primary/0 via-primary/10 to-primary/0 rounded-2xl opacity-0 blur-xl transition-all duration-500",
              isDragActive && "opacity-100"
            )}
          />

          {/* Main dropzone container */}
          <div
            className={cn(
              'relative rounded-2xl border-2 border-dashed transition-all duration-300',
              'bg-card/30 backdrop-blur-sm',
              isDragActive
                ? 'border-primary bg-primary/5 scale-[1.02]'
                : isHovering
                  ? 'border-muted-foreground/30 bg-card/50'
                  : 'border-border/50',
              isLoading && 'opacity-60'
            )}
          >
            <div className="flex flex-col items-center py-12 px-8">
              {/* Upload icon with animated ring */}
              <div className="relative mb-6">
                {/* Pulsing ring on drag */}
                {isDragActive && (
                  <div className="absolute inset-0 rounded-full border-2 border-primary animate-ping opacity-30" />
                )}
                <div
                  className={cn(
                    'w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300',
                    isDragActive
                      ? 'bg-primary/15 text-primary scale-110'
                      : 'bg-muted/50 text-muted-foreground group-hover:bg-muted group-hover:text-foreground'
                  )}
                >
                  <Upload className="w-6 h-6" />
                </div>
              </div>

              {/* Text */}
              <div className="text-center">
                <p className={cn(
                  'text-base font-medium transition-colors duration-200',
                  isDragActive ? 'text-primary' : 'text-foreground'
                )}>
                  {isDragActive
                    ? 'Drop your file here'
                    : isLoading
                      ? loadingMessage || 'Processing...'
                      : 'Drop a CSV file here'}
                </p>
                {!isLoading && (
                  <p className="text-sm text-muted-foreground mt-1.5">
                    or <span className="text-primary/80 hover:text-primary transition-colors">browse</span> to upload
                  </p>
                )}
              </div>

              {/* File type hint */}
              {!isLoading && (
                <div className={cn(
                  'mt-6 flex items-center gap-1.5 text-xs transition-colors duration-200',
                  isDragActive ? 'text-primary/70' : 'text-muted-foreground/60'
                )}>
                  <Sparkles className="w-3 h-3" />
                  <span>CSV files supported</span>
                </div>
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
