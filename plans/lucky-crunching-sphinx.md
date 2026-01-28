# Plan: Fix Diff Tables Appearing in Table Dropdown After Exiting Diff View

## Problem

When running diff comparisons on large datasets (≥100k rows), the diff engine exports temporary diff tables to Parquet files in OPFS for performance. When the user closes the diff view, cleanup should remove these files. However, cleanup can fail silently or the user may refresh before cleanup completes, leaving orphaned `_diff_*.parquet` files.

On next page load, these orphaned files get imported back into DuckDB and added to the tableStore, causing `_diff_*` tables to appear in the table dropdown.

## Root Cause Analysis

The persistence layer filters out internal tables (`original_*`, `snapshot_*`, `_timeline_*`) during restoration but **does NOT filter out `_diff_*` tables**.

**Affected Files:**
1. `src/hooks/usePersistence.ts` (line 125-135) - Missing `_diff_` filter
2. `src/lib/persistence/state-persistence.ts` (line 193-198) - Missing `_diff_` filter in reconciliation query
3. `src/lib/opfs/snapshot-storage.ts` - No startup cleanup for orphaned diff files

## Solution

### 1. Filter `_diff_*` tables during OPFS restoration

**File:** `src/hooks/usePersistence.ts` (line ~128)

Add `_diff_` to the filter list when restoring Parquet snapshots:

```typescript
.filter(name => {
  // Skip internal timeline tables
  if (name.startsWith('original_')) return false
  if (name.startsWith('snapshot_')) return false
  if (name.startsWith('_timeline_')) return false
  if (name.startsWith('_diff_')) return false  // ADD THIS
  return true
})
```

### 2. Filter `_diff_*` tables in DuckDB reconciliation

**File:** `src/lib/persistence/state-persistence.ts` (line ~193-198)

Add filter to exclude `_diff_*` tables from reconciliation:

```sql
SELECT table_name
FROM duckdb_tables()
WHERE NOT internal
AND table_name NOT LIKE '_timeline%'
AND table_name NOT LIKE '_audit%'
AND table_name NOT LIKE '_diff%'   -- ADD THIS
```

### 3. Add startup cleanup for orphaned diff Parquet files

**File:** `src/lib/opfs/snapshot-storage.ts`

Add new function `cleanupOrphanedDiffFiles()`:

```typescript
export async function cleanupOrphanedDiffFiles(): Promise<void> {
  // Scan snapshots directory for _diff_*.parquet files
  // Delete any found (they should never persist across sessions)
}
```

Call this function during startup cleanup in `usePersistence.ts` after `cleanupCorruptSnapshots()`.

## Files to Modify

| File | Change |
|------|--------|
| `src/hooks/usePersistence.ts` | Add `_diff_` filter at line ~128, call new cleanup function |
| `src/lib/persistence/state-persistence.ts` | Add `_diff_` filter at line ~197 |
| `src/lib/opfs/snapshot-storage.ts` | Add `cleanupOrphanedDiffFiles()` function |

## Verification

1. Import a large dataset (1M+ rows)
2. Run a diff comparison (will create `_diff_*.parquet` files)
3. Close diff view, then immediately refresh the page
4. Verify no `_diff_*` tables appear in the table dropdown
5. Verify original tables still appear correctly
