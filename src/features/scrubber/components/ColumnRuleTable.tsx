import type { ColumnInfo, ObfuscationMethod } from '@/types'

interface ColumnRuleTableProps {
  columns: ColumnInfo[]
  rules: { column: string; method: ObfuscationMethod }[]
}

export function ColumnRuleTable({ columns }: ColumnRuleTableProps) {
  // const { addRule, removeRule } = useScrubberStore()

  return (
    <div className="bg-red-500 text-white text-4xl p-10 font-bold border-4 border-black">
      HELLO WORLD - DEBUGGING
      <br />
      Columns: {columns?.length ?? 'undefined'}
      <br />
      First Column: {columns?.[0]?.name ?? 'none'}
    </div>
  )
}
