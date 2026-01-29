import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  TRANSFORMATIONS,
  TRANSFORMATION_GROUPS,
  TransformationDefinition,
  TransformationGroupColor,
} from '@/lib/transformations'

interface GroupedTransformationPickerProps {
  selectedTransform: TransformationDefinition | null
  lastApplied: string | null
  disabled: boolean
  onSelect: (transform: TransformationDefinition) => void
}

const colorClasses: Record<TransformationGroupColor, {
  badge: string
  header: string
  headerHover: string
  selected: string
  iconBg: string
}> = {
  emerald: {
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    header: 'text-emerald-400',
    headerHover: 'hover:bg-emerald-500/5',
    selected: 'border-l-2 border-emerald-500 bg-emerald-500/5',
    iconBg: 'bg-emerald-500/10',
  },
  blue: {
    badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    header: 'text-blue-400',
    headerHover: 'hover:bg-blue-500/5',
    selected: 'border-l-2 border-blue-500 bg-blue-500/5',
    iconBg: 'bg-blue-500/10',
  },
  violet: {
    badge: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    header: 'text-violet-400',
    headerHover: 'hover:bg-violet-500/5',
    selected: 'border-l-2 border-violet-500 bg-violet-500/5',
    iconBg: 'bg-violet-500/10',
  },
  amber: {
    badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    header: 'text-amber-400',
    headerHover: 'hover:bg-amber-500/5',
    selected: 'border-l-2 border-amber-500 bg-amber-500/5',
    iconBg: 'bg-amber-500/10',
  },
  rose: {
    badge: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    header: 'text-rose-400',
    headerHover: 'hover:bg-rose-500/5',
    selected: 'border-l-2 border-rose-500 bg-rose-500/5',
    iconBg: 'bg-rose-500/10',
  },
  slate: {
    badge: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    header: 'text-slate-400',
    headerHover: 'hover:bg-slate-500/5',
    selected: 'border-l-2 border-slate-500 bg-slate-500/5',
    iconBg: 'bg-slate-500/10',
  },
}

export function GroupedTransformationPicker({
  selectedTransform,
  lastApplied,
  disabled,
  onSelect,
}: GroupedTransformationPickerProps) {
  // Start with all groups expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(TRANSFORMATION_GROUPS.map(g => g.id))
  )

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  const getTransformDef = (id: string): TransformationDefinition | undefined => {
    return TRANSFORMATIONS.find(t => t.id === id)
  }

  return (
    <div className="space-y-2">
      {TRANSFORMATION_GROUPS.map(group => {
        const isExpanded = expandedGroups.has(group.id)
        const colors = colorClasses[group.color]
        const groupTransforms = group.transforms
          .map(id => getTransformDef(id))
          .filter((t): t is TransformationDefinition => t !== undefined)

        return (
          <div
            key={group.id}
            className="rounded-lg border border-border/50 overflow-hidden"
          >
            {/* Group Header */}
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className={cn(
                'w-full flex items-center justify-between px-3 py-2.5 transition-colors',
                'bg-muted/30',
                colors.headerHover
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('text-base', colors.header)}>
                  {group.icon}
                </span>
                <span className={cn('text-sm font-semibold tracking-tight', colors.header)}>
                  {group.label}
                </span>
                <span
                  className={cn(
                    'text-xs px-1.5 py-0.5 rounded-full border',
                    colors.badge
                  )}
                >
                  {groupTransforms.length}
                </span>
              </div>
              <ChevronDown
                className={cn(
                  'w-4 h-4 text-muted-foreground transition-transform duration-200',
                  isExpanded && 'rotate-180'
                )}
              />
            </button>

            {/* Group Content */}
            <div
              className={cn(
                'grid transition-all duration-200 ease-in-out',
                isExpanded
                  ? 'grid-rows-[1fr] opacity-100'
                  : 'grid-rows-[0fr] opacity-0'
              )}
            >
              <div className="overflow-hidden">
                <div className="space-y-0.5 p-2">
                  {groupTransforms.map(t => (
                    <button
                      key={t.id}
                      onClick={() => onSelect(t)}
                      disabled={disabled}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2 rounded-lg',
                        'transition-colors duration-150',
                        'hover:bg-muted/40',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        selectedTransform?.id === t.id && colors.selected,
                        lastApplied === t.id && 'border-l-2 border-green-500 bg-green-500/5'
                      )}
                    >
                      {/* Icon container - uniform visual weight */}
                      <div className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 relative',
                        colors.iconBg
                      )}>
                        <span className="text-base leading-none">{t.icon}</span>
                        {lastApplied === t.id && (
                          <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center shadow-sm">
                            <Check className="w-2.5 h-2.5 text-white" />
                          </div>
                        )}
                      </div>

                      {/* Text block - left-aligned for scanning */}
                      <div className="flex-1 min-w-0 text-left">
                        <span className="text-sm font-medium text-foreground block truncate">
                          {t.label}
                        </span>
                        <span className="text-xs text-muted-foreground block truncate">
                          {t.description}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
