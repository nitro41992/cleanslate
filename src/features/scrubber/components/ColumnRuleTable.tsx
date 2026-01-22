import { Trash2, Shield, ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useScrubberStore } from '@/stores/scrubberStore'
import { OBFUSCATION_METHODS } from '@/lib/obfuscation'
import type { ColumnInfo, ObfuscationMethod, ObfuscationRule } from '@/types'
import { cn } from '@/lib/utils'

interface ColumnRuleTableProps {
  columns: ColumnInfo[]
  rules: ObfuscationRule[]
}

export function ColumnRuleTable({ columns, rules }: ColumnRuleTableProps) {
  const { addRule, removeRule, updateRule } = useScrubberStore()

  const getMethodForColumn = (columnName: string): ObfuscationMethod | null => {
    const rule = rules.find((r) => r.column === columnName)
    return rule?.method || null
  }

  const handleMethodChange = (columnName: string, method: string) => {
    if (method === 'none') {
      removeRule(columnName)
    } else {
      const existingRule = rules.find((r) => r.column === columnName)
      if (existingRule) {
        updateRule(columnName, method as ObfuscationMethod)
      } else {
        addRule({ column: columnName, method: method as ObfuscationMethod })
      }
    }
  }

  const handleAddAllSensitive = () => {
    // Auto-detect potentially sensitive columns by name
    const sensitivePatterns = [
      /name/i, /email/i, /phone/i, /address/i, /ssn/i, /social/i,
      /birth/i, /dob/i, /salary/i, /income/i, /password/i, /credit/i,
      /card/i, /account/i, /secret/i, /token/i
    ]

    columns.forEach((col) => {
      const isSensitive = sensitivePatterns.some((pattern) => pattern.test(col.name))
      const hasRule = rules.some((r) => r.column === col.name)

      if (isSensitive && !hasRule) {
        // Auto-select method based on column name
        let method: ObfuscationMethod = 'redact'
        if (/email/i.test(col.name)) method = 'faker'
        else if (/phone|ssn|account|card|credit/i.test(col.name)) method = 'mask'
        else if (/name/i.test(col.name)) method = 'faker'
        else if (/birth|dob|date/i.test(col.name)) method = 'year_only'
        else if (/salary|income|amount|price/i.test(col.name)) method = 'jitter'

        addRule({ column: col.name, method })
      }
    })
  }

  const handleClearAll = () => {
    rules.forEach((rule) => removeRule(rule.column))
  }

  const getMethodInfo = (method: ObfuscationMethod | null) => {
    if (!method) return null
    return OBFUSCATION_METHODS.find((m) => m.id === method)
  }

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'string':
        return 'bg-blue-500/20 text-blue-400 border-blue-500/30'
      case 'number':
        return 'bg-green-500/20 text-green-400 border-green-500/30'
      case 'date':
        return 'bg-purple-500/20 text-purple-400 border-purple-500/30'
      default:
        return 'bg-muted text-muted-foreground'
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header Actions */}
      <div className="flex items-center justify-between pb-3 border-b border-border/50">
        <div className="text-sm text-muted-foreground">
          {rules.length} of {columns.length} columns configured
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddAllSensitive}
            disabled={columns.length === 0}
          >
            <Shield className="w-3.5 h-3.5 mr-1.5" />
            Auto-detect
          </Button>
          {rules.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearAll}
              className="text-muted-foreground hover:text-destructive"
            >
              <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
              Clear all
            </Button>
          )}
        </div>
      </div>

      {/* Column List */}
      <ScrollArea className="flex-1 -mx-4 px-4 pt-3">
        <div className="space-y-2 pb-4">
          {columns.map((column) => {
            const method = getMethodForColumn(column.name)
            const methodInfo = getMethodInfo(method)
            const hasRule = method !== null

            return (
              <div
                key={column.name}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border transition-colors',
                  hasRule
                    ? 'bg-primary/5 border-primary/20'
                    : 'bg-muted/30 border-border/50 hover:bg-muted/50'
                )}
              >
                {/* Column Name & Type */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{column.name}</span>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {column.type}
                    </Badge>
                  </div>
                  {methodInfo && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {methodInfo.description}
                    </p>
                  )}
                </div>

                {/* Method Selector */}
                <div className="w-44 shrink-0">
                  <Select
                    value={method || 'none'}
                    onValueChange={(value) => handleMethodChange(column.name, value)}
                  >
                    <SelectTrigger
                      className={cn('h-9', hasRule && 'border-primary/30')}
                      data-testid={`method-select-${column.name}`}
                    >
                      <SelectValue placeholder="No obfuscation" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        <span className="text-muted-foreground">No obfuscation</span>
                      </SelectItem>
                      {/* String Methods */}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        String Methods
                      </div>
                      {OBFUSCATION_METHODS.filter((m) => m.category === 'string').map(
                        (m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className={cn('text-[10px] px-1', getCategoryColor('string'))}
                              >
                                S
                              </Badge>
                              {m.label}
                            </div>
                          </SelectItem>
                        )
                      )}
                      {/* Number Methods */}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground mt-1">
                        Number Methods
                      </div>
                      {OBFUSCATION_METHODS.filter((m) => m.category === 'number').map(
                        (m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className={cn('text-[10px] px-1', getCategoryColor('number'))}
                              >
                                N
                              </Badge>
                              {m.label}
                            </div>
                          </SelectItem>
                        )
                      )}
                      {/* Date Methods */}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground mt-1">
                        Date Methods
                      </div>
                      {OBFUSCATION_METHODS.filter((m) => m.category === 'date').map(
                        (m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className={cn('text-[10px] px-1', getCategoryColor('date'))}
                              >
                                D
                              </Badge>
                              {m.label}
                            </div>
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {/* Remove Button */}
                {hasRule && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRule(column.name)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )
          })}

          {columns.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No columns available</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Summary */}
      {rules.length > 0 && (
        <div className="pt-3 border-t border-border/50">
          <div className="flex flex-wrap gap-2">
            {rules.map((rule) => {
              const methodInfo = getMethodInfo(rule.method)
              return (
                <Badge
                  key={rule.column}
                  variant="secondary"
                  className="flex items-center gap-1.5 pr-1"
                >
                  <span className="truncate max-w-24">{rule.column}</span>
                  <span className="text-primary">:</span>
                  <span className="text-xs text-muted-foreground">
                    {methodInfo?.label}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 hover:bg-destructive/20 ml-1"
                    onClick={() => removeRule(rule.column)}
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </Button>
                </Badge>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
