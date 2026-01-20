# Plan: Comprehensive Transformation Tests + Find & Replace Enhancements

## Summary

Add comprehensive E2E tests for all 9 existing transformations and enhance Find & Replace with case sensitivity and exact match options.

---

## Part 1: Add Missing Transformation Tests

### Currently Implemented Transformations (9 total)

| Transformation | Has Tests | Action |
|---------------|-----------|--------|
| Trim Whitespace | ✅ Yes | None |
| Uppercase | ✅ Yes | None |
| Lowercase | ✅ Yes | None |
| Remove Duplicates | ✅ Yes | None |
| Filter Empty | ✅ Yes | None |
| **Find & Replace** | ❌ No | Add tests |
| **Rename Column** | ❌ No | Add tests |
| **Cast Type** | ❌ No | Add tests |
| **Custom SQL** | ❌ No | Add tests |

### New Tests to Add in `e2e/tests/transformations.spec.ts`

#### 1. Find & Replace Tests
```typescript
test('should apply find and replace transformation', async ({ page }) => {
  // Upload data with known text patterns
  // Apply find & replace: "hello" -> "world"
  // Verify replacement occurred
  // Verify audit log entry
});

test('should replace multiple occurrences in find and replace', async ({ page }) => {
  // Data: "test test test"
  // Replace "test" -> "pass"
  // Result: "pass pass pass"
});

test('should handle special characters in find and replace', async ({ page }) => {
  // Data with quotes, commas, etc.
  // Verify proper escaping
});
```

#### 2. Rename Column Tests
```typescript
test('should rename column', async ({ page }) => {
  // Upload CSV with column "old_name"
  // Apply rename: "old_name" -> "new_name"
  // Verify column header changed
  // Verify data preserved
  // Verify audit log
});
```

#### 3. Cast Type Tests
```typescript
test('should cast string to integer', async ({ page }) => {
  // Upload CSV with numeric strings "123", "456"
  // Cast to INTEGER
  // Verify type changed (export and check)
});

test('should cast string to date', async ({ page }) => {
  // Upload CSV with date strings
  // Cast to DATE
  // Verify conversion
});
```

#### 4. Custom SQL Tests
```typescript
test('should apply custom SQL transformation', async ({ page }) => {
  // Upload CSV
  // Apply custom SQL: SELECT *, column * 2 as doubled FROM ...
  // Verify new column created with correct values
});
```

### Test Fixtures Needed

Create in `e2e/fixtures/csv/`:

1. **`find-replace-data.csv`** - For find/replace tests
   ```csv
   name,description
   hello world,hello there
   say hello,hello hello
   goodbye,no match here
   ```

2. **`numeric-strings.csv`** - For cast type tests
   ```csv
   id,amount,date_str
   1,100,2024-01-15
   2,200,2024-02-20
   3,300,2024-03-25
   ```

---

## Part 2: Enhance Find & Replace

### Current Behavior
- Uses DuckDB `REPLACE()` function
- Case-sensitive substring matching only
- No options for case sensitivity or match type

### Proposed Enhancement

Add two new optional parameters:

1. **Case Sensitive** (dropdown: Yes/No, default: Yes)
2. **Match Type** (dropdown: Contains/Exact, default: Contains)

### Files to Modify

#### 1. `src/lib/transformations.ts`

**Update transformation definition (line ~55):**
```typescript
{
  id: 'replace',
  label: 'Find & Replace',
  description: 'Replace text values',
  icon: '🔍',
  requiresColumn: true,
  params: [
    { name: 'find', type: 'text', label: 'Find' },
    { name: 'replace', type: 'text', label: 'Replace with' },
    {
      name: 'caseSensitive',
      type: 'select',
      label: 'Case Sensitive',
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' }
      ],
      default: 'true'  // New field for default value
    },
    {
      name: 'matchType',
      type: 'select',
      label: 'Match Type',
      options: [
        { value: 'contains', label: 'Contains' },
        { value: 'exact', label: 'Exact Match' }
      ],
      default: 'contains'  // New field for default value
    }
  ],
}
```

**Update SQL generation (line ~167):**
```typescript
case 'replace': {
  const find = (step.params?.find as string) || ''
  const replaceWith = (step.params?.replace as string) || ''
  const caseSensitive = (step.params?.caseSensitive as string) ?? 'true'
  const matchType = (step.params?.matchType as string) ?? 'contains'

  const escapedFind = find.replace(/'/g, "''")
  const escapedReplace = replaceWith.replace(/'/g, "''")

  if (matchType === 'exact') {
    // Exact match: replace entire cell value only if it matches
    if (caseSensitive === 'false') {
      sql = `UPDATE "${tableName}" SET "${step.column}" =
             CASE WHEN LOWER("${step.column}") = LOWER('${escapedFind}')
             THEN '${escapedReplace}'
             ELSE "${step.column}" END`
    } else {
      sql = `UPDATE "${tableName}" SET "${step.column}" =
             CASE WHEN "${step.column}" = '${escapedFind}'
             THEN '${escapedReplace}'
             ELSE "${step.column}" END`
    }
  } else {
    // Contains: replace all occurrences of substring
    if (caseSensitive === 'false') {
      // Case-insensitive substring replacement using REGEXP_REPLACE
      sql = `UPDATE "${tableName}" SET "${step.column}" =
             REGEXP_REPLACE("${step.column}", '(?i)' || '${escapedFind}', '${escapedReplace}', 'g')`
    } else {
      // Default: case-sensitive substring replacement
      sql = `UPDATE "${tableName}" SET "${step.column}" =
             REPLACE("${step.column}", '${escapedFind}', '${escapedReplace}')`
    }
  }
  await execute(sql)
  break
}
```

