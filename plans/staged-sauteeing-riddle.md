# Date/Datetime Handling Enhancement

## Problem Summary

Three related issues with date/datetime handling:

1. **Cast Type to DATE shows raw integers** - Grid displays `1608422400000` instead of `2020-12-20`
2. **Standardize Date outputs TEXT** - Returns VARCHAR instead of DATE type
3. **No TIMESTAMP support** - Neither Cast Type nor Standardize Date supports datetime

## Design Decision

**User preference:** Add TIMESTAMP to both Cast Type AND Standardize Date
- Cast Type gets TIMESTAMP as a target type option
- Standardize Date gets an "output type" parameter (Text/Date/Datetime)

## Root Cause Analysis

### Issue 1: Grid Display
- `DataGrid.tsx:996-998` renders all cells with `String(value)`
- DuckDB DATE comes as integer (days since epoch) via Arrow
- No type-aware formatting exists

### Issue 2: Standardize Date Output Type
- Uses `strftime()` which always returns VARCHAR
- Intentional for regulated industries (auditability)
- Users expecting DATE type are surprised

### Issue 3: Unix Timestamp Handling
- `TRY_CAST('1608422400000' AS DATE)` returns NULL (expects string format)
- Need `epoch_ms()` for Unix millisecond timestamps
- DuckDB docs: `epoch_ms(bigint)` converts Unix ms to TIMESTAMP

## Implementation Plan

### Phase 1: Fix Grid Display (Required)

**File:** `src/components/grid/DataGrid.tsx`

Add type-aware formatting in `getCellContent()`:

```typescript
function formatValueByType(value: unknown, columnType: string | undefined): string {
  if (value === null || value === undefined) return ''
  const baseType = columnType?.toUpperCase().replace(/\(.*\)/, '') ?? ''

  if (baseType === 'DATE') {
    // DuckDB DATE comes as days since epoch
    if (typeof value === 'number') {
      const date = new Date(value * 86400000)
      return date.toISOString().split('T')[0]
    }
    return String(value)
  }

  if (baseType.includes('TIMESTAMP')) {
    // DuckDB TIMESTAMP comes as microseconds since epoch
    if (typeof value === 'number' || typeof value === 'bigint') {
      const ms = Number(value) / 1000
      const date = new Date(ms)
      return date.toISOString().replace('T', ' ').slice(0, 19)
    }
    return String(value)
  }

  return String(value)
}
```

### Phase 2: Add TIMESTAMP to Cast Type

**Files:**
- `src/lib/commands/transform/tier3/cast-type.ts`
- `src/lib/transformations.ts`

Changes:
1. Add `'TIMESTAMP'` to `CastTargetType`
2. Add Unix timestamp detection for DATE/TIMESTAMP casts:
   - Sample column values
   - If avg value > 1e12: use `epoch_ms()` (milliseconds)
   - If avg value > 1e9: use `epoch()` (seconds)
   - Otherwise: use `TRY_CAST()`
3. Update UI definition in transformations.ts

### Phase 3: Enhance Standardize Date

**Files:**
- `src/lib/commands/transform/tier3/standardize-date.ts`
- `src/lib/commands/utils/date.ts`
- `src/lib/transformations.ts`

Add `outputType` parameter to UI:

```typescript
// In transformations.ts
{
  name: 'outputType',
  type: 'select',
  label: 'Output type',
  options: [
    { value: 'text', label: 'Text (VARCHAR)' },
    { value: 'date', label: 'Date (DATE)' },
    { value: 'timestamp', label: 'Datetime (TIMESTAMP)' },
  ],
  default: 'text',
}
```

Behavior:
- `'text'` (default): Current behavior via `strftime()` - returns VARCHAR
- `'date'`: Returns DATE type via `TRY_CAST(parseExpr AS DATE)`
- `'timestamp'`: Returns TIMESTAMP via `parseExpr` (TRY_STRPTIME returns TIMESTAMP)

## Files to Modify

| File | Change |
|------|--------|
| `src/components/grid/DataGrid.tsx` | Add `formatValueByType()` helper, use in `getCellContent()` |
| `src/lib/commands/transform/tier3/cast-type.ts` | Add TIMESTAMP type, Unix detection logic |
| `src/lib/commands/transform/tier3/standardize-date.ts` | Add `outputType` parameter |
| `src/lib/commands/utils/date.ts` | Add TIMESTAMP parse expression helper |
| `src/lib/transformations.ts` | Update UI definitions for both transforms |

## Backward Compatibility

- Grid formatting: Non-breaking (display only)
- Cast Type: TIMESTAMP is additive
- Standardize Date: `outputType` defaults to `'text'`

## Verification

1. Import CSV with Unix timestamp column (e.g., `1608422400000`)
2. Apply Cast Type → Date → Should show `2020-12-20` in grid
3. Apply Cast Type → Datetime → Should show `2020-12-20 00:00:00`
4. Apply Standardize Date with outputType=date → Column type should be DATE
5. E2E tests in `e2e/tests/` for date transformations

## Sources

- [DuckDB Date Format Functions](https://duckdb.org/docs/stable/sql/functions/dateformat)
- [DuckDB epoch_ms() Function](https://database.guide/a-quick-look-at-epoch_ms-in-duckdb/)
- [DuckDB Timestamp Types](https://duckdb.org/docs/stable/sql/data_types/timestamp)
