# Fix: Recipe Export Missing Algorithm for Standardize Commands

## Problem
When running a recipe, step 3 "apply → Age" (a `standardize:apply` command) fails with:
```
Invalid algorithm: undefined
```

The recipe step only has `mappings` but is missing the `algorithm` parameter required by `StandardizeApplyCommand`.

## Root Cause
In `executor.ts:1642-1648`, when storing `standardize:apply` commands to the timeline, only `columnName` and `mappings` are saved. The `algorithm` field is not included:

```typescript
if (command.type === 'standardize:apply') {
  const standardizeParams = command.params as { column: string; mappings: unknown[] }
  timelineParams = {
    type: 'standardize',
    columnName: standardizeParams.column,
    mappings: standardizeParams.mappings,
    // MISSING: algorithm
  } as import('@/types').StandardizeParams
}
```

When the recipe exporter extracts this command, it only gets `mappings` (no `algorithm`). When the recipe executor tries to run the step, `createCommand()` receives `algorithm: undefined`, which fails validation in `apply.ts:44-51`.

## Solution

### 1. Add `algorithm` to `StandardizeParams` type
**File:** `src/types/index.ts:385-389`

Add the `algorithm` field to the interface:
```typescript
export interface StandardizeParams {
  type: 'standardize'
  columnName: string
  algorithm: ClusteringAlgorithm  // ADD THIS
  mappings: StandardizationMapping[]
}
```

### 2. Store `algorithm` when syncing to timeline
**File:** `src/lib/commands/executor.ts:1642-1648`

Include `algorithm` when building timeline params:
```typescript
if (command.type === 'standardize:apply') {
  const standardizeParams = command.params as {
    column: string
    algorithm: import('@/types').ClusteringAlgorithm
    mappings: unknown[]
  }
  timelineParams = {
    type: 'standardize',
    columnName: standardizeParams.column,
    algorithm: standardizeParams.algorithm,  // ADD THIS
    mappings: standardizeParams.mappings,
  } as import('@/types').StandardizeParams
}
```

## Files to Modify
1. `src/types/index.ts` - Add `algorithm` field to `StandardizeParams`
2. `src/lib/commands/executor.ts` - Store `algorithm` in timeline params

## Verification
1. Create a standardization on a column (e.g., Age with fingerprint algorithm)
2. Export the table's transforms as a recipe
3. Apply the recipe to a new table with the same schema
4. Verify step completes without "Invalid algorithm: undefined" error