#### 2. `src/features/laundromat/components/TransformationPicker.tsx`

**Update `handleSelect` to pre-populate defaults (line ~41):**
```typescript
const handleSelect = (transformation: TransformationDefinition) => {
  setSelected(transformation)
  setSelectedColumn('')
  // Pre-populate params with defaults
  const defaultParams: Record<string, string> = {}
  transformation.params?.forEach((param) => {
    if (param.default) {
      defaultParams[param.name] = param.default
    }
  })
  setParams(defaultParams)
}
```

#### 3. Update `TransformationDefinition` type in `src/lib/transformations.ts`

Add `default` field to param type (line ~10):
```typescript
params?: {
  name: string
  type: 'text' | 'number' | 'select'
  label: string
  options?: { value: string; label: string }[]
  default?: string  // Add this field
}[]
```

### New Tests for Enhanced Find & Replace

```typescript
test('should apply case-insensitive find and replace', async ({ page }) => {
  // Data: "Hello HELLO hello"
  // Find: "hello", Replace: "hi", Case Sensitive: No
  // Result: "hi hi hi"
});

test('should apply exact match find and replace', async ({ page }) => {
  // Data: "hello world", "hello", "say hello"
  // Find: "hello", Replace: "hi", Match Type: Exact
  // Result: "hello world", "hi", "say hello" (only exact match replaced)
});

test('should apply case-insensitive exact match', async ({ page }) => {
  // Data: "HELLO", "Hello", "hello world"
  // Find: "hello", Replace: "hi", Case Sensitive: No, Match Type: Exact
  // Result: "hi", "hi", "hello world"
});
```

---

## Implementation Order

### Phase 1: Add Comprehensive Tests for Existing Transformations
1. Create test fixtures (`find-replace-data.csv`, `numeric-strings.csv`)
2. Add Find & Replace basic tests (current behavior)
3. Add Rename Column tests
4. Add Cast Type tests
5. Add Custom SQL tests

### Phase 2: Enhance Find & Replace
6. Add `default` field to `TransformationDefinition` param type in `src/lib/transformations.ts`
7. Update `TransformationPicker.tsx` `handleSelect` to pre-populate defaults
8. Update Find & Replace transformation definition with new params (caseSensitive, matchType)
9. Update Find & Replace SQL generation logic for all 4 combinations
10. Update `e2e/page-objects/transformation-picker.page.ts` to handle select params

### Phase 3: Test Enhanced Find & Replace
11. Add tests for case-insensitive find & replace
12. Add tests for exact match find & replace
13. Add tests for case-insensitive exact match

### Page Object Update Needed

**`e2e/page-objects/transformation-picker.page.ts`** - Add `selectParam` method:
```typescript
async selectParam(paramLabel: string, optionLabel: string): Promise<void> {
  // Click the combobox for this param
  const label = this.page.getByText(paramLabel, { exact: true })
  const select = label.locator('..').locator('[role="combobox"]')
  await select.click()
  await this.page.getByRole('option', { name: optionLabel }).click()
}

// Update addTransformation to handle select params
async addTransformation(
  type: string,
  options?: {
    column?: string
    params?: Record<string, string>
    selectParams?: Record<string, string>  // New: for dropdown selections
  }
): Promise<void> {
  await this.selectTransformation(type)

  if (options?.column) {
    await this.selectColumn(options.column)
  }

  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      await this.fillParam(key, value)
    }
  }

  if (options?.selectParams) {
    for (const [label, option] of Object.entries(options.selectParams)) {
      await this.selectParam(label, option)
    }
  }

  await this.addToRecipe()
}
```

---

## Verification

1. Run `npm test` - all existing tests should pass
2. Run `npm test -- --grep "find and replace"` - new tests pass
3. Run `npm test -- --grep "rename column"` - new tests pass
4. Run `npm test -- --grep "cast type"` - new tests pass
5. Manual verification:
   - Open app, upload CSV
   - Apply Find & Replace with different options
   - Verify UI shows new dropdown options
   - Verify case-insensitive and exact match work correctly

---

## Critical Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/lib/transformations.ts` | 4-16, 55-63, 167-176 | TransformationDefinition type, Find & Replace definition and SQL |
| `src/features/laundromat/components/TransformationPicker.tsx` | 41-45 | Pre-populate default params |
| `e2e/page-objects/transformation-picker.page.ts` | 35-64 | Test helper for select params |
| `e2e/tests/transformations.spec.ts` | entire file | Main test file |
| `e2e/fixtures/csv/` | new files | Test data files |
