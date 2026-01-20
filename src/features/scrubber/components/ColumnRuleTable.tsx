import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { useScrubberStore } from '@/stores/scrubberStore'
import { OBFUSCATION_METHODS } from '@/lib/obfuscation'
import type { ColumnInfo, ObfuscationMethod } from '@/types'
import { cn } from '@/lib/utils'

interface ColumnRuleTableProps {
  columns: ColumnInfo[]
  rules: { column: string; method: ObfuscationMethod }[]
}

export function ColumnRuleTable({ columns, rules }: ColumnRuleTableProps) {
  const { addRule, removeRule } = useScrubberStore()

  const getRuleForColumn = (columnName: string) => {
    return rules.find((r) => r.column === columnName)
  }

  const handleMethodChange = (column: string, method: string) => {
    if (method === 'none') {
      removeRule(column)
    } else {
      addRule({ column, method: method as ObfuscationMethod })
    }
  }

  return (
    <ScrollArea className="h-full -mx-6">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card z-10">
          <tr className="border-b border-border/50">
            <th className="text-left p-3 font-medium text-muted-foreground">
              Column
            </th>
            <th className="text-left p-3 font-medium text-muted-foreground">
              Type
            </th>
            <th className="text-left p-3 font-medium text-muted-foreground w-48">
              Obfuscation Method
            </th>
          </tr>
        </thead>
        <tbody>
          {columns.map((col) => {
            const rule = getRuleForColumn(col.name)
            return (
              <tr
                key={col.name}
                className={cn(
                  'border-b border-border/30 hover:bg-muted/30 transition-colors',
                  rule && 'bg-primary/5'
                )}
              >
                <td className="p-3 font-medium">
                  {col.name}
                  {rule && (
                    <Badge variant="secondary" className="ml-2 text-xs">
                      configured
                    </Badge>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">{col.type}</td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <Select
                      value={rule?.method || 'none'}
                      onValueChange={(v) => handleMethodChange(col.name, v)}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          <span className="text-muted-foreground">
                            No obfuscation
                          </span>
                        </SelectItem>
                        {OBFUSCATION_METHODS.map((method) => (
                          <SelectItem key={method.id} value={method.id}>
                            <div>
                              <span>{method.label}</span>
                              <span className="text-xs text-muted-foreground ml-2">
                                ({method.category})
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {rule && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => removeRule(col.name)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </ScrollArea>
  )
}
