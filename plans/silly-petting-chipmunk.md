# Fix Post-Implementation Diff Issues

## Status Update
✅ **Previous fix (duckdb_schema Binder Error) implemented successfully**

However, **5 new issues** surfaced after implementation:

1. ❌ **Memory increase**: 2.5GB → 2.7GB during diff operations
2. ⚠️ **Accessibility warnings**: Missing Description/aria-describedby (low priority)
3. ❌ **UI shows internal column**: "1 column removed: duckdb_schema" visible to user
4. 🔴 **CRITICAL: Can't exit diff**: OPFS file locking error prevents closing diff view
5. 🔴 **CRITICAL: Missing removed rows**: remove_duplicates deleted 9,783 rows, but diff shows 0 removed

This plan addresses all 5 issues with priority on critical (#4, #5) issues first.

---

## Issue #4 🔴 CRITICAL: Can't Exit Diff (OPFS File Locking)

### Problem
User cannot close diff view. Clicking back button causes error:
```
Error: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle':
Access Handles cannot be created if there is another open Access Handle or
Writable stream associated with the same file: original_xt563ze_part_0.parquet

[Diff] Resolved parquet:original_xt563ze to read_parquet('original_xt563ze_part_*.parquet') with 0 chunks
```

### Root Cause: Re-registration Without Cleanup

**File:** `src/lib/diff-engine.ts`

`resolveTableRef()` is called **multiple times** per diff session without unregistering files:

1. **Line 286**: First call during `runDiff()` - registers all 5 Parquet chunks
2. **Line 597**: Second call in `fetchDiffPage()` - **attempts to re-register same files**
3. **Line 743**: Third call in fallback path - more re-registration attempts

**DuckDB OPFS Behavior:**
- `registerFileHandle()` creates a `SyncAccessHandle` (OS-level file lock)
- Handle persists until `dropFile()` is called
- Calling `registerFileHandle()` twice on same file → "Access Handles cannot be created" error

**Why "0 chunks" appears:**
- Second `resolveTableRef()` call tries to register `original_xt563ze_part_0.parquet`
- Registration fails with file locking error
- Try-catch at line 87-89 silently breaks loop
- `partIndex` stays 0 → logs "with 0 chunks"
- Later query fails because files not registered

### Solution for Issue #4

**Approach:** Track registered files in module-level state to prevent re-registration

---

## Issue #5 🔴 CRITICAL: No Removed Rows Shown

### Problem
- User ran `remove_duplicates` on 1M row table
- Original: 1,010,000 rows → Current: 1,000,217 rows (9,783 removed)
- Diff shows 0 removed rows
- Expected: 9,783 rows highlighted in red

### Root Cause: Key-Based JOIN Limitation

**File:** `src/lib/diff-engine.ts:447-453`

```typescript
CASE
  WHEN ${keyColumns.map((c) => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
  WHEN ${keyColumns.map((c) => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
  WHEN ${sharedColModificationExpr} THEN 'modified'
  ELSE 'unchanged'
END as diff_status
FROM ${sourceTableExpr} a
FULL OUTER JOIN "${tableB}" b ON ${joinCondition}  -- User-selected key (BillingID)
```

**The Problem:**
1. User selected `BillingID` as key column
2. `remove_duplicates` removes rows with duplicate data, but keeps one copy of each key
3. FULL OUTER JOIN matches ALL original rows with same BillingID to the kept row

**Example:**
```
Original:
- Row A: BillingID=1, Name=Alice, _cs_id=uuid-A
- Row B: BillingID=1, Name=Alice, _cs_id=uuid-B (duplicate)

Current (after remove_duplicates):
- Row A: BillingID=1, Name=Alice, _cs_id=uuid-A

FULL OUTER JOIN ON BillingID:
- original.Row A + current.Row A → b.BillingID NOT NULL → 'unchanged' ✓
- original.Row B + current.Row A → b.BillingID NOT NULL → 'unchanged' ❌ WRONG!
```

Both rows match because they share the same BillingID. The CASE logic checks if `b.BillingID IS NULL`, which is FALSE for both.

**Why This is Fundamentally Broken:**
- The diff assumes **unique keys** in both tables
- `remove_duplicates` violates this assumption (multiple rows with same key in original)
- Key-based matching can't distinguish "duplicate removed" from "row unchanged"

### Solution for Issue #5

**Approach:** Use `_cs_id` for row identity matching instead of only user-selected keys

---

## Issue #3: Internal Column Shown in UI

### Problem
Diff UI shows: "1 column removed: duckdb_schema"
This is a DuckDB internal metadata column and shouldn't be visible to users.

### Root Cause: Incomplete Filtering

**File:** `src/lib/diff-engine.ts:396-399`

```typescript
const newColumns = [...colsASet].filter((c) => !colsBSet.has(c))
const removedColumns = [...colsBSet].filter((c) => !colsASet.has(c))
```

These arrays are NOT filtered for internal columns, but `allColumns` IS:

```typescript
// Line 406
const allColumns = [
  ...new Set([...colsA.map((c) => c.column_name), ...colsB.map((c) => c.column_name)]),
].filter(c => !isInternalColumn(c))  // ← Filtered here
```

**Data Flow:**
1. `newColumns` and `removedColumns` include `duckdb_schema`
2. Passed to `setDiffConfig()` in DiffView.tsx
3. Displayed in schema changes banner (lines 384-409)

---

## Issue #1: Memory Usage Increase

### Problem
Memory usage increased from 2.5GB → 2.7GB during diff operations (+200MB)

### Root Cause: Filter Overhead on Large JOINs

**File:** `src/lib/diff-engine.ts:406`

```typescript
].filter(c => !isInternalColumn(c))  // ← Recently added
```

**Why This Causes Memory Spike:**
1. `isInternalColumn()` now checks `.startsWith('duckdb_')` for every column
2. For 1M × 1M row FULL OUTER JOIN: Additional intermediate array allocations
3. More columns in schema → longer SQL strings → larger Arrow result sets
4. DuckDB buffer fragmentation from Set operations

---

## Issue #2: Accessibility Warnings (Low Priority)

### Problem
Console warnings:
```
Warning: Missing `Description` or `aria-describedby={undefined}` for {DialogContent}.
```

### Root Cause
Radix UI DialogContent components missing accessibility attributes.

### Solution
Add `<DialogDescription>` or `aria-describedby` to dialog components.
**Priority: Low** - Cosmetic, doesn't block functionality.

---

## Implementation Priority

### Phase 1: Critical Blockers (Implement First)
1. **Issue #4 (File Locking)** - User can't close diff
2. **Issue #5 (Missing Removed Rows)** - Core diff logic broken

### Phase 2: UI Correctness
3. **Issue #3 (Internal Column in UI)** - Wrong data displayed

### Phase 3: Optimizations
4. **Issue #1 (Memory Usage)** - Performance improvement
5. **Issue #2 (Accessibility)** - Code quality

---

## Detailed Implementation Steps

### Step 1: Fix File Locking (Issue #4) - CRITICAL

**Goal:** Prevent re-registration of Parquet files during diff session

**Changes in `src/lib/diff-engine.ts`:**

1. **Add state tracking at module level (after imports):**
```typescript
// Track which Parquet snapshots are currently registered
const registeredParquetSnapshots = new Set<string>()
```

2. **Modify `resolveTableRef()` to skip re-registration (line 15-103):**
```typescript
async function resolveTableRef(tableName: string): Promise<string> {
  if (!tableName.startsWith('parquet:')) {
    return `"${tableName}"`
  }

  const snapshotId = tableName.replace('parquet:', '')

  // Skip registration if already done
  if (registeredParquetSnapshots.has(snapshotId)) {
    console.log(`[Diff] Parquet snapshot ${snapshotId} already registered, skipping`)

    // Check if chunked or single file to return correct expression
    const db = await initDuckDB()
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

    try {
      await snapshotsDir.getFileHandle(`${snapshotId}_part_0.parquet`, { create: false })
      return `read_parquet('${snapshotId}_part_*.parquet')`  // Chunked
    } catch {
      return `read_parquet('${snapshotId}.parquet')`  // Single file
    }
  }

  // ... existing registration logic ...

  // Mark as registered after successful registration
  registeredParquetSnapshots.add(snapshotId)

  // Return appropriate expression based on chunk count
  return isChunked ? `read_parquet('${snapshotId}_part_*.parquet')` : `read_parquet('${snapshotId}.parquet')`
}
```

3. **Update `cleanupDiffSourceFiles()` to clear state (line 759-793):**
```typescript
export async function cleanupDiffSourceFiles(sourceTableName: string): Promise<void> {
  // ... existing cleanup logic ...

  // Remove from registered set
  if (sourceTableName.startsWith('parquet:')) {
    const snapshotId = sourceTableName.replace('parquet:', '')
    registeredParquetSnapshots.delete(snapshotId)
    console.log(`[Diff] Cleared registration state for ${snapshotId}`)
  }
}
```

**Risk:** Low - Adds safety guard, doesn't change core logic

---

### Step 2: Fix Missing Removed Rows (Issue #5) - CRITICAL

**Goal:** Use context-aware matching strategy based on diff mode

✅ **USER APPROVED:**
- Compare with Preview → Row-based (`_cs_id`)
- Compare Two Tables → Key-based (user-selected keys)

**Changes in `src/lib/diff-engine.ts`:**

1. **Update `runDiff()` function signature to accept diff mode (around line 238):**
```typescript
export async function runDiff(
  tableA: string,
  tableB: string,
  keyColumns: string[],
  diffMode: 'preview' | 'two-tables' = 'two-tables'  // NEW parameter
): Promise<DiffResult>
```

2. **Choose JOIN strategy based on mode (line 440-453):**
```typescript
// Determine JOIN condition based on diff mode
const joinCondition = diffMode === 'preview'
  ? `a."_cs_id" = b."_cs_id"`  // Row-based for preview
  : keyColumns.map(c => `a."${c}" = b."${c}"`).join(' AND ')  // Key-based for two-tables

// Determine CASE logic based on diff mode
const caseLogic = diffMode === 'preview'
  ? `
    CASE
      WHEN a."_cs_id" IS NULL THEN 'added'
      WHEN b."_cs_id" IS NULL THEN 'removed'
      WHEN ${sharedColModificationExpr} THEN 'modified'
      ELSE 'unchanged'
    END as diff_status
  `
  : `
    CASE
      WHEN ${keyColumns.map(c => `a."${c}" IS NULL`).join(' AND ')} THEN 'added'
      WHEN ${keyColumns.map(c => `b."${c}" IS NULL`).join(' AND ')} THEN 'removed'
      WHEN ${sharedColModificationExpr} THEN 'modified'
      ELSE 'unchanged'
    END as diff_status
  `

const createTempTableQuery = `
  CREATE TEMP TABLE "${diffTableName}" AS
  SELECT
    COALESCE(a."_cs_id", b."_cs_id") as row_id,
    a."_cs_id" as a_row_id,
    b."_cs_id" as b_row_id,
    ${caseLogic}
  FROM ${sourceTableExpr} a
  FULL OUTER JOIN "${tableB}" b ON ${joinCondition}
`
```

3. **Update DiffView.tsx to pass diff mode (around line 160-180):**
```typescript
// In "Compare with Preview" handler:
const result = await runDiff(sourceTableExpr, tableName, [keyColumn], 'preview')

// In "Compare Two Tables" handler:
const result = await runDiff(tableAName, tableBName, keyColumns, 'two-tables')
```

**Benefits:**
- ✅ Best of both worlds: Row-based for transformations, key-based for reconciliation
- ✅ No breaking changes for "Compare Two Tables" workflow
- ✅ Fixes remove_duplicates detection in "Compare with Preview"

---

### Step 3: Filter Internal Columns from UI (Issue #3)

**Goal:** Hide `duckdb_schema` and other internal columns from diff UI

**Changes in `src/lib/diff-engine.ts` (line 396-399):**

```typescript
// BEFORE:
const newColumns = [...colsASet].filter((c) => !colsBSet.has(c))
const removedColumns = [...colsBSet].filter((c) => !colsASet.has(c))

// AFTER:
const newColumns = [...colsASet]
  .filter((c) => !colsBSet.has(c))
  .filter((c) => !isInternalColumn(c))
const removedColumns = [...colsBSet]
  .filter((c) => !colsASet.has(c))
  .filter((c) => !isInternalColumn(c))
```

**Risk:** Very low - Purely cosmetic filtering

---

### Step 4: Optimize Memory Usage (Issue #1)

**Goal:** Reduce 200MB memory spike during diff

**Approach:** Filter columns earlier to reduce Set/array allocations

**Changes in `src/lib/diff-engine.ts`:**

1. **Filter `colsA` and `colsB` immediately after fetch (line 330-343):**
```typescript
// BEFORE:
const colsA = await query<{ column_name: string; data_type: string }>(`...`)
const colsB = await query<{ column_name: string; data_type: string }>(`...`)

// AFTER:
const colsAAll = await query<{ column_name: string; data_type: string }>(`...`)
const colsBAll = await query<{ column_name: string; data_type: string }>(`...`)
const colsA = colsAAll.filter(c => !isInternalColumn(c.column_name))
const colsB = colsBAll.filter(c => !isInternalColumn(c.column_name))
```

2. **Remove filter from `allColumns` (line 406) since already filtered:**
```typescript
// BEFORE:
const allColumns = [
  ...new Set([
    ...colsA.map((c) => c.column_name),
    ...colsB.map((c) => c.column_name),
  ]),
].filter(c => !isInternalColumn(c))  // Remove this line

// AFTER:
const allColumns = [
  ...new Set([
    ...colsA.map((c) => c.column_name),
    ...colsB.map((c) => c.column_name),
  ]),
]  // Already filtered at source
```

**Benefits:**
- Smaller Sets → less memory
- Single filter pass → less CPU
- Cleaner code

---

## Critical Files to Modify

1. **`src/lib/diff-engine.ts`** (all fixes)
   - Line 0-10: Add `registeredParquetSnapshots` state
   - Line 15-103: `resolveTableRef()` - Add registration check
   - Line 330-343: Filter `colsA`/`colsB` early
   - Line 396-399: Filter `newColumns`/`removedColumns`
   - Line 406: Remove redundant filter
   - Line 446-453: Change CASE logic to use `_cs_id`
   - Line 759-793: Clear registration state in cleanup

2. **`src/components/diff/DiffView.tsx`** (low priority)
   - Add `<DialogDescription>` for accessibility

---

## Verification & Testing

### Test Case 1: File Locking Fixed (Issue #4)
1. Upload 1M row CSV
2. Run any transformation
3. Open diff (Compare with Preview)
4. **Try to close diff** - Should work without errors
5. Open diff again - Should work without "0 chunks" error
6. Console should show: "Parquet snapshot already registered, skipping"

### Test Case 2: Removed Rows Shown (Issue #5)
1. Upload CSV with duplicates (use test data with 10K duplicates)
2. Run remove_duplicates transformation
3. Open diff (Compare with Preview)
4. **Expected:** Diff shows removed rows count matching duplicate count (9,783)
5. **Expected:** Grid shows removed rows highlighted in red
6. Console should NOT show "0 removed"

### Test Case 3: No Internal Columns in UI (Issue #3)
1. Run any diff
2. Check diff header banner
3. **Expected:** Should NOT show "duckdb_schema" or other internal columns
4. **Expected:** Only user-visible columns shown in "columns added/removed" list

### Test Case 4: Memory Usage Normal (Issue #1)
1. Open browser DevTools → Performance Monitor
2. Load 1M row table
3. Run transformation + diff
4. **Expected:** Peak memory ≤ 2.6GB (down from 2.7GB)
5. **Expected:** Memory returns to ~2.0GB after diff closes

---

## User Decision: Context-Aware Diff Strategy (Issue #5) ✅

**Approved Strategy:**
- **"Compare with Preview" mode** → Row-based matching (`_cs_id`)
  - Use case: Comparing original snapshot with transformed table (same source, different states)
  - ✅ Detects row deletions from remove_duplicates
  - ✅ Detects modifications to same rows

- **"Compare Two Tables" mode** → Key-based matching (user-selected keys)
  - Use case: Comparing two different source tables
  - ✅ Detects "same key, different data" across different tables
  - ✅ Useful for reconciliation workflows

**Implementation:** Check diff mode in `runDiff()` and choose JOIN strategy accordingly.
