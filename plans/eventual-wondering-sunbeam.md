# Robust Diff Engine for All Transformations

## Problem Statement

The diff engine fails when comparing tables that have undergone transformations that modify schema or column types. Current fixes have been reactive (patching individual errors) rather than holistic.

## Research: Industry Best Practices

### Performance Considerations (Critical for 500K+ rows)

| Source | Finding |
|--------|---------|
| [DuckDB Schema Performance](https://duckdb.org/docs/stable/guides/performance/schema) | "Joining on BIGINT columns is ~1.8× faster than VARCHAR" |
| [SQLServerCentral](https://www.sqlservercentral.com/articles/comparing-different-data-types) | "Type conversion for every row is expensive - can be a very expensive bug for large tables" |
| [Redgate SQL Data Compare](https://documentation.red-gate.com/sdc/troubleshooting/common-issues/improving-the-performance-of-sql-data-compare) | "Use checksum comparison for large datasets that change infrequently" |
| [Oracle Docs](https://docs.oracle.com/database/121/SQLRF/sql_elements002.htm) | "Implicit type conversion can have negative impact on performance" |

### Key Insight
**Don't cast everything to VARCHAR** - only cast when types actually differ. This preserves native type performance for the common case.

## Transformation Impact Analysis

| Category | Transformations | Schema Impact |
|----------|----------------|---------------|
| **Value-only** | trim, lowercase, uppercase, title_case, remove_accents, remove_non_printable, replace, replace_empty, pad_zeros, fill_down | None - works fine |
| **Type changes** | cast_type, unformat_currency, fix_negatives, standardize_date | Column type changes (e.g., VARCHAR → INT, DATE) |
| **Add columns** | calculate_age, split_column | New columns appear |
| **Rename columns** | rename_column | Old column gone, new column appears |
| **Remove rows** | remove_duplicates, filter_empty | Row count changes |
| **Unpredictable** | custom_sql | Any schema change possible |

## Root Causes of Failures

### 1. Key Column Type Mismatch
```sql
-- Current: Fails if key column types differ
FULL OUTER JOIN "${tableB}" b ON a."id" = b."id"
-- If a.id is INT and b.id is VARCHAR, comparison fails
```

### 2. Key Column Missing
If user renamed key column (e.g., `id` → `user_id`), the selected key column doesn't exist in one table.

### 3. Value Comparison Type Mismatch
Already fixed by casting to VARCHAR (acceptable - runs after join filtering).

---

## Solution: Performance-Aware Schema-Agnostic Diff Engine

### Principle
1. **Validate inputs** before running queries (fail fast with helpful errors)
2. **Get column types** from both tables upfront
3. **Only cast when types differ** (preserve native performance)
4. **Better error messages** for remaining edge cases

### Implementation

#### Step 1: Get Column Types & Build Safe SELECT Projection

**Expand the column query to include types:**
```typescript
// Get names AND types from both tables
const colsA = await query<{ column_name: string; data_type: string }>(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = '${tableA}' ORDER BY ordinal_position`
)
const colsB = await query<{ column_name: string; data_type: string }>(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = '${tableB}' ORDER BY ordinal_position`
)

// Build type maps for quick lookup
const typeMapA = new Map(colsA.map((c) => [c.column_name, c.data_type]))
const typeMapB = new Map(colsB.map((c) => [c.column_name, c.data_type]))
const colsASet = new Set(typeMapA.keys())
const colsBSet = new Set(typeMapB.keys())

// Union of ALL columns from both tables (handles renamed columns)
const allColumns = [...new Set([...typeMapA.keys(), ...typeMapB.keys()])]
```

**Safe SELECT projection (handles schema drift for non-key columns):**
```typescript
// For each column: use actual column if exists, NULL if missing
// This handles renamed columns like email -> contact_email
const selectCols = allColumns
  .map((col) => {
    const colA = colsASet.has(col) ? `a."${col}"` : 'NULL'
    const colB = colsBSet.has(col) ? `b."${col}"` : 'NULL'
    return `${colA} as "a_${col}", ${colB} as "b_${col}"`
  })
  .join(', ')
```

> **Why this matters:** If a non-key column is renamed (e.g., `email` → `contact_email`), the old column exists only in B, the new column exists only in A. The SELECT must use NULL for missing columns to avoid "Column not found" errors.

#### Step 2: Validate Key Columns Exist in Both Tables

**Fail fast with helpful error:**
```typescript
const missingInA = keyColumns.filter((c) => !colsASet.has(c))
const missingInB = keyColumns.filter((c) => !colsBSet.has(c))

if (missingInA.length > 0 || missingInB.length > 0) {
  const missingInfo = []
  if (missingInA.length > 0) {
    missingInfo.push(`Missing in current table: ${missingInA.join(', ')}`)
  }
  if (missingInB.length > 0) {
    missingInfo.push(`Missing in original table: ${missingInB.join(', ')}`)
  }
  throw new Error(
    `Key column(s) not found in both tables. ${missingInfo.join('. ')}. ` +
    `This can happen after renaming columns. Please select different key columns.`
  )
}
```

#### Step 3: Smart JOIN Condition (Only Cast When Types Differ)

**Conservative type compatibility (avoid precision edge cases):**
```typescript
// Helper: STRICT type compatibility check
// Only return true for types that DuckDB can safely compare without precision loss
function typesCompatible(typeA: string, typeB: string): boolean {
  const a = typeA.toUpperCase()
  const b = typeB.toUpperCase()

  // Exact match - always safe
  if (a === b) return true

  // Pure INTEGER family - safe to compare
  const intTypes = ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT']
  const aIsInt = intTypes.some((t) => a.includes(t))
  const bIsInt = intTypes.some((t) => b.includes(t))
  if (aIsInt && bIsInt) return true

  // Pure FLOAT family - safe to compare
  const floatTypes = ['FLOAT', 'DOUBLE', 'REAL']
  const aIsFloat = floatTypes.some((t) => a.includes(t))
  const bIsFloat = floatTypes.some((t) => b.includes(t))
  if (aIsFloat && bIsFloat) return true

  // IMPORTANT: Do NOT mix INTEGER and FLOAT - precision issues
  // IMPORTANT: Do NOT mix DATE and TIMESTAMP - implicit cast can fail
  // For diff accuracy, fallback to VARCHAR for any mixed types
  return false
}

// Build join condition: only cast if types are incompatible
const joinCondition = keyColumns
  .map((c) => {
    const typeA = typeMapA.get(c) || 'VARCHAR'
    const typeB = typeMapB.get(c) || 'VARCHAR'
    if (typesCompatible(typeA, typeB)) {
      // Native comparison (fast path - 1.8x faster for numeric)
      return `a."${c}" = b."${c}"`
    } else {
      // VARCHAR fallback (safe path - handles type mismatches)
      return `CAST(a."${c}" AS VARCHAR) = CAST(b."${c}" AS VARCHAR)`
    }
  })
  .join(' AND ')
```

> **Why conservative?** DuckDB is strict about implicit conversions. Mixing INTEGER with FLOAT can cause precision issues. Mixing DATE with TIMESTAMP can fail. For a diff tool, correctness > performance, so we fallback to VARCHAR for any uncertainty.

#### Step 4: Smart ORDER BY (Same Logic)

```typescript
const keyOrderBy = keyColumns
  .map((c) => {
    const typeA = typeMapA.get(c)
    const typeB = typeMapB.get(c)
    if (typeA && typeB && typesCompatible(typeA, typeB)) {
      return `COALESCE("a_${c}", "b_${c}")`
    } else {
      return `COALESCE(CAST("a_${c}" AS VARCHAR), CAST("b_${c}" AS VARCHAR))`
    }
  })
  .join(', ')
```

#### Step 5: Better Error Messages

**Parse DuckDB errors and provide actionable feedback:**
```typescript
try {
  await execute(createTempTableQuery)
} catch (error) {
  const errMsg = error instanceof Error ? error.message : String(error)

  if (errMsg.includes('does not have a column')) {
    const match = errMsg.match(/column named "([^"]+)"/)
    const colName = match?.[1] || 'unknown'
    throw new Error(
      `Column "${colName}" not found. This can happen after renaming or removing columns. ` +
      `Please select different key columns.`
    )
  }

  if (errMsg.includes('Conversion Error') || errMsg.includes('Could not convert')) {
    throw new Error(
      `Type mismatch between tables. This can happen after cast_type or standardize_date. ` +
      `The comparison will still work but may show all rows as modified.`
    )
  }

  console.error('Diff temp table creation failed:', error)
  throw new Error(`Diff comparison failed: ${errMsg}`)
}
```

#### Step 6: Mutex Integration

**The diff operation is the heaviest query - ensure proper locking:**
```typescript
export async function runDiff(...): Promise<DiffConfig> {
  // withDuckDBLock pauses memory polling (UI optimization)
  // Internal queries use withMutex (query serialization)
  return withDuckDBLock(async () => {
    // ... all diff logic here
    // Note: query() and execute() already use withMutex internally
  })
}
```

> **Why this matters:** The diff FULL OUTER JOIN on 500K+ rows is the most CPU/memory intensive operation in the app. Without proper locking, concurrent memory polling or other queries can trigger the "Observer Effect" crash that was fixed by the EH bundle + mutex.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/diff-engine.ts` | Get column types, validate keys, smart casting, better errors |

---

## Implementation Checklist

1. [ ] Expand column query to include `data_type` from information_schema
2. [ ] Build type maps (`typeMapA`, `typeMapB`) for both tables
3. [ ] Build safe SELECT projection using NULL for missing columns (schema drift handling)
4. [ ] Add key column existence validation with helpful error message
5. [ ] Add conservative `typesCompatible()` helper (INT family, FLOAT family, exact match)
6. [ ] Update JOIN condition to only cast when types incompatible
7. [ ] Update ORDER BY to only cast when types incompatible
8. [ ] Improve error messages with DuckDB error parsing
9. [ ] Verify `withDuckDBLock` wrapper is still in place (mutex integration)
10. [ ] Verify build passes (`npm run build`)
11. [ ] Test with transformation sequences (see verification matrix below)

---

## Performance Analysis

| Scenario | Before (Cast All) | After (Smart Cast) |
|----------|-------------------|-------------------|
| Same types (common case) | 1.8x slower | Native speed |
| Different types | VARCHAR cast | VARCHAR cast |
| 500K rows, BIGINT key | ~1.8x overhead | No overhead |

The smart casting approach maintains performance for the **common case** (no type changes) while still handling edge cases safely.

---

## Verification

Test these scenarios after implementation:

1. **Basic diff (500K rows)** - Compare unchanged tables → Should be fast
2. **After calculate_age** - New `age` column → Shows as schema change
3. **After cast_type** - VARCHAR→INT key column → Falls back to VARCHAR cast
4. **After standardize_date** - Date format changed → Works (shared columns cast)
5. **After rename_column** - Old key column missing → Clear error message
6. **After split_column** - Multiple new columns → Shows as schema change
7. **After remove_duplicates** - Row count differs → Shows removed rows

Each should either:
- Complete successfully with proper diff display
- Fail with a **specific, actionable error message**

---

## Summary

**Performance-first approach:**
1. Query column types from both tables upfront
2. Only cast to VARCHAR when types are incompatible
3. Use native types for the common case (1.8x faster for joins)
4. Validate key columns exist before running expensive queries
5. Provide clear, actionable error messages for edge cases

This makes the diff engine robust against **any transformation sequence** while maintaining performance on large datasets.
