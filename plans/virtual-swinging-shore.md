# Plan: Add New Formula Functions

## Summary
Add 7 new functions to the formula builder:
- **PROPER** - Title case text
- **YEAR, MONTH, DAY** - Date part extraction
- **DATEDIFF** - Days between dates
- **REGEXEXTRACT** - Extract text matching regex pattern
- **SPLIT** - Split string and get Nth part

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/formula/ast.ts` | Add 7 new function names to `FunctionName` type |
| `src/lib/formula/parser.ts` | Add 7 entries to grammar's `functionName` rule |
| `src/lib/formula/functions.ts` | Add 7 `FunctionSpec` entries with SQL mappings + new `date` category |
| `src/components/clean/FormulaEditor/FunctionBrowser.tsx` | Add `date` category to `CATEGORY_ORDER` and `CATEGORY_INFO` |
| `src/lib/formula/__tests__/parser.test.ts` | Add unit tests for new functions |

## Implementation Details

### 1. New Functions

| Function | Signature | DuckDB SQL | Category |
|----------|-----------|------------|----------|
| `PROPER` | `PROPER(text)` | `INITCAP(CAST(arg AS VARCHAR))` | text |
| `YEAR` | `YEAR(date)` | `YEAR(arg)` | date |
| `MONTH` | `MONTH(date)` | `MONTH(arg)` | date |
| `DAY` | `DAY(date)` | `DAY(arg)` | date |
| `DATEDIFF` | `DATEDIFF(start, end)` | `DATE_DIFF('day', arg0, arg1)` | date |
| `REGEXEXTRACT` | `REGEXEXTRACT(text, pattern)` | `REGEXP_EXTRACT(CAST(arg0 AS VARCHAR), arg1)` | comparison |
| `SPLIT` | `SPLIT(text, delimiter, position)` | `SPLIT_PART(CAST(arg0 AS VARCHAR), arg1, arg2)` | text |

### 2. New Date Category

Add to `FunctionBrowser.tsx`:
```typescript
const CATEGORY_ORDER: FunctionCategory[] = [
  'conditional', 'comparison', 'text', 'numeric', 'logical', 'null', 'date'  // Add date
]

const CATEGORY_INFO = {
  // ... existing ...
  date: { label: 'Date', color: 'text-sky-400' },
}
```

Add to `functions.ts`:
```typescript
export type FunctionCategory = 'conditional' | 'text' | 'numeric' | 'logical' | 'null' | 'comparison' | 'date'
```

### 3. Grammar Order (parser.ts)

Must respect length-based ordering to avoid parsing conflicts:
- `REGEXEXTRACT` before `REGEX`
- `DATEDIFF` before `DAY`
- `PROPER`, `SPLIT`, `YEAR`, `MONTH` can go anywhere

### 4. Function Specs (functions.ts)

```typescript
PROPER: {
  minArgs: 1,
  maxArgs: 1,
  toSQL: (args) => `INITCAP(CAST(${args[0]} AS VARCHAR))`,
  returnsString: true,
  description: 'PROPER(text) - Capitalizes first letter of each word',
  signature: 'PROPER(text)',
  category: 'text',
  example: 'PROPER(@name)',
},

YEAR: {
  minArgs: 1,
  maxArgs: 1,
  toSQL: (args) => `YEAR(${args[0]})`,
  returnsNumber: true,
  description: 'YEAR(date) - Extracts year from date',
  signature: 'YEAR(date)',
  category: 'date',
  example: 'YEAR(@created_at)',
},

MONTH: {
  minArgs: 1,
  maxArgs: 1,
  toSQL: (args) => `MONTH(${args[0]})`,
  returnsNumber: true,
  description: 'MONTH(date) - Extracts month (1-12) from date',
  signature: 'MONTH(date)',
  category: 'date',
  example: 'MONTH(@created_at)',
},

DAY: {
  minArgs: 1,
  maxArgs: 1,
  toSQL: (args) => `DAY(${args[0]})`,
  returnsNumber: true,
  description: 'DAY(date) - Extracts day of month (1-31) from date',
  signature: 'DAY(date)',
  category: 'date',
  example: 'DAY(@created_at)',
},

