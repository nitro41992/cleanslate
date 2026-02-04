# Plan: Excel Formula Transform

## Goal
Add an "Excel Formula" transform to the CleanPanel that accepts Excel-like syntax (IF, LEN, UPPER, etc.) and transpiles it to DuckDB SQL for execution. Target users: Excel power users who know formulas but avoid SQL.

## User Decisions
- **Column syntax:** `@column_name` or `@[Column Name]` for spaces
- **Output mode:** User chooses each time (new column vs. overwrite existing)
- **Parser:** Custom lightweight parser (Ohm.js)
- **Error handling:** Preview errors first via existing live preview infrastructure

## Scope
**In Scope:**
- Row-level logic: String manipulation, Basic Math, Conditional Logic
- Functions: IF, IFERROR, LEN, UPPER, LOWER, LEFT, RIGHT, MID, TRIM, CONCAT, ROUND, ABS, etc.

**Out of Scope:**
- Cell references (=A1+B2)
- Cross-sheet lookups (VLOOKUP)
- Array formulas
- Financial functions (NPV, IRR)

---

## Critical Design Considerations

### 1. The "Loose Type" Trap (Excel vs SQL)
**Problem:** Excel allows mixed return types; SQL is strict.
- Excel: `IF(A > 10, "High", 0)` → Valid (mixed String/Number)
- SQL: `CASE WHEN ... THEN 'High' ELSE 0 END` → **Error: type mismatch**

**Solution:** Smart transpiler with type coercion:
- Detect mixed return types in IF/IFERROR branches
- Auto-cast to common type: `ELSE CAST(0 AS VARCHAR)`
- For string functions on numeric columns: `LENGTH(CAST("Age" AS VARCHAR))`

### 2. Case Insensitivity
**Problem:** Users type `len(@col)`, `Len(@col)`, `LEN(@col)` interchangeably.

**Solution:** Use Ohm.js `caseInsensitive` matcher for all function names.

### 3. Column Names with Spaces
**Problem:** `@Total Revenue` fails with simple regex.

**Solution:** Support bracket syntax: `@[Total Revenue]` → `"Total Revenue"`

### 4. SQL Injection Prevention
**Problem:** Column named `Name"; DROP TABLE users; --` could be exploited.

**Solution:** Use existing `quoteIdentifier()` from `src/lib/commands/utils/sql.ts` for ALL column references. Never string concatenate raw user input.

---

## Architecture

```
User Input: IF(@State = "NY", "East", "West")
                    ↓
            [Excel Parser (Ohm.js)]
                    ↓
            [AST: FunctionCall]
                    ↓
            [SQL Code Generator + Type Coercion]
                    ↓
DuckDB SQL: CASE WHEN "State" = 'NY' THEN 'East' ELSE 'West' END
                    ↓
            [Existing Command Pattern]
```

---

## Implementation Steps

### 1. Define Transform in UI (`src/lib/transformations.ts`)

Add to `TRANSFORMATIONS` array:
```typescript
{
  id: 'excel_formula',
  label: 'Excel Formula',
  description: 'Apply Excel-like formulas (IF, LEN, UPPER, etc.)',
  icon: FunctionSquare,  // from lucide-react
  requiresColumn: false,  // Column selected via @syntax in formula
  params: [
    { name: 'formula', type: 'text', label: 'Formula', required: true },
    { name: 'outputColumn', type: 'text', label: 'Output Column', required: false },
    {
      name: 'outputMode',
      type: 'select',
      label: 'Output To',
      options: [
        { value: 'new', label: 'New Column' },
        { value: 'replace', label: 'Replace Column' }
      ],
      default: 'new'
    }
  ],
  examples: [
    { before: 'IF(@State="NY", "East", "West")', after: 'East / West based on State' },
    { before: 'UPPER(@name)', after: 'JOHN DOE' },
    { before: '@price * @quantity', after: '150.00' },
  ],
  hints: [
    'Reference columns: @name or @[Column With Spaces]',
    'Supported: IF, IFERROR, LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM, CONCAT, ROUND, ABS',
    'String literals use double quotes: "NY"',
    'Case insensitive: LEN, len, Len all work',
  ],
}
```

Add to `TRANSFORMATION_GROUPS` in "Advanced" group alongside Custom SQL.

### 2. Create Formula Parser (`src/lib/formula/`)

**New directory structure:**
```
src/lib/formula/
├── parser.ts          # Ohm.js grammar + parser
├── ast.ts             # AST node types
├── transpiler.ts      # AST → DuckDB SQL
├── functions.ts       # Excel function → SQL mapping
└── index.ts           # Public API
```

