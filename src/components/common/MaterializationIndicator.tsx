import { Loader2 } from 'lucide-react'
import { useTableStore } from '@/stores/tableStore'

export function MaterializationIndicator() {
  const materializingTables = useTableStore((s) => s.materializingTables)
  const tables = useTableStore((s) => s.tables)

  if (materializingTables.size === 0) return null

  const tableIds = Array.from(materializingTables)
  const label =
    tableIds.length === 1
      ? `Loading ${tables.find((t) => t.id === tableIds[0])?.name ?? 'table'}...`
      : `Loading ${tableIds.length} tables...`

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-blue-500 dark:text-blue-400"
      data-testid="materialization-indicator"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      <span>{label}</span>
    </div>
  )
}
