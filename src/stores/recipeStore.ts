import { create } from 'zustand'
import type { Recipe, RecipeStep } from '@/types'
import { generateId } from '@/lib/utils'
import { extractRequiredColumns } from '@/lib/recipe/recipe-exporter'

/**
 * Column mapping from recipe column names to actual table column names.
 * Key = recipe column name, Value = actual table column name
 */
export type ColumnMapping = Record<string, string>

/**
 * Execution progress for recipe application
 */
export interface RecipeExecutionProgress {
  currentStep: number
  totalSteps: number
  currentStepLabel: string
}

/**
 * Build mode for the Recipe panel layout
 * - 'list': Show recipe list with CTAs (no recipe selected)
 * - 'view': Show recipe list + recipe details (recipe selected)
 * - 'build': Show transformation picker + step configuration (adding a step)
 */
export type RecipeBuildMode = 'list' | 'view' | 'build'

/**
 * Context for editing an existing recipe step inline via CleanPanel.
 * Transient UI state — not persisted to OPFS.
 */
export interface EditingStepContext {
  recipeId: string
  stepId: string
  originalStep: RecipeStep  // snapshot for cancel
}

interface RecipeState {
  // Recipe collection
  recipes: Recipe[]
  selectedRecipeId: string | null

  // Build mode state
  buildMode: RecipeBuildMode

  // Editing step context (transient, not persisted)
  editingStepContext: EditingStepContext | null

  // Execution state
  isProcessing: boolean
  executionProgress: RecipeExecutionProgress | null
  executionError: string | null

  // Column mapping state (shown when columns don't match)
  pendingColumnMapping: ColumnMapping | null
  unmappedColumns: string[]  // Recipe columns that need manual mapping

  // For "Export as Recipe" flow
  pendingExportSteps: RecipeStep[] | null
}

interface RecipeActions {
  // Recipe CRUD
  addRecipe: (recipe: Omit<Recipe, 'id' | 'createdAt' | 'modifiedAt'>) => string
  updateRecipe: (id: string, updates: Partial<Omit<Recipe, 'id' | 'createdAt'>>) => void
  deleteRecipe: (id: string) => void
  setSelectedRecipe: (id: string | null) => void
  duplicateRecipe: (id: string) => string | null

  // Step management
  addStep: (recipeId: string, step: Omit<RecipeStep, 'id'>) => boolean
  updateStep: (recipeId: string, stepId: string, updates: Partial<Omit<RecipeStep, 'id'>>) => void
  removeStep: (recipeId: string, stepId: string) => void
  restoreStep: (recipeId: string, step: RecipeStep, index: number) => void
  reorderSteps: (recipeId: string, fromIndex: number, toIndex: number) => void
  toggleStepEnabled: (recipeId: string, stepId: string) => void

  // Build mode
  setBuildMode: (mode: RecipeBuildMode) => void

  // Execution
  setIsProcessing: (processing: boolean) => void
  setExecutionProgress: (progress: RecipeExecutionProgress | null) => void
  setExecutionError: (error: string | null) => void

  // Column mapping
  setColumnMapping: (mapping: ColumnMapping | null) => void
  setUnmappedColumns: (columns: string[]) => void
  updateColumnMapping: (recipeColumn: string, tableColumn: string) => void
  clearColumnMapping: () => void

  // Editing step
  startEditingStep: (recipeId: string, stepId: string) => void
  cancelEditingStep: () => void
  commitEditingStep: (updates: Partial<Omit<RecipeStep, 'id'>>) => void

  // Export flow
  setPendingExportSteps: (steps: RecipeStep[] | null) => void

  // Bulk operations
  setRecipes: (recipes: Recipe[]) => void
  reset: () => void
}

const initialState: RecipeState = {
  recipes: [],
  selectedRecipeId: null,
  buildMode: 'list',
  editingStepContext: null,
  isProcessing: false,
  executionProgress: null,
  executionError: null,
  pendingColumnMapping: null,
  unmappedColumns: [],
  pendingExportSteps: null,
}

