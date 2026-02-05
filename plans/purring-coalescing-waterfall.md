# Plan: Formula Builder Live Preview Panel

## Summary

Add a live preview panel to the Formula Builder tab, matching the existing preview UX in the Transforms tab. Also add a NULL-count warning for silent failures (e.g., division by zero producing NULLs) and improve DuckDB error messages.

**Key discovery:** ~90% of the infrastructure already exists. `TransformPreview` component, `generatePreviewSQL('excel_formula')`, and `isPreviewReady('excel_formula')` are all fully implemented. The work is **wiring + NULL warning + error humanization**.

## Files to Modify

| File | Change |
|------|--------|
| `src/components/panels/CleanPanel.tsx` | Add `formulaPreviewState`, render `<TransformPreview>` in formula tab, gate Apply on errors, reset preview on form reset |
| `src/lib/preview/transform-preview.ts` | Add `nullCount` to `PreviewResult`, add `nullCountSql` to excel_formula case, execute it in `generatePreview()`, add `humanizePreviewError()` |
| `src/components/clean/TransformPreview.tsx` | Add `nullCount` to `PreviewState`, pass through callback, render NULL warning badge |

## Step-by-Step

### Step 1: Add `formulaPreviewState` to CleanPanel (CleanPanel.tsx:75)

After the existing `formulaParams` state declaration:

```typescript
const [formulaPreviewState, setFormulaPreviewState] = useState<PreviewState | null>(null)
```

Import `PreviewState` is already imported (used by transforms tab on line 72).

### Step 2: Reset preview state in `resetFormulaForm()` (CleanPanel.tsx:188-191)

Add `setFormulaPreviewState(null)` to the existing reset function.

### Step 3: Render `<TransformPreview>` in Formula Builder tab (CleanPanel.tsx:885-887)

Insert between `</FormulaEditor>` (line 885) and the action buttons `<div>` (line 888):

```tsx
{activeTable && (
  <TransformPreview
    tableName={activeTable.name}
    column={undefined}
    transformType={'excel_formula' as TransformationType}
    params={formulaParams}
    sampleCount={10}
    onPreviewStateChange={setFormulaPreviewState}
  />
)}
```

**Why `column={undefined}`:** The `excel_formula` case in `isPreviewReady()` (line 608) skips the column requirement — formulas reference columns via `@column` syntax in `params.formula`.

**Why no param mapping needed:** `formulaParams` already uses the exact keys (`formula`, `outputMode`, `outputColumn`, `targetColumn`) that `generatePreviewSQL` reads at lines 454-456.

### Step 4: Gate Apply button on preview errors (CleanPanel.tsx:431-439)

Extend `isFormulaValid()` to check `formulaPreviewState`:

```typescript
// After existing checks, before `return true`:
if (formulaPreviewState?.isReady && !formulaPreviewState.isLoading) {
  if (formulaPreviewState.hasError) {
    return false
  }
}
```

**Design note:** Unlike the transforms tab which also blocks on `totalMatching === 0`, formula "new" mode always matches all rows (the count SQL is `SELECT COUNT(*) FROM table`). Only block on `hasError`.

### Step 5: Add `nullCount` to preview infrastructure (transform-preview.ts)

**5a.** Add `nullCount?: number` to `PreviewResult` interface (line 42).

**5b.** In `generatePreviewSQL` `excel_formula` case (lines 479-500), add `nullCountSql` to both return objects:

```typescript
nullCountSql: `SELECT COUNT(*) as count FROM ${table} WHERE (${sqlExpr}) IS NULL`
```

**5c.** In `generatePreview()` standard path (lines 569-581), conditionally run the null count query alongside the existing two:

```typescript
const [rows, countResult, ...optionalResults] = await Promise.all([
  query<{ original: string | null; result: string | null }>(sqlResult.sql),
  query<{ count: number }>(sqlResult.countSql),
  ...('nullCountSql' in sqlResult && sqlResult.nullCountSql
    ? [query<{ count: number }>(sqlResult.nullCountSql)]
    : []),
])

// In the return object, add:
nullCount: optionalResults[0]
  ? Number((optionalResults[0] as { count: number }[])[0]?.count ?? 0)
  : undefined,
```

### Step 6: Surface NULL warning in TransformPreview (TransformPreview.tsx)

**6a.** Add `nullCount?: number` to `PreviewState` interface (line 30).

**6b.** Pass it through the `onPreviewStateChange` callback (line 117-123):
```typescript
nullCount: preview?.nullCount,
```

**6c.** Render warning after the header's matching count (line 154), inside the header `<div>`:
```tsx
{preview && !isLoading && preview.nullCount !== undefined && preview.nullCount > 0 && (
  <div className="flex items-center gap-1.5 text-[10px] text-amber-500">
    <AlertTriangle className="w-3 h-3" />
    <span>{preview.nullCount.toLocaleString()} rows produce NULL</span>
  </div>
)}
```

Import `AlertTriangle` from `lucide-react` (add to existing import on line 9).

### Step 7: Humanize DuckDB error messages (transform-preview.ts)

Add a `humanizePreviewError()` helper and use it in the catch block (line 587):

| DuckDB Error Pattern | User-Friendly Message |
|---|---|
| `Referenced column...not found` | `Column "X" not found. Check your @column references.` |
| `Conversion Error` / `Could not convert` | `Type mismatch: formula result incompatible with column type.` |
| `division by zero` | `Division by zero in some rows. Consider wrapping with IFERROR().` |
| `Binder Error` | `Formula error. Check function names and column references.` |
| Messages > 120 chars | Truncate with `...` |

## Edge Cases Handled

- **Empty formula:** `isPreviewReady()` returns false → component renders nothing
- **Parse error:** `generatePreviewSQL` returns null → "No matching rows found"
- **Runtime SQL error:** Caught in try/catch → shown as error in red
- **Rapid typing:** 300ms debounce built into `TransformPreview`
- **Tab switching:** `handleTabChange` resets transforms tab; `formulaPreviewState` persists independently
- **"New" mode preview:** Shows `'Formula result'` as original column (no "before" for new columns) — this is existing behavior, acceptable

## Verification

1. `npm run build` — TypeScript check passes
2. `npm run dev` — Manual testing:
   - Upload CSV, switch to Formula Builder tab
   - Type `UPPER(@name)` with output mode "new", column "upper_name"
   - Verify preview appears with 10 sample rows
   - Type `@revenue / @count` where count has zeros → verify NULL warning appears
   - Type invalid formula → verify error shows (not raw DuckDB message)
   - Apply button disabled when preview has error
3. `npm run test` — Existing E2E tests still pass (no behavioral changes to transforms tab)
