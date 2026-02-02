# Plan: Live Validation for Transform Operations

## Goal
Add live semantic validation to block invalid/no-op transforms with inline feedback.

**User Requirements:**
- Disable "Apply Transformation" button until validation passes
- Live validation as user makes selections (debounced)
- Block no-op scenarios with clear message (e.g., "No duplicates found")

---

## Architecture

### New Validation Layer (Level 2)

```
src/lib/validation/
├── index.ts                    # Public exports
├── types.ts                    # SemanticValidationResult interface
├── transform-validator.ts      # Facade routing to validators
└── validators/
    ├── remove-duplicates.ts
    ├── date-column.ts          # Shared: standardize_date, calculate_age, year_only
    ├── fill-down.ts
    ├── cast-type.ts            # Reuses existing validateCastType
    └── replace.ts
```

### Validation Result Type

```typescript
type SemanticValidationStatus = 'valid' | 'no_op' | 'invalid' | 'warning' | 'pending' | 'skipped'

interface SemanticValidationResult {
  status: SemanticValidationStatus
  message: string              // User-facing explanation
  affectedCount?: number       // Rows that will change
  code: string                 // Machine-readable for testing
}
```

---

## Transforms Requiring Validation

| Transform | Validation | Block Condition |
|-----------|------------|-----------------|
| **Remove Duplicates** | Count distinct vs total | `no_op`: "No duplicates found" |
| **Standardize Date** | Parse date success count | `invalid`: "No parseable dates" |
| **Calculate Age** | Parse date success count | `invalid`: "No parseable dates" |
| **Year Only** | Parse date success count | `invalid`: "No parseable dates" |
| **Fill Down** | Count null/empty values | `no_op`: "No empty values to fill" |
| **Cast Type** | TRY_CAST failure count | `warning`: "X values will become NULL" |
| **Replace** | Count rows with find value | `no_op`: "No rows contain 'X'" |

---

## Files to Create

### 1. `src/lib/validation/types.ts`
- `SemanticValidationStatus` type
- `SemanticValidationResult` interface

### 2. `src/lib/validation/validators/remove-duplicates.ts`
```sql
-- Check for duplicates
SELECT COUNT(*) - COUNT(DISTINCT (col1, col2, ...)) as dup_count FROM table
```

### 3. `src/lib/validation/validators/date-column.ts`
- Reuse `buildDateParseExpression` from `src/lib/commands/utils/date.ts`
- Shared by: `standardize_date`, `calculate_age`, `year_only`

### 4. `src/lib/validation/validators/fill-down.ts`
```sql
SELECT COUNT(*) FROM table WHERE col IS NULL OR TRIM(col) = ''
```

### 5. `src/lib/validation/validators/replace.ts`
```sql
SELECT COUNT(*) FROM table WHERE col LIKE '%find%'
```

### 6. `src/lib/validation/validators/cast-type.ts`
- Wrapper around existing `validateCastType()` from `transformations.ts`

### 7. `src/lib/validation/transform-validator.ts`
- Registry mapping transform types to validators
- Single `validate()` facade function

### 8. `src/lib/validation/index.ts`
- Public exports

### 9. `src/hooks/useSemanticValidation.ts`
- Debounced hook (300ms, matching TransformPreview pattern)
- Returns `SemanticValidationResult`

### 10. `src/components/clean/ValidationMessage.tsx`
- Inline alert component for validation feedback
- Red for `no_op`/`invalid`, yellow for `warning`

---

## Files to Modify

### `src/components/panels/CleanPanel.tsx`

1. **Import hook:**
   ```tsx
   import { useSemanticValidation } from '@/hooks/useSemanticValidation'
   ```

2. **Call hook** (after line 74):
   ```tsx
   const validationResult = useSemanticValidation(
     activeTable?.name,
     selectedTransform?.id,
     selectedColumn,
     params
   )
   ```

3. **Update `isValid()`** (lines 148-158):
   ```tsx
   const isValid = () => {
     if (!selectedTransform) return false
     if (selectedTransform.requiresColumn && !selectedColumn) return false
     // ... existing param checks

     // NEW: Semantic validation
     if (validationResult.status === 'no_op' ||
         validationResult.status === 'invalid') {
       return false
     }
     return true
   }
   ```

4. **Add ValidationMessage** (before Apply button, ~line 600):
   ```tsx
   {validationResult.status !== 'valid' &&
    validationResult.status !== 'skipped' &&
    validationResult.status !== 'pending' && (
     <ValidationMessage result={validationResult} />
   )}
   ```

---

## Data Flow

```
User selects transform/column/params
         ↓
useSemanticValidation hook (300ms debounce)
         ↓
transformValidator.validate(tableName, type, column, params)
         ↓
Specific validator runs DuckDB query
         ↓
Returns SemanticValidationResult
         ↓
CleanPanel updates:
  - isValid() checks result.status
  - ValidationMessage shows result.message
  - Button disabled if no_op/invalid
```

---

## Implementation Order

1. Create `src/lib/validation/types.ts`
2. Create validators (start with `remove-duplicates.ts`)
3. Create `transform-validator.ts` facade
4. Create `src/lib/validation/index.ts`
5. Create `useSemanticValidation.ts` hook
6. Create `ValidationMessage.tsx` component
7. Integrate into `CleanPanel.tsx`
8. Add E2E tests

---

## Verification

### Manual Testing
1. Select "Remove Duplicates" on a table with no duplicates → button disabled, shows "No duplicates found"
2. Select "Standardize Date" on a text column with no dates → button disabled, shows "No parseable dates"
3. Select "Fill Down" on a column with no empty values → button disabled, shows "No empty values to fill"
4. Select "Replace" and enter a value that doesn't exist → button disabled, shows "No rows contain 'X'"

### E2E Tests
- `e2e/tests/transform-validation.spec.ts` - New test file covering all validation scenarios
