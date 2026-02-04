import type { ReactNode } from 'react'

/**
 * Format a recipe step parameter value for display.
 * Handles arrays of objects (e.g., scrub rules), primitives, and booleans.
 */
export function formatRecipeValue(value: unknown): ReactNode {
  if (value === '' || value === null || value === undefined) {
    return <span className="text-muted-foreground/60 italic">(empty)</span>
  }

  if (Array.isArray(value)) {
    // Handle arrays of objects (e.g., scrub rules)
    if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
      // Format scrub rules as nested vertical list
      if ('column' in value[0] && 'method' in value[0]) {
        return (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {value.map((item, idx) => {
              const rule = item as { column: string; method: string }
              return (
                <div key={idx} className="flex items-center gap-1.5 text-foreground pl-2">
                  <span className="text-muted-foreground/50">•</span>
                  <span className="font-medium">{rule.column}</span>
                  <span className="text-muted-foreground">→</span>
                  <span>{rule.method}</span>
                </div>
              )
            })}
          </div>
        )
      }
      // Fallback for other object arrays
      return value.map((item, idx) => (
        <span key={idx}>
          {idx > 0 && ', '}
          {JSON.stringify(item)}
        </span>
      ))
    }
    return value.join(', ')
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}
