# Fix DuckDB-WASM `_setThrew` Error in Transformations

## Problem

When running Find & Replace transformations (and potentially others), the app crashes with:
```
ReferenceError: _setThrew is not defined
    at invoke_vii (duckdb-browser-mvp.worker.js:1:527505)
```

This occurs when using case-insensitive substring replacement.

## Root Cause

Two issues identified:

### 1. REGEXP_REPLACE Syntax Issue
The code uses inline `(?i)` flag combined with option parameter:
```sql
REGEXP_REPLACE(column, '(?i)pattern', 'replacement', 'g')
```

DuckDB prefers the flags in the options parameter:
```sql
REGEXP_REPLACE(column, 'pattern', 'replacement', 'gi')
```

### 2. DuckDB Version Mismatch
- **package.json**: `^1.29.0` (allows upgrades)
- **Installed**: `1.32.0` (3 versions newer)

The `_setThrew` error is an internal WASM runtime error that appeared in certain DuckDB-WASM versions when handling regex operations.

---

## Fix

### File: `src/lib/transformations.ts`

**Change 1** - Line ~505 (applyTransformation - case-insensitive contains):
```typescript
// Before:
const regexEscaped = escapedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
sql = `
  UPDATE "${tableName}" SET "${step.column}" =
  REGEXP_REPLACE("${step.column}", '(?i)${regexEscaped}', '${escapedReplace}', 'g')
`

// After:
const regexEscaped = escapedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
sql = `
  UPDATE "${tableName}" SET "${step.column}" =
  REGEXP_REPLACE("${step.column}", '${regexEscaped}', '${escapedReplace}', 'gi')
`
```

**Change 2** - Line ~321 (captureRowDetails - case-insensitive contains):
```typescript
// Before:
newValueExpression = `REGEXP_REPLACE(${column}, '(?i)${regexEscaped}', '${escapedReplace}', 'g')`

// After:
newValueExpression = `REGEXP_REPLACE(${column}, '${regexEscaped}', '${escapedReplace}', 'gi')`
```

---

### File: `package.json`

Pin DuckDB version to prevent future version-related issues:

```json
// Before:
"@duckdb/duckdb-wasm": "^1.29.0"

// After:
"@duckdb/duckdb-wasm": "1.29.0"
```

Then run `npm install` to downgrade from 1.32.0 to 1.29.0.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | Fix REGEXP_REPLACE syntax in 2 locations |
| `package.json` | Pin DuckDB version to 1.29.0 (remove `^` caret) |

---

## Verification

1. Start dev server: `npm run dev`
2. Upload a CSV file
3. Add Find & Replace transformation:
   - Match Type: Contains
   - Case Sensitive: No
   - Find: any text
   - Replace: any text
4. Click "Run Recipe"
5. Verify no `_setThrew` error and replacement works correctly

---

## References

- [DuckDB Regular Expressions Documentation](https://duckdb.org/docs/stable/sql/functions/regular_expressions)
- DuckDB REGEXP_REPLACE options: `'g'` (global), `'i'` (case-insensitive), `'gi'` (both)
