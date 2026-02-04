# Formula Builder UI Redesign Plan

## Problem Statement

The current Formula transform UI has several UX issues:
1. **Small plain text input** - No syntax highlighting, autocomplete, or rich editing
2. **Confusing field labels** - "Output Column", "Output To", "Column to Replace" are unclear
3. **No conditional fields** - All fields shown regardless of context
4. **No guidance** - Users must memorize syntax without assistance
5. **"Excel" branding** - Should be renamed to "Formula Builder"

## Design Direction

**Aesthetic**: Soft Industrial - precise and capable, with warm touches that make it approachable.

**Key Differentiator**: The formula editor feels like a conversation with autocomplete that *anticipates* what you need.

## Architecture Decisions

### 1. Backwards Compatibility Strategy

**Decision**: Keep internal command type as `transform:excel_formula` but update all user-facing labels to "Formula Builder"

- Preserves backwards compatibility with existing recipes
- Keeps audit log entries consistent
- Requires only label/UI changes, not command refactoring

### 2. Component Location

**Decision**: Standalone component at `src/components/clean/FormulaEditor/`

- Follows existing patterns (e.g., `PrivacySubPanel.tsx`)
- Enables reuse in other contexts (Recipe builder)
- CleanPanel already has conditional rendering for custom transform UIs

### 3. Syntax Highlighting Approach

**Decision**: Custom CSS-based highlighting using textarea with overlay

- Monaco is too heavy (~5MB)
- CodeMirror adds ~100KB+ complexity
- Custom approach leverages existing `ohm-js` parser
- Zero additional dependencies
- Full dark theme control

## Implementation Plan

### Phase 1: Create FormulaEditor Component

**Directory**: `src/components/clean/FormulaEditor/`

```
FormulaEditor/
├── index.tsx              # Main component
├── FormulaInput.tsx       # Textarea with syntax highlighting overlay
├── Autocomplete.tsx       # Dropdown for @columns and functions
├── FunctionBrowser.tsx    # Collapsible panel with function signatures
├── TemplateGallery.tsx    # Common formula templates
└── types.ts               # Shared types
```

#### FormulaInput.tsx - Syntax Highlighting

Implementation approach:
1. Textarea as actual input element (accessibility, native behavior)
2. Transparent textarea overlaying a styled pre element
3. Sync scroll between textarea and highlight overlay
4. Use existing parser to tokenize for highlighting

Color scheme (dark theme):
- Functions: `text-amber-400` (IF, UPPER, CONCAT)
- Column refs (@name): `text-cyan-400` as badges
- Strings ("..."): `text-emerald-400`
- Numbers: `text-purple-400`
- Operators: `text-slate-400`

#### Autocomplete.tsx

Triggers:
- After typing `@` → show column list
- After typing function name start → show matching functions
- Keyboard navigation: ↑/↓/Enter/Tab/Esc

Uses existing `cmdk` library (already in package.json).

#### FunctionBrowser.tsx

Collapsible panel organized by category:
- Conditional: IF, IFERROR
- Text: UPPER, LOWER, TRIM, LEN, LEFT, RIGHT, MID, CONCAT, SUBSTITUTE
- Numeric: ROUND, ABS, CEILING, FLOOR, MOD, POWER, SQRT
- Logical: AND, OR, NOT
- Null Handling: COALESCE, ISBLANK

Click on function inserts it at cursor position.

#### TemplateGallery.tsx

Preset formulas:
- "Conditional value" - `IF(@column = "value", "Yes", "No")`
- "Combine columns" - `CONCAT(@first, " ", @last)`
- "Extract characters" - `LEFT(@column, 5)`
- "Math calculation" - `@price * @quantity`
- "Handle empty values" - `COALESCE(@column, "N/A")`
- "Categorize by range" - `IF(@amount > 1000, "High", IF(@amount > 100, "Medium", "Low"))`

### Phase 2: Integrate into CleanPanel

**File**: `src/components/panels/CleanPanel.tsx`

Add conditional rendering for `excel_formula` transform (similar to existing `custom_sql` pattern):