**Grammar (Ohm.js) - Case Insensitive:**
```
ExcelFormula {
  Formula = Expression

  Expression = Conditional | Comparison

  // Case-insensitive function names
  Conditional = caseInsensitive<"IF"> "(" Expression "," Expression "," Expression ")"
              | caseInsensitive<"IFERROR"> "(" Expression "," Expression ")"

  Comparison = AddExpr (compOp AddExpr)?
  compOp = "=" | "<>" | "!=" | "<" | ">" | "<=" | ">="

  AddExpr = MulExpr (("+"|"-") MulExpr)*
  MulExpr = UnaryExpr (("*"|"/") UnaryExpr)*
  UnaryExpr = "-"? Primary

  Primary = FunctionCall | ColumnRef | StringLiteral | NumberLiteral | "(" Expression ")"

  FunctionCall = functionName "(" Arguments ")"
  functionName = caseInsensitive<"LEN"> | caseInsensitive<"UPPER"> | caseInsensitive<"LOWER">
               | caseInsensitive<"LEFT"> | caseInsensitive<"RIGHT"> | caseInsensitive<"MID">
               | caseInsensitive<"TRIM"> | caseInsensitive<"CONCAT"> | caseInsensitive<"ROUND">
               | caseInsensitive<"ABS"> | caseInsensitive<"COALESCE">
               | caseInsensitive<"AND"> | caseInsensitive<"OR"> | caseInsensitive<"NOT">

  Arguments = Expression ("," Expression)*

  // Column reference: @name or @[Name With Spaces]
  ColumnRef = "@" (bracketedName | simpleName)
  bracketedName = "[" (~"]" any)+ "]"
  simpleName = letter (letter | digit | "_")*

  StringLiteral = "\"" (~"\"" any)* "\""
  NumberLiteral = digit+ ("." digit+)?
}
```

**Function Mapping (`functions.ts`):**
| Excel | DuckDB SQL | Notes |
|-------|------------|-------|
| `IF(a, b, c)` | `CASE WHEN a THEN b ELSE c END` | Auto-cast branches to common type |
| `IFERROR(expr, fallback)` | `COALESCE(TRY_CAST(expr), fallback)` | Catches NULL/errors |
| `LEN(x)` | `LENGTH(CAST(x AS VARCHAR))` | Safe for numeric columns |
| `UPPER(x)` | `UPPER(CAST(x AS VARCHAR))` | Safe for numeric columns |
| `LOWER(x)` | `LOWER(CAST(x AS VARCHAR))` | Safe for numeric columns |
| `LEFT(x, n)` | `LEFT(CAST(x AS VARCHAR), n)` | |
| `RIGHT(x, n)` | `RIGHT(CAST(x AS VARCHAR), n)` | |
| `MID(x, start, len)` | `SUBSTR(CAST(x AS VARCHAR), start, len)` | |
| `TRIM(x)` | `TRIM(CAST(x AS VARCHAR))` | |
| `CONCAT(a, b, ...)` | `CONCAT(a, b, ...)` | DuckDB auto-casts |
| `ROUND(x, n)` | `ROUND(x, n)` | |
| `ABS(x)` | `ABS(x)` | |
| `COALESCE(a, b)` | `COALESCE(a, b)` | |
| `AND(a, b)` | `(a AND b)` | |
| `OR(a, b)` | `(a OR b)` | |
| `NOT(a)` | `NOT(a)` | |

**Type Coercion Rules:**
- String functions (LEN, UPPER, LOWER, LEFT, RIGHT, MID, TRIM) always cast input to VARCHAR
- IF/IFERROR branches: detect types, cast to common type (VARCHAR wins over NUMBER)
- Comparison operators: preserve original types

### 3. Create Command Class (`src/lib/commands/transform/tier3/excel-formula.ts`)

```typescript
interface ExcelFormulaParams {
  tableId: string
  formula: string
  outputColumn?: string  // Name for new column (if outputMode='new')
  outputMode: 'new' | 'replace'
  targetColumn?: string  // Column to replace (if outputMode='replace')
}

class ExcelFormulaCommand extends Tier3TransformCommand<ExcelFormulaParams> {
  readonly type = 'transform:excel_formula'
  readonly label = 'Excel Formula'

  async validateParams(ctx): Promise<ValidationResult> {
    // 1. Parse formula - check syntax
    // 2. Validate all @column references exist in table
    // 3. If outputMode='new', check outputColumn doesn't exist
    // 4. If outputMode='replace', check targetColumn exists
  }

  async execute(ctx): Promise<ExecutionResult> {
    const { formula, outputMode, outputColumn, targetColumn } = this.params

    // 1. Parse and transpile formula to SQL expression
    const sqlExpr = transpileFormula(formula, ctx.table.columns)

    // 2. Generate appropriate SQL
    if (outputMode === 'new') {
      sql = `ALTER TABLE "${table}" ADD COLUMN "${outputColumn}" AS (${sqlExpr})`
      // Then materialize: UPDATE ... SET outputColumn = outputColumn
    } else {
      sql = `UPDATE "${table}" SET "${targetColumn}" = ${sqlExpr}`
    }

    // 3. Execute via DuckDB
    // 4. Return result with new column info
  }

  getAffectedRowsPredicate(): string | null {
    // For 'replace' mode: WHERE original != new expression
    // For 'new' mode: null (all rows get new column)
  }
}
```