DATEDIFF: {
  minArgs: 2,
  maxArgs: 2,
  toSQL: (args) => `DATE_DIFF('day', ${args[0]}, ${args[1]})`,
  returnsNumber: true,
  description: 'DATEDIFF(start_date, end_date) - Days between two dates',
  signature: 'DATEDIFF(start_date, end_date)',
  category: 'date',
  example: 'DATEDIFF(@start_date, @end_date)',
},

REGEXEXTRACT: {
  minArgs: 2,
  maxArgs: 2,
  toSQL: (args) => `REGEXP_EXTRACT(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
  returnsString: true,
  description: 'REGEXEXTRACT(text, pattern) - Extracts text matching regex pattern',
  signature: 'REGEXEXTRACT(text, pattern)',
  category: 'comparison',
  example: 'REGEXEXTRACT(@email, "^[^@]+")',
},

SPLIT: {
  minArgs: 3,
  maxArgs: 3,
  toSQL: (args) => `SPLIT_PART(CAST(${args[0]} AS VARCHAR), ${args[1]}, ${args[2]})`,
  returnsString: true,
  description: 'SPLIT(text, delimiter, position) - Splits text and returns Nth part (1-indexed)',
  signature: 'SPLIT(text, delimiter, position)',
  category: 'text',
  example: 'SPLIT(@full_name, " ", 1)',
},
```

## Implementation Steps

1. **Update `ast.ts`** - Add function names to type union
2. **Update `functions.ts`** - Add `date` to FunctionCategory, add 7 FunctionSpecs
3. **Update `parser.ts`** - Add 7 function names to grammar (respect ordering)
4. **Update `FunctionBrowser.tsx`** - Add `date` category to CATEGORY_ORDER and CATEGORY_INFO
5. **Update `parser.test.ts`** - Add tests for each new function

## Unit Tests to Add

```typescript
// In parser.test.ts describe('function calls')

it('parses PROPER function', () => {
  const result = parseFormula('PROPER(@name)')
  expect(result.success).toBe(true)
  expect(result.ast).toMatchObject({
    type: 'FunctionCall',
    name: 'PROPER',
  })
})

it('parses date functions', () => {
  for (const fn of ['YEAR', 'MONTH', 'DAY']) {
    const result = parseFormula(`${fn}(@date_col)`)
    expect(result.success).toBe(true)
    expect(result.ast).toMatchObject({ type: 'FunctionCall', name: fn })
  }
})

it('parses DATEDIFF function', () => {
  const result = parseFormula('DATEDIFF(@start, @end)')
  expect(result.success).toBe(true)
  expect(result.ast).toMatchObject({
    type: 'FunctionCall',
    name: 'DATEDIFF',
    arguments: expect.arrayContaining([
      expect.objectContaining({ type: 'ColumnRef' }),
      expect.objectContaining({ type: 'ColumnRef' }),
    ]),
  })
})

it('parses REGEXEXTRACT function', () => {
  const result = parseFormula('REGEXEXTRACT(@email, "^[^@]+")')
  expect(result.success).toBe(true)
})

it('parses SPLIT function', () => {
  const result = parseFormula('SPLIT(@name, " ", 1)')
  expect(result.success).toBe(true)
})

// In validateFormulaSyntax test, add to array:
'PROPER(@a)',
'YEAR(@a)',
'MONTH(@a)',
'DAY(@a)',
'DATEDIFF(@a, @b)',
'REGEXEXTRACT(@a, "pattern")',
'SPLIT(@a, ",", 1)',
```

## Verification

1. **Build check**: `npm run build` passes
2. **Unit tests**: `npm run test -- src/lib/formula/__tests__/parser.test.ts`
3. **Manual UI test**:
   - Open app, load a table with date and text columns
   - Open Formula Editor
   - Verify new functions appear in FunctionBrowser under correct categories
   - Verify autocomplete suggests new functions
   - Apply each function and verify results
