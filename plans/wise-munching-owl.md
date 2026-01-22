# Plan: Enhanced Transformation Descriptions & Examples

## Problem
The transformation picker lacks clarity:
1. Descriptions are too brief - users don't know what each transform actually does
2. No examples showing before/after values
3. Custom SQL is a "black box" - no guidance on table name, columns, or SQL syntax
4. Users can't easily discover capabilities without trial and error

## Solution Overview

Add a **rich help system** with:
1. **Extended descriptions** with before → after examples for each transform
2. **Context-aware SQL helper** showing table name, columns, and example queries
3. **Inline hints** that appear when configuring transforms

---

## Implementation

### 1. Extend TransformationDefinition with Examples

**File:** `src/lib/transformations.ts`

Add `examples` and `hints` fields to each transformation:

```typescript
export interface TransformationDefinition {
  id: TransformationType
  label: string
  description: string  // Keep short for UI
  icon: string
  requiresColumn: boolean
  params?: ParamDefinition[]
  // NEW FIELDS:
  examples?: {
    before: string
    after: string
  }[]
  hints?: string[]  // Tips for using this transform
}
```

**Example additions for key transforms:**

```typescript
{
  id: 'trim',
  label: 'Trim Whitespace',
  description: 'Remove leading and trailing spaces',
  icon: '✂️',
  requiresColumn: true,
  examples: [
    { before: '"  hello  "', after: '"hello"' },
    { before: '"  data  "', after: '"data"' },
  ],
  hints: ['Does not affect spaces between words'],
},
{
  id: 'collapse_spaces',
  label: 'Collapse Spaces',
  description: 'Replace multiple spaces with single space',
  icon: '⎵',
  requiresColumn: true,
  examples: [
    { before: '"hello    world"', after: '"hello world"' },
    { before: '"a   b   c"', after: '"a b c"' },
  ],
  hints: ['Also collapses tabs and newlines', 'Use with Trim for complete cleanup'],
},
{
  id: 'custom_sql',
  label: 'Custom SQL',
  description: 'Run any DuckDB SQL command',
  icon: '💻',
  requiresColumn: false,
  params: [{ name: 'sql', type: 'text', label: 'SQL Query' }],
  examples: [
    { before: 'UPDATE "${table}" SET col = UPPER(col)', after: 'Uppercase all values' },
    { before: 'ALTER TABLE "${table}" DROP COLUMN temp', after: 'Remove a column' },
  ],
  hints: [
    'Table name: "${table}" (auto-replaced)',
    'Column names must be quoted: "column_name"',
    'Use DuckDB SQL syntax',
  ],
},
```

### 2. Enhanced Transform Info Panel in CleanPanel

**File:** `src/components/panels/CleanPanel.tsx`

Replace the simple info box (lines 312-321) with a richer component:

```tsx
{/* Enhanced Transform Info */}
<div className="bg-muted/30 rounded-lg p-3 space-y-3">
  {/* Header */}
  <div>
    <h3 className="font-medium flex items-center gap-2">
      <span className="text-lg">{selectedTransform.icon}</span>
      {selectedTransform.label}
    </h3>
    <p className="text-sm text-muted-foreground mt-1">
      {selectedTransform.description}
    </p>
  </div>

  {/* Examples */}
  {selectedTransform.examples && selectedTransform.examples.length > 0 && (
    <div className="border-t border-border/50 pt-2">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Examples</p>
      <div className="space-y-1">
        {selectedTransform.examples.slice(0, 2).map((ex, i) => (
          <div key={i} className="flex items-center gap-2 text-xs font-mono">
            <span className="text-red-400/80">{ex.before}</span>
            <span className="text-muted-foreground">→</span>
            <span className="text-green-400/80">{ex.after}</span>
          </div>
        ))}
      </div>
    </div>
  )}

  {/* Hints */}
  {selectedTransform.hints && selectedTransform.hints.length > 0 && (
    <div className="border-t border-border/50 pt-2">
      <ul className="text-xs text-muted-foreground space-y-0.5">
        {selectedTransform.hints.map((hint, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="text-blue-400">•</span>
            {hint}
          </li>
        ))}
      </ul>
    </div>
  )}
</div>
```

### 3. Custom SQL Context Helper

**File:** `src/components/panels/CleanPanel.tsx`

Add a special section that appears only for Custom SQL, showing available context:

```tsx
{/* Custom SQL Context Helper */}
{selectedTransform.id === 'custom_sql' && activeTable && (
  <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3 space-y-3">
    {/* Table Info */}
    <div>
      <p className="text-xs font-medium text-slate-400 mb-1">Table</p>
      <code className="text-sm text-cyan-400 font-mono">"{activeTable.name}"</code>
      <span className="text-xs text-muted-foreground ml-2">
        ({activeTable.rowCount?.toLocaleString() || 0} rows)
      </span>
    </div>

    {/* Available Columns */}
    <div>
      <p className="text-xs font-medium text-slate-400 mb-1">
        Columns ({columns.length})
      </p>
      <div className="flex flex-wrap gap-1">
        {columns.slice(0, 10).map((col) => (
          <button
            key={col}
            type="button"
            onClick={() => {
              // Copy column reference to clipboard or insert into SQL input
              navigator.clipboard.writeText(`"${col}"`)
              toast.success(`Copied "${col}" to clipboard`)
            }}
            className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800
                       text-amber-400 hover:bg-slate-700 transition-colors"
          >
            "{col}"
          </button>
        ))}
        {columns.length > 10 && (
          <span className="text-xs text-muted-foreground self-center">
            +{columns.length - 10} more
          </span>
        )}
      </div>
    </div>

    {/* Quick Templates */}
    <div>
      <p className="text-xs font-medium text-slate-400 mb-1">Quick Templates</p>
      <div className="space-y-1">
        {[
          { label: 'Update column', sql: `UPDATE "${activeTable.name}" SET "column" = value` },
          { label: 'Add column', sql: `ALTER TABLE "${activeTable.name}" ADD COLUMN new_col VARCHAR` },
          { label: 'Delete rows', sql: `DELETE FROM "${activeTable.name}" WHERE condition` },
        ].map((template) => (
          <button
            key={template.label}
            type="button"
            onClick={() => setParams({ ...params, sql: template.sql })}
            className="w-full text-left text-xs px-2 py-1.5 rounded
                       bg-slate-800/50 hover:bg-slate-800 transition-colors"
          >
            <span className="text-slate-300">{template.label}</span>
            <code className="block text-[10px] text-slate-500 font-mono truncate">
              {template.sql}
            </code>
          </button>
        ))}
      </div>
    </div>
  </div>
)}
```