### 4. Add Live Preview Support (`src/lib/preview/transform-preview.ts`)

Add `excel_formula` to `PREVIEW_SUPPORTED_TRANSFORMS` array.

Add case in `generatePreviewSQL()`:
```typescript
case 'excel_formula': {
  const { formula, outputMode, outputColumn, targetColumn } = params
  const sqlExpr = transpileFormula(formula, columns)

  if (outputMode === 'new') {
    return {
      sql: `SELECT *, (${sqlExpr}) AS "${outputColumn}" FROM "${table}" LIMIT 5`,
      countSql: `SELECT COUNT(*) FROM "${table}"`
    }
  } else {
    return {
      sql: `SELECT "${targetColumn}" AS before, (${sqlExpr}) AS after FROM "${table}"
            WHERE "${targetColumn}" IS DISTINCT FROM (${sqlExpr}) LIMIT 5`,
      countSql: `SELECT COUNT(*) FROM "${table}"
                 WHERE "${targetColumn}" IS DISTINCT FROM (${sqlExpr})`
    }
  }
}
```

### 5. Register Command (`src/lib/commands/registry.ts`)

```typescript
// Add to TRANSFORM_TO_COMMAND
excel_formula: 'transform:excel_formula',

// Add to TIER_3_COMMANDS
TIER_3_COMMANDS.add('transform:excel_formula')

// Add to COMMANDS_WITH_CUSTOM_PARAMS
excel_formula: ['formula', 'outputColumn', 'outputMode', 'targetColumn']
```

### 6. UI Enhancements in CleanPanel

**Formula input with syntax hints:**
- Monospace font for formula input
- Show autocomplete for `@` (list available columns, including `@[spaced names]`)
- Highlight syntax errors inline as user types
- **Debounce 300ms** before triggering transpilation + preview SQL query

**Output mode selector:**
- Radio buttons: "Create new column" / "Replace existing column"
- Conditional field: Column name input (new) or column dropdown (replace)

**Error display:**
- Parse errors: Show inline below input (e.g., "Unknown function: VLOOKUP")
- Type errors: Show in preview panel (e.g., "Cannot compare VARCHAR to INTEGER")
- SQL errors: Caught in preview, shown with friendly message

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/formula/parser.ts` | Create | Ohm.js grammar + parser |
| `src/lib/formula/ast.ts` | Create | AST type definitions |
| `src/lib/formula/transpiler.ts` | Create | AST → SQL code generator |
| `src/lib/formula/functions.ts` | Create | Excel → DuckDB function mapping |
| `src/lib/formula/index.ts` | Create | Public API exports |
| `src/lib/transformations.ts` | Modify | Add transform definition |
| `src/lib/commands/transform/tier3/excel-formula.ts` | Create | Command implementation |
| `src/lib/commands/transform/tier3/index.ts` | Modify | Export new command |
| `src/lib/commands/registry.ts` | Modify | Register command type + tier |
| `src/lib/preview/transform-preview.ts` | Modify | Add preview SQL generation |
| `src/components/panels/CleanPanel.tsx` | Modify | Formula input UI enhancements |
| `package.json` | Modify | Add `ohm-js` dependency |

---

## Verification

1. **Unit tests** (`src/lib/formula/__tests__/`):
   - Parser tests for each supported function
   - Transpiler tests: formula → expected SQL
   - Error cases: invalid syntax, unknown functions, bad column refs

2. **E2E tests** (`e2e/tests/excel-formula.spec.ts`):
   - Apply formula, verify data via SQL query
   - Test preview shows correct before/after
   - Test error preview for invalid formulas
   - Test undo/redo (Tier 3 snapshot)
   - Test both output modes (new column / replace)

3. **Manual verification**:
   - Open CleanPanel → Advanced → Excel Formula
   - Enter `IF(@State="NY", "East", "West")`
   - Verify live preview shows correct transformation
   - Apply and verify grid updates
   - Undo and verify rollback

---

## Dependencies

- **ohm-js** (~50KB gzipped) - Parsing library for grammar definition
  - Alternative: Nearley.js if bundle size is critical

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Parser complexity | Start with minimal grammar, expand incrementally |
| SQL injection | **MUST use `quoteIdentifier()` from `src/lib/commands/utils/sql.ts`** for all column refs |
| Type mismatches | Smart transpiler auto-casts; preview catches remaining errors |
| Mixed return types | Auto-detect and cast IF/IFERROR branches to common type |
| Large tables | Uses existing batch processing for >500k rows |
| Numeric columns in string functions | Always wrap with `CAST(x AS VARCHAR)` |

## Security: SQL Injection Prevention

**Critical:** The transpiler MUST import and use existing sanitization:

```typescript
// In transpiler.ts
import { quoteIdentifier } from '@/lib/commands/utils/sql'

function transpileColumnRef(columnName: string): string {
  // NEVER do: return `"${columnName}"`
  // ALWAYS do:
  return quoteIdentifier(columnName)
}
```

This handles malicious column names like `Name"; DROP TABLE users; --`.
