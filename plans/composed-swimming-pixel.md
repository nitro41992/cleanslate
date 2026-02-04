# Plan: Type-Aware Comparison Operators for Formula Builder

## Summary

Add string comparison operators (CONTAINS, LIKE, IN, etc.) and numeric comparison operators to the formula builder, with type-aware suggestions based on column types.

## Design Decision: Functions vs Operators

**Recommendation: Add as Functions** (except IN)

Rationale:
1. DuckDB already implements CONTAINS, STARTS_WITH, ENDS_WITH as functions
2. No grammar complexity - avoids operator precedence issues
3. Excel-familiar syntax: `CONTAINS(@column, "text")`
4. Functions appear in autocomplete and Function Browser for discoverability

The **IN operator** is an exception - it needs operator syntax for natural usage: `@column IN ("a", "b", "c")`

---

## New Functions to Add

| Function | Signature | DuckDB SQL | Category |
|----------|-----------|------------|----------|
| `CONTAINS` | `CONTAINS(text, search)` | `CONTAINS(text, search)` | comparison |
| `ICONTAINS` | `ICONTAINS(text, search)` | `CONTAINS(LOWER(text), LOWER(search))` | comparison |
| `STARTSWITH` | `STARTSWITH(text, prefix)` | `STARTS_WITH(text, prefix)` | comparison |
| `ENDSWITH` | `ENDSWITH(text, suffix)` | `ENDS_WITH(text, suffix)` | comparison |
| `LIKE` | `LIKE(text, pattern)` | `text LIKE pattern` | comparison |
| `ILIKE` | `ILIKE(text, pattern)` | `text ILIKE pattern` | comparison |
| `REGEX` | `REGEX(text, pattern)` | `REGEXP_MATCHES(text, pattern)` | comparison |
| `BETWEEN` | `BETWEEN(val, min, max)` | `val BETWEEN min AND max` | comparison |

---

## Implementation Steps

### Step 1: Add String Comparison Functions

**Files to modify:**

1. **`src/lib/formula/ast.ts`**
   - Add to `FunctionName` type: `'CONTAINS' | 'ICONTAINS' | 'STARTSWITH' | 'ENDSWITH' | 'LIKE' | 'ILIKE' | 'REGEX' | 'BETWEEN'`

2. **`src/lib/formula/functions.ts`**
   - Add `FunctionSpec` entries for each new function:
   ```typescript
   CONTAINS: {
     minArgs: 2,
     maxArgs: 2,
     toSQL: (args) => `CONTAINS(CAST(${args[0]} AS VARCHAR), ${args[1]})`,
     returnsBoolean: true,
     description: 'CONTAINS(text, search) - Check if text contains search string',
     signature: 'CONTAINS(text, search)',
     category: 'comparison',
     example: 'IF(CONTAINS(@email, "@gmail"), "Gmail", "Other")',
   },
   ```

3. **`src/lib/formula/parser.ts`**
   - Add function names to grammar's `functionName` rule

### Step 2: Add IN / NOT IN Operators (Grammar Change)

**`src/lib/formula/parser.ts`** - Extend grammar:
```
Comparison = AddExpr notInOp "(" ListOf<Expression, ","> ")"  -- notIn
           | AddExpr inOp "(" ListOf<Expression, ","> ")"  -- in
           | AddExpr compOp AddExpr  -- compare
           | AddExpr

inOp = caseInsensitive<"IN">
notInOp = caseInsensitive<"NOT"> spaces caseInsensitive<"IN">
```

**`src/lib/formula/ast.ts`** - Add new node type:
```typescript
export interface InExpression {
  type: 'InExpression'
  value: ASTNode
  list: ASTNode[]
  negated: boolean  // true for NOT IN
}
```

**`src/lib/formula/transpiler.ts`** - Handle InExpression:
```typescript
case 'InExpression':
  const value = transpileNode(node.value, ctx)
  const list = node.list.map(item => transpileNode(item, ctx))
  const op = node.negated ? 'NOT IN' : 'IN'
  return `(${value} ${op} (${list.join(', ')}))`
```

### Step 3: Type-Aware UI

**`src/components/clean/FormulaEditor/types.ts`**
```typescript
export interface ColumnWithType {
  name: string
  type: string  // VARCHAR, INTEGER, DOUBLE, BOOLEAN, DATE, TIMESTAMP
}

export interface FormulaEditorProps {
  columns: ColumnWithType[]  // Changed from string[]
  // ...
}
```

**`src/components/panels/CleanPanel.tsx`**
```typescript
// Change from:
const columns = activeTable?.columns.map((c) => c.name) || []
// To:
const columns = activeTable?.columns.map((c) => ({ name: c.name, type: c.type })) || []
```

**`src/components/clean/FormulaEditor/FormulaInput.tsx`**
- Show type badges in column autocomplete dropdown
- After selecting a column, suggest type-appropriate operators

### Step 4: Update Function Browser

**`src/lib/formula/functions.ts`**
- Add new category: `'comparison'`

**`src/components/clean/FormulaEditor/FunctionBrowser.tsx`**
- Add to `CATEGORY_INFO`:
  ```typescript
  comparison: { label: 'Comparison', color: 'text-rose-400' },
  ```
- Add to `CATEGORY_ORDER`

### Step 5: Add Templates

**`src/components/clean/FormulaEditor/TemplateGallery.tsx`**
```typescript
{
  id: 'comparison-contains',
  label: 'Contains',
  description: 'Check if column contains text',
  formula: 'IF(CONTAINS(@column, "search"), "Yes", "No")',
  category: 'comparison',
},
{
  id: 'comparison-in',
  label: 'In List',
  description: 'Check if value is in a list',
  formula: 'IF(@status IN ("active", "pending"), "Open", "Closed")',
  category: 'comparison',
},
```

---

## Critical Files

| File | Changes |
|------|---------|
| `src/lib/formula/ast.ts` | Add FunctionName types, InExpression type |
| `src/lib/formula/functions.ts` | Add FunctionSpec for 8 new functions, new category |
| `src/lib/formula/parser.ts` | Grammar: add function names, IN operator |
| `src/lib/formula/transpiler.ts` | Handle InExpression, type validation |
| `src/components/clean/FormulaEditor/types.ts` | ColumnWithType interface |
| `src/components/clean/FormulaEditor/FormulaInput.tsx` | Type-aware autocomplete |
| `src/components/clean/FormulaEditor/FunctionBrowser.tsx` | Comparison category |
| `src/components/clean/FormulaEditor/TemplateGallery.tsx` | Comparison templates |
| `src/components/panels/CleanPanel.tsx` | Pass column types |

---

## Verification

1. **Unit tests**: Test each new function transpiles to correct SQL
2. **Grammar tests**: Test IN operator parsing
3. **E2E test**: Create formula with CONTAINS, verify it works on data
4. **UI test**: Verify type badges appear in autocomplete

---

## Approach

- **Scope**: Implement both new functions AND type-aware UI together
- **NOT IN**: Include NOT IN operator alongside IN

---

## Implementation Order

1. Add all comparison functions to ast.ts, functions.ts, parser.ts
2. Add IN/NOT IN operator to grammar + transpiler
3. Extend FormulaEditor props to include column types
4. Update autocomplete with type badges
5. Add "Comparison" category to Function Browser
6. Add comparison templates to Template Gallery
7. Write E2E test to verify