### 4. SQL Input Enhancement

Replace the basic text input for Custom SQL with a textarea that has syntax hints:

```tsx
{/* Custom SQL Input - Enhanced */}
{selectedTransform.id === 'custom_sql' ? (
  <div className="space-y-2">
    <Label>SQL Query</Label>
    <textarea
      value={params.sql || ''}
      onChange={(e) => setParams({ ...params, sql: e.target.value })}
      placeholder={`UPDATE "${activeTable?.name || 'table'}" SET "column" = value WHERE condition`}
      className="w-full h-24 px-3 py-2 text-sm font-mono rounded-md
                 bg-slate-900 border border-slate-700
                 text-cyan-300 placeholder:text-slate-600
                 focus:outline-none focus:ring-2 focus:ring-primary/50"
      spellCheck={false}
    />
    <p className="text-[10px] text-muted-foreground">
      Use DuckDB SQL syntax. Column names must be double-quoted.
    </p>
  </div>
) : (
  // Regular input for other params
  <Input ... />
)}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | Add `examples` and `hints` to all 19 transforms |
| `src/components/panels/CleanPanel.tsx` | Enhanced info panel, SQL context helper, textarea for SQL |

---

## Full Examples Data

Add these examples and hints to each transformation:

### Text Cleaning Group
| Transform | Examples | Hints |
|-----------|----------|-------|
| trim | `"  hello  "` → `"hello"` | Does not affect spaces between words |
| lowercase | `"HELLO"` → `"hello"` | Useful for case-insensitive matching |
| uppercase | `"hello"` → `"HELLO"` | Standard for codes like country/state |
| title_case | `"john doe"` → `"John Doe"` | Capitalizes first letter of each word |
| sentence_case | `"HELLO WORLD"` → `"Hello world"` | Only first character capitalized |
| remove_accents | `"café"` → `"cafe"` | Normalizes international characters |
| remove_non_printable | `"hello\t\n"` → `"hello"` | Removes tabs, newlines, control chars |
| collapse_spaces | `"a    b"` → `"a b"` | Also collapses tabs/newlines; pair with Trim |

### Find & Replace Group
| Transform | Examples | Hints |
|-----------|----------|-------|
| replace | `"foo"` → `"bar"` (find: foo) | Case-insensitive option available |
| replace_empty | `""` → `"N/A"` | Also replaces NULL values |

### Structure Group
| Transform | Examples | Hints |
|-----------|----------|-------|
| rename_column | Column: `"old"` → `"new"` | Does not affect data values |
| remove_duplicates | 100 rows → 95 rows | Compares all columns for uniqueness |
| split_column | `"a,b,c"` → `"a"`, `"b"`, `"c"` | Creates new columns; original preserved |
| combine_columns | `"John"` + `"Doe"` → `"John Doe"` | Delimiter customizable |
| cast_type | `"123"` → `123` (Integer) | Invalid values become NULL |

### Numeric Group
| Transform | Examples | Hints |
|-----------|----------|-------|
| unformat_currency | `"$1,234.56"` → `1234.56` | Removes $, commas, spaces |
| fix_negatives | `"(500)"` → `-500` | Accounting format to standard |
| pad_zeros | `"42"` → `"00042"` | Set target length; good for IDs |

### Dates Group
| Transform | Examples | Hints |
|-----------|----------|-------|
| standardize_date | `"01/15/2024"` → `"2024-01-15"` | Supports 10+ input formats |
| calculate_age | `"1990-05-15"` → `34` | Creates new "age" column |
| fill_down | `NULL` → `"previous value"` | Fills from row above |

### Advanced Group
| Transform | Examples | Hints |
|-----------|----------|-------|
| custom_sql | `UPDATE ... SET ...` | Full DuckDB SQL; use quoted identifiers |

---

## Verification

1. `npm run dev` - Start dev server
2. Upload any CSV file
3. Click each transformation and verify:
   - Examples appear in info panel with before → after format
   - Hints appear as bullet points
4. Click "Custom SQL" and verify:
   - Table name shown with row count
   - Clickable column badges (copy on click)
   - Quick template buttons populate the SQL input
   - Textarea with monospace font and placeholder
5. Run `npm run lint` to verify no errors

---

## Design Notes

- **Color scheme**: Red for "before", green for "after" (diff-like)
- **Monospace**: Examples and SQL use `font-mono` for clarity
- **Click-to-copy**: Column badges copy to clipboard for easy SQL construction
- **Progressive disclosure**: Examples/hints only show when transform selected
- **Consistent with existing UI**: Uses same muted backgrounds, border styles
