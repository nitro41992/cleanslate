import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle, useMemo } from 'react'
import { ChevronDown, Check, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
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
  /** Called when user navigates away (e.g., pressing Tab to move to next field) */
  onNavigateNext?: () => void
}

export interface GroupedTransformationPickerRef {
  /** Focus the picker (focuses search input) */
  focus: () => void
  /** Get currently highlighted transform */
  getHighlightedTransform: () => TransformationDefinition | null
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
  teal: {
    badge: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    header: 'text-teal-400',
    headerHover: 'hover:bg-teal-500/5',
    selected: 'border-l-2 border-teal-500 bg-teal-500/5',
    iconBg: 'bg-teal-500/10',
  },
  slate: {
    badge: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    header: 'text-slate-400',
    headerHover: 'hover:bg-slate-500/5',
    selected: 'border-l-2 border-slate-500 bg-slate-500/5',
    iconBg: 'bg-slate-500/10',
  },
}

// Build a map of transform ID to group for quick lookup
const transformToGroup = new Map<string, typeof TRANSFORMATION_GROUPS[number]>()
TRANSFORMATION_GROUPS.forEach(group => {
  group.transforms.forEach(id => {
    transformToGroup.set(id, group)
  })
})

/**
 * Score a transformation against a search query.
 * Higher score = better match. Returns 0 if no match.
 */
function scoreTransform(transform: TransformationDefinition, query: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0

  const label = transform.label.toLowerCase()
  const description = transform.description.toLowerCase()
  const group = transformToGroup.get(transform.id)
  const groupLabel = group?.label.toLowerCase() || ''

  let score = 0

  // Exact label match (highest priority)
  if (label === q) {
    score += 100
  }
  // Label starts with query
  else if (label.startsWith(q)) {
    score += 80
  }
  // Word in label starts with query (e.g., "pad" matches "Pad Zeros")
  else if (label.split(/\s+/).some(word => word.startsWith(q))) {
    score += 60
  }
  // Label contains query
  else if (label.includes(q)) {
    score += 40
  }
  // Description contains query
  else if (description.includes(q)) {
    score += 20
  }
  // Group label contains query
  else if (groupLabel.includes(q)) {
    score += 10
  }

  return score
}

export const GroupedTransformationPicker = forwardRef<
  GroupedTransformationPickerRef,
  GroupedTransformationPickerProps