```tsx
} : selectedTransform.id === 'excel_formula' ? (
  <FormulaEditor
    value={params.formula || ''}
    onChange={(formula) => setParams({ ...params, formula })}
    columns={columns}
    outputMode={(params.outputMode as 'new' | 'replace') || 'new'}
    onOutputModeChange={(mode) => setParams({ ...params, outputMode: mode })}
    outputColumn={params.outputColumn || ''}
    onOutputColumnChange={(col) => setParams({ ...params, outputColumn: col })}
    targetColumn={params.targetColumn || ''}
    onTargetColumnChange={(col) => setParams({ ...params, targetColumn: col })}
    disabled={isApplying}
  />
) : ...
```

### Phase 3: Update Labels (Remove "Excel")

| File | Change |
|------|--------|
| `src/lib/commands/registry.ts` | `'transform:excel_formula': 'Formula Builder'` |
| `src/lib/transformations.ts` | `label: 'Formula Builder'` |
| `src/lib/commands/transform/tier3/excel-formula.ts` | `readonly label = 'Formula Builder'` |

### Phase 4: Extend Function Specs with UI Metadata

**File**: `src/lib/formula/functions.ts`

Add UI-friendly fields to `FunctionSpec`:

```typescript
export interface FunctionSpec {
  // Existing fields...
  minArgs: number
  maxArgs: number
  toSQL: (args: string[]) => string
  description: string
  // New UI fields
  signature?: string      // e.g., "IF(condition, true_val, false_val)"
  category?: 'conditional' | 'text' | 'numeric' | 'logical' | 'null'
  example?: string        // e.g., 'IF(@score > 80, "Pass", "Fail")'
}
```

## Component API

```typescript
interface FormulaEditorProps {
  value: string
  onChange: (value: string) => void
  columns: string[]
  outputMode: 'new' | 'replace'
  onOutputModeChange: (mode: 'new' | 'replace') => void
  outputColumn: string
  onOutputColumnChange: (value: string) => void
  targetColumn: string
  onTargetColumnChange: (value: string) => void
  disabled?: boolean
}
```

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/components/clean/FormulaEditor/index.tsx` | **CREATE** | Main FormulaEditor component |
| `src/components/clean/FormulaEditor/FormulaInput.tsx` | **CREATE** | Textarea with syntax highlighting |
| `src/components/clean/FormulaEditor/Autocomplete.tsx` | **CREATE** | Autocomplete dropdown |
| `src/components/clean/FormulaEditor/FunctionBrowser.tsx` | **CREATE** | Function reference panel |
| `src/components/clean/FormulaEditor/TemplateGallery.tsx` | **CREATE** | Formula templates |
| `src/components/clean/FormulaEditor/types.ts` | **CREATE** | Type definitions |
| `src/components/panels/CleanPanel.tsx` | **EDIT** | Add FormulaEditor conditional rendering |
| `src/lib/commands/registry.ts` | **EDIT** | Update label to "Formula Builder" |
| `src/lib/transformations.ts` | **EDIT** | Update label, description, hints |
| `src/lib/commands/transform/tier3/excel-formula.ts` | **EDIT** | Update label property |
| `src/lib/formula/functions.ts` | **EDIT** | Add UI metadata (signature, category, example) |

## Key Features

1. **Tokenized Syntax Highlighting** - Column refs as cyan badges, functions in amber
2. **Smart Autocomplete** - Triggered by `@` for columns, typing for functions
3. **Progressive Disclosure** - Output fields appear based on mode selection
4. **Contextual Function Hints** - Show signature when inside function parentheses
5. **Template Gallery** - One-click common formula patterns
6. **Function Browser** - Organized by category with full signatures
7. **Live Validation** - Inline error hints for syntax issues

## Verification Plan

1. **Visual verification**:
   - Load app, select Formula Builder transform
   - Verify syntax highlighting works
   - Verify autocomplete appears on `@` and function typing
   - Verify templates and functions popovers work

2. **Functional verification**:
   - Create formula with new column output → verify column created
   - Create formula with replace column output → verify column replaced
   - Test undo/redo works correctly

3. **Build verification**:
   ```bash
   npm run build
   npm run lint
   ```

4. **E2E tests** (if any exist for formula):
   ```bash
   npx playwright test "formula" --timeout=60000 --retries=0 --reporter=line
   ```