export const useRecipeStore = create<RecipeState & RecipeActions>((set, get) => ({
  ...initialState,

  // Recipe CRUD
  addRecipe: (recipe) => {
    const id = generateId()
    const now = new Date()
    const newRecipe: Recipe = {
      ...recipe,
      id,
      createdAt: now,
      modifiedAt: now,
    }
    set((state) => ({
      recipes: [...state.recipes, newRecipe],
      selectedRecipeId: id,
    }))
    return id
  },

  updateRecipe: (id, updates) => {
    set((state) => ({
      recipes: state.recipes.map((r) =>
        r.id === id
          ? { ...r, ...updates, modifiedAt: new Date() }
          : r
      ),
    }))
  },

  deleteRecipe: (id) => {
    set((state) => ({
      recipes: state.recipes.filter((r) => r.id !== id),
      selectedRecipeId: state.selectedRecipeId === id ? null : state.selectedRecipeId,
    }))
  },

  setSelectedRecipe: (id) => {
    set({
      selectedRecipeId: id,
      // Sync buildMode: if recipe selected → 'view', otherwise → 'list'
      buildMode: id ? 'view' : 'list',
    })
  },

  duplicateRecipe: (id) => {
    const recipe = get().recipes.find((r) => r.id === id)
    if (!recipe) return null

    const newId = generateId()
    const now = new Date()
    const duplicated: Recipe = {
      ...recipe,
      id: newId,
      name: `${recipe.name} (Copy)`,
      steps: recipe.steps.map((s) => ({ ...s, id: generateId() })),
      createdAt: now,
      modifiedAt: now,
    }
    set((state) => ({
      recipes: [...state.recipes, duplicated],
      selectedRecipeId: newId,
    }))
    return newId
  },

  // Step management
  addStep: (recipeId, step) => {
    const recipe = get().recipes.find((r) => r.id === recipeId)
    if (!recipe) return false

    // Check for exact duplicate (same type, column, and params)
    const isDuplicate = recipe.steps.some(
      (existing) =>
        existing.type === step.type &&
        existing.column === step.column &&
        JSON.stringify(existing.params) === JSON.stringify(step.params)
    )

    if (isDuplicate) return false

    const id = generateId()
    const newStep: RecipeStep = { ...step, id }
    set((state) => ({
      recipes: state.recipes.map((r) =>
        r.id === recipeId
          ? {
              ...r,
              steps: [...r.steps, newStep],
              requiredColumns: extractRequiredColumns([...r.steps, newStep]),
              modifiedAt: new Date(),
            }
          : r
      ),
    }))
    return true
  },

  updateStep: (recipeId, stepId, updates) => {
    set((state) => ({
      recipes: state.recipes.map((r) =>
        r.id === recipeId
          ? {
              ...r,
              steps: r.steps.map((s) =>
                s.id === stepId ? { ...s, ...updates } : s
              ),
              requiredColumns: extractRequiredColumns(
                r.steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s))
              ),
              modifiedAt: new Date(),
            }
          : r
      ),
    }))
  },

  removeStep: (recipeId, stepId) => {
    set((state) => ({
      recipes: state.recipes.map((r) =>
        r.id === recipeId
          ? {
              ...r,
              steps: r.steps.filter((s) => s.id !== stepId),
              requiredColumns: extractRequiredColumns(
                r.steps.filter((s) => s.id !== stepId)
              ),
              modifiedAt: new Date(),
            }
          : r
      ),
    }))
  },

  restoreStep: (recipeId, step, index) => {
    set((state) => ({
      recipes: state.recipes.map((r) => {
        if (r.id !== recipeId) return r
        const steps = [...r.steps]
        steps.splice(index, 0, step)
        return {
          ...r,
          steps,
          requiredColumns: extractRequiredColumns(steps),
          modifiedAt: new Date(),
        }
      }),
    }))
  },

  reorderSteps: (recipeId, fromIndex, toIndex) => {
    set((state) => ({
      recipes: state.recipes.map((r) => {
        if (r.id !== recipeId) return r
        const steps = [...r.steps]
        const [removed] = steps.splice(fromIndex, 1)
        steps.splice(toIndex, 0, removed)
        return { ...r, steps, modifiedAt: new Date() }
      }),
    }))
  },

  toggleStepEnabled: (recipeId, stepId) => {
    set((state) => ({
      recipes: state.recipes.map((r) =>
        r.id === recipeId
          ? {
              ...r,
              steps: r.steps.map((s) =>
                s.id === stepId ? { ...s, enabled: !s.enabled } : s
              ),
              modifiedAt: new Date(),
            }
          : r
      ),
    }))
  },

  // Build mode
  setBuildMode: (mode) => {
    set({ buildMode: mode })
  },

  // Execution
  setIsProcessing: (processing) => {
    set({ isProcessing: processing })
  },

  setExecutionProgress: (progress) => {
    set({ executionProgress: progress })
  },

  setExecutionError: (error) => {
    set({ executionError: error })
  },

  // Column mapping
  setColumnMapping: (mapping) => {
    set({ pendingColumnMapping: mapping })
  },

  setUnmappedColumns: (columns) => {
    set({ unmappedColumns: columns })
  },

  updateColumnMapping: (recipeColumn, tableColumn) => {
    set((state) => ({
      pendingColumnMapping: {
        ...(state.pendingColumnMapping ?? {}),
        [recipeColumn]: tableColumn,
      },
      unmappedColumns: state.unmappedColumns.filter((c) => c !== recipeColumn),
    }))
  },

  clearColumnMapping: () => {
    set({
      pendingColumnMapping: null,
      unmappedColumns: [],
    })
  },

  // Editing step
  startEditingStep: (recipeId, stepId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId)
    if (!recipe) return
    const step = recipe.steps.find((s) => s.id === stepId)
    if (!step) return
    set({
      editingStepContext: {
        recipeId,
        stepId,
        originalStep: { ...step },
      },
    })
  },

  cancelEditingStep: () => {
    set({ editingStepContext: null })
  },

  commitEditingStep: (updates) => {
    const ctx = get().editingStepContext
    if (!ctx) return
    get().updateStep(ctx.recipeId, ctx.stepId, updates)
    set({ editingStepContext: null })
  },

  // Export flow
  setPendingExportSteps: (steps) => {
    set({ pendingExportSteps: steps })
  },

  // Bulk operations
  setRecipes: (recipes) => {
    set({ recipes })
  },

  reset: () => {
    set(initialState)
  },
}))

