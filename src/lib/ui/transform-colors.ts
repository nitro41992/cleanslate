/**
 * Transform Color Utilities
 *
 * Shared color system for transforms and recipe steps.
 * Provides consistent styling across Transform Picker and Recipe cards.
 */

import { TRANSFORMATION_GROUPS } from '@/lib/transformations'

export type TransformCategoryColor =
  | 'emerald'
  | 'blue'
  | 'violet'
  | 'amber'
  | 'rose'
  | 'teal'
  | 'slate'

export interface CategoryColorClasses {
  iconBg: string
  border: string
  selectedBg: string
  badge: string
  dot: string
  connector: string
}

export const categoryColorClasses: Record<TransformCategoryColor, CategoryColorClasses> = {
  emerald: {
    iconBg: 'bg-emerald-500/10',
    border: 'border-l-2 border-emerald-500',
    selectedBg: 'bg-emerald-500/5',
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    dot: 'bg-emerald-500',
    connector: 'bg-emerald-500/30',
  },
  blue: {
    iconBg: 'bg-blue-500/10',
    border: 'border-l-2 border-blue-500',
    selectedBg: 'bg-blue-500/5',
    badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    dot: 'bg-blue-500',
    connector: 'bg-blue-500/30',
  },
  violet: {
    iconBg: 'bg-violet-500/10',
    border: 'border-l-2 border-violet-500',
    selectedBg: 'bg-violet-500/5',
    badge: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    dot: 'bg-violet-500',
    connector: 'bg-violet-500/30',
  },
  amber: {
    iconBg: 'bg-amber-500/10',
    border: 'border-l-2 border-amber-500',
    selectedBg: 'bg-amber-500/5',
    badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    dot: 'bg-amber-500',
    connector: 'bg-amber-500/30',
  },
  rose: {
    iconBg: 'bg-rose-500/10',
    border: 'border-l-2 border-rose-500',
    selectedBg: 'bg-rose-500/5',
    badge: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    dot: 'bg-rose-500',
    connector: 'bg-rose-500/30',
  },
  teal: {
    iconBg: 'bg-teal-500/10',
    border: 'border-l-2 border-teal-500',
    selectedBg: 'bg-teal-500/5',
    badge: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    dot: 'bg-teal-500',
    connector: 'bg-teal-500/30',
  },
  slate: {
    iconBg: 'bg-slate-500/10',
    border: 'border-l-2 border-slate-500',
    selectedBg: 'bg-slate-500/5',
    badge: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    dot: 'bg-slate-500',
    connector: 'bg-slate-500/30',
  },
}

// Build a map of transform ID to category color for quick lookup
const transformToColor = new Map<string, TransformCategoryColor>()
TRANSFORMATION_GROUPS.forEach((group) => {
  group.transforms.forEach((id) => {
    transformToColor.set(id, group.color)
  })
})

/**
 * Get the category color for a transform ID.
 * Falls back to 'slate' for unknown transforms.
 */
export function getTransformColor(transformId: string): TransformCategoryColor {
  return transformToColor.get(transformId) || 'slate'
}

/**
 * Get the color classes for a transform ID.
 */
export function getTransformColorClasses(transformId: string): CategoryColorClasses {
  const color = getTransformColor(transformId)
  return categoryColorClasses[color]
}
