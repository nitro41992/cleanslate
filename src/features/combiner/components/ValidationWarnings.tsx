import { AlertTriangle } from 'lucide-react'

interface ValidationWarningsProps {
  warnings: string[]
}

export function ValidationWarnings({ warnings }: ValidationWarningsProps) {
  if (warnings.length === 0) return null

  return (
    <div className="flex gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-800 dark:text-yellow-200">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <ul className="list-disc list-inside space-y-1 text-sm">
        {warnings.map((warning, i) => (
          <li key={i}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}