>(function GroupedTransformationPicker({
  selectedTransform,
  lastApplied,
  disabled,
  onSelect,
  onNavigateNext,
}, ref) {
  // Start with all groups expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(TRANSFORMATION_GROUPS.map(g => g.id))
  )
  // Search query state
  const [searchQuery, setSearchQuery] = useState('')
  // Track highlighted index for keyboard navigation in search results
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)
  const [isFocused, setIsFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

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

  // Compute search results when query is active
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null

    const scored = TRANSFORMATIONS.map(t => ({
      transform: t,
      score: scoreTransform(t, searchQuery),
    }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)

    return scored.map(item => item.transform)
  }, [searchQuery])

  // Get flat list of all visible transforms (in expanded groups) or search results
  const visibleTransforms = useCallback(() => {
    // If searching, return search results
    if (searchResults) {
      return searchResults
    }

    // Otherwise, return grouped transforms
    const result: TransformationDefinition[] = []
    TRANSFORMATION_GROUPS.forEach(group => {
      if (expandedGroups.has(group.id)) {
        group.transforms.forEach(id => {
          const t = getTransformDef(id)
          if (t) result.push(t)
        })
      }
    })
    return result
  }, [expandedGroups, searchResults])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    focus: () => {
      setIsFocused(true)
      // Focus the search input
      searchInputRef.current?.focus()
    },
    getHighlightedTransform: () => {
      const transforms = visibleTransforms()
      if (highlightedIndex >= 0 && highlightedIndex < transforms.length) {
        return transforms[highlightedIndex]
      }
      return null
    },
  }), [visibleTransforms, highlightedIndex])

  // Reset highlighted index when search results change
  useEffect(() => {
    if (searchResults && searchResults.length > 0) {
      setHighlightedIndex(0)
    } else if (searchResults && searchResults.length === 0) {
      setHighlightedIndex(-1)
    }
  }, [searchResults])

  // Handle keyboard navigation in search input
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return

    const transforms = searchResults || []

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (transforms.length > 0) {
          setHighlightedIndex(prev => {
            const next = prev < transforms.length - 1 ? prev + 1 : prev
            const item = itemRefs.current.get(transforms[next].id)
            item?.scrollIntoView({ block: 'nearest' })
            return next
          })
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (transforms.length > 0) {
          setHighlightedIndex(prev => {
            const next = prev > 0 ? prev - 1 : 0
            const item = itemRefs.current.get(transforms[next].id)
            item?.scrollIntoView({ block: 'nearest' })
            return next
          })
        }
        break
      case 'Enter':
        e.preventDefault()
        if (transforms.length > 0 && highlightedIndex >= 0 && highlightedIndex < transforms.length) {
          onSelect(transforms[highlightedIndex])
          setSearchQuery('')
        }
        break
      case 'Escape':
        e.preventDefault()
        setSearchQuery('')
        setHighlightedIndex(-1)
        break
      case 'Tab':
        // Allow natural tab navigation but signal that we're moving on
        if (!e.shiftKey && onNavigateNext) {
          e.preventDefault()
          onNavigateNext()
        }
        break
    }
  }, [disabled, searchResults, highlightedIndex, onSelect, onNavigateNext])

  // Update highlighted index when selected transform changes externally
  useEffect(() => {
    if (selectedTransform) {
      const transforms = visibleTransforms()
      const index = transforms.findIndex(t => t.id === selectedTransform.id)
      if (index >= 0) {
        setHighlightedIndex(index)
      }
    }
  }, [selectedTransform, visibleTransforms])

  // Reset highlight when groups change
  useEffect(() => {
    const transforms = visibleTransforms()
    if (highlightedIndex >= transforms.length) {
      setHighlightedIndex(Math.max(0, transforms.length - 1))
    }
  }, [expandedGroups, visibleTransforms, highlightedIndex])

  // Helper to highlight matching text
  const highlightMatch = (text: string, query: string) => {
    if (!query.trim()) return text
    const q = query.toLowerCase()
    const lowerText = text.toLowerCase()
    const index = lowerText.indexOf(q)
    if (index === -1) return text

    return (
      <>
        {text.slice(0, index)}
        <span className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">
          {text.slice(index, index + query.length)}
        </span>
        {text.slice(index + query.length)}
      </>
    )
  }

  return (
    <div
      ref={containerRef}
      className="space-y-2 outline-none"
    >
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          ref={searchInputRef}
          type="text"
          placeholder="Search transformations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          disabled={disabled}
          className="pl-9 pr-8 h-9"
          data-testid="transformation-search-input"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('')
              searchInputRef.current?.focus()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-muted rounded"
          >
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Search Results */}
      {searchResults !== null && (
        <div className="space-y-1">
          {searchResults.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm">
              No transformations found for "{searchQuery}"
            </div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground px-1 py-1">
                {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
              </div>
              {searchResults.map((t, index) => {
                const group = transformToGroup.get(t.id)
                const colors = group ? colorClasses[group.color] : colorClasses.slate
                const isHighlighted = isFocused && index === highlightedIndex

                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(t.id, el)
                      else itemRefs.current.delete(t.id)
                    }}
                    onClick={() => {
                      onSelect(t)
                      setSearchQuery('')
                    }}
                    disabled={disabled}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 rounded-lg',
                      'transition-colors duration-150',
                      'hover:bg-muted/40',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selectedTransform?.id === t.id && colors.selected,
                      lastApplied === t.id && 'border-l-2 border-green-500 bg-green-500/5',
                      isHighlighted && 'ring-2 ring-primary/50 bg-muted/60'
                    )}
                  >
                    {/* Icon container */}
                    <div className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 relative',
                      colors.iconBg
                    )}>
                      <t.icon className="w-4 h-4" />
                      {lastApplied === t.id && (
                        <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center shadow-sm">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                    </div>

                    {/* Text block */}
                    <div className="flex-1 min-w-0 text-left">
                      <span className="text-sm font-medium text-foreground block truncate">
                        {highlightMatch(t.label, searchQuery)}
                      </span>
                      <span className="text-xs text-muted-foreground block truncate">
                        {highlightMatch(t.description, searchQuery)}
                      </span>
                    </div>

                    {/* Group badge */}
                    {group && (
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full border shrink-0',
                        colors.badge
                      )}>
                        {group.label}
                      </span>
                    )}
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}

      {/* Grouped View (when not searching) */}
      {searchResults === null && TRANSFORMATION_GROUPS.map(group => {
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
                <group.icon className={cn('w-4 h-4', colors.header)} />
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
                        <t.icon className="w-4 h-4" />
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
})
