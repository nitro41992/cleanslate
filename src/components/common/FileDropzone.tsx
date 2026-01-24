import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, FileSpreadsheet } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FileDropzoneProps {
  onFileDrop: (file: File) => void
  isLoading?: boolean
  accept?: string[]
  className?: string
}

const fileIcons: Record<string, typeof FileSpreadsheet> = {
  csv: FileSpreadsheet,
}

export function FileDropzone({
  onFileDrop,
  isLoading = false,
  accept = ['.csv'],
  className,
}: FileDropzoneProps) {
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
    <div
      {...getRootProps()}
      data-testid="file-dropzone"
      className={cn(
        'dropzone',
        'flex flex-col items-center justify-center gap-4 p-8 min-h-[200px]',
        isDragActive && 'active',
        isLoading && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <input {...getInputProps()} data-testid="file-input" />

      <div
        className={cn(
          'w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-200',
          isDragActive
            ? 'bg-primary/20 scale-110'
            : 'bg-muted'
        )}
      >
        <Upload
          className={cn(
            'w-8 h-8 transition-colors',
            isDragActive ? 'text-primary' : 'text-muted-foreground'
          )}
        />
      </div>

      <div className="text-center">
        <p className="font-medium">
          {isDragActive
            ? 'Drop your CSV file here'
            : isLoading
            ? 'Processing file...'
            : 'Drag & drop a CSV file'}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          or click to browse
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {accept.map((ext) => {
          const Icon = fileIcons[ext.replace('.', '')] || FileSpreadsheet
          return (
            <span key={ext} className="flex items-center gap-1">
              <Icon className="w-3.5 h-3.5" />
              {ext.toUpperCase().replace('.', '')} files only
            </span>
          )
        })}
      </div>
    </div>
  )
}