/**
 * Selector: Get selected recipe
 */
export const selectSelectedRecipe = (state: RecipeState & RecipeActions): Recipe | null => {
  return state.recipes.find((r) => r.id === state.selectedRecipeId) ?? null
}

// ===== PERSISTENCE SUBSCRIPTION =====
// Trigger app state save when recipes change

// Flag to prevent save during state restoration
let isRestoringState = false

/**
 * Set flag to prevent persistence during state restoration.
 * Called by useDuckDB when loading saved recipes.
 */
export function setRestoringRecipeState(restoring: boolean): void {
  isRestoringState = restoring
}

// Initialize persistence subscription
if (typeof window !== 'undefined') {
  // Simple debounce helper
  const createDebouncedSave = () => {
    let timeoutId: NodeJS.Timeout | null = null
    return {
      trigger: (fn: () => Promise<void>) => {
        if (timeoutId) clearTimeout(timeoutId)
        timeoutId = setTimeout(() => fn().catch(console.error), 500)
      },
    }
  }

  const debouncedSave = createDebouncedSave()

  // Track previous recipes to detect actual changes
  let prevRecipesLength = 0
  let prevRecipesJson = ''

  useRecipeStore.subscribe((state) => {
    // Skip save during state restoration
    if (isRestoringState) return

    // Only save if recipes actually changed (not just UI state like selectedRecipeId)
    const currentJson = JSON.stringify(state.recipes)
    if (currentJson === prevRecipesJson && state.recipes.length === prevRecipesLength) {
      return
    }
    prevRecipesLength = state.recipes.length
    prevRecipesJson = currentJson

    console.log('[RecipeStore] Recipes changed, triggering save')

    debouncedSave.trigger(async () => {
      const { saveAppState } = await import('@/lib/persistence/state-persistence')
      const { useTableStore } = await import('@/stores/tableStore')
      const { useTimelineStore } = await import('@/stores/timelineStore')
      const { useUIStore } = await import('@/stores/uiStore')
      const { useMatcherStore } = await import('@/stores/matcherStore')

      const tableState = useTableStore.getState()
      const timelineState = useTimelineStore.getState()
      const uiState = useUIStore.getState()
      const matcherSerialized = useMatcherStore.getState().getSerializedState()
      if (matcherSerialized) {
        const matchTable = tableState.tables.find(t => t.id === matcherSerialized.tableId)
        matcherSerialized.tableRowCount = matchTable?.rowCount ?? 0
      }

      await saveAppState(
        tableState.tables,
        tableState.activeTableId,
        timelineState.getSerializedTimelines(),
        uiState.sidebarCollapsed,
        uiState.lastEdit,
        state.recipes,
        matcherSerialized
      )
    })
  })
}
