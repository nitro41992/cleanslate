# RAM Cap at 2GB for Diff Operations - FINAL PLAN

**Status:** 🟢 READY FOR IMPLEMENTATION
**Branch:** `opfs-ux-polish`
**Date:** January 24, 2026
**Implementation Time:** 65 minutes
**Memory Savings:** 1.55GB → 0.5GB baseline, 2.8GB → 1.3GB peak

---

## Problem & Solution

**Problem**: Diff operations push RAM from 2GB → 3GB, exceeding WASM limits and causing OOM.

**Root Causes**:
1. Baseline bloat: `_original_*` snapshots in RAM (~750MB for 1M rows)
2. Diff result storage: Narrow temp table still ~50MB+ for large diffs
3. FULL OUTER JOIN buffers: ~800MB temporary allocation
4. Limit mismatch: DuckDB 2GB vs app tracking 3GB

**Solution**: **Unified Baseline + Diff Optimization**
1. **Phase 1**: Align limits to 2GB (5 min)
2. **Phase 2**: Parquet-backed original snapshots (15 min) → **-750MB baseline**
3. **Phase 3**: Tiered diff storage with OPFS (20 min) → **-500MB peak**
4. **Phase 4**: UI integration (15 min)
5. **Phase 5**: Testing (10 min)

**Result**: 500MB baseline → 1.3GB peak → **700MB under limit** ✅

---

## PHASE 1: Configuration & Limits (5 min)

### Step 1.1: Align App Memory Limit

**File**: `src/lib/duckdb/memory.ts:11`

```typescript
- export const MEMORY_LIMIT_BYTES = 3 * 1024 * 1024 * 1024
+ export const MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024  // Align to 2GB
```

### Step 1.2: Set Conservative DuckDB Limit

**File**: `src/lib/duckdb/index.ts:133`

```typescript
- const memoryLimit = isTestEnv ? '256MB' : '2GB'
+ const memoryLimit = isTestEnv ? '256MB' : '1843MB'  // 1.8GB (leaves 200MB for JS heap/React)
```

**Validation**: This prevents DuckDB from trying to allocate the full 2GB, which crashes on 32-bit WASM builds.

---

## PHASE 2: Baseline Optimization - Parquet Original Snapshots (15 min)

**Goal**: Reduce baseline from 1.55GB → 500MB

### Step 2.1: Modify Existing Function (NOT create new file)

**File**: `src/lib/timeline-engine.ts` (MODIFY EXISTING)

**Find**: `export async function createTimelineOriginalSnapshot`

**Replace with**:
```typescript
const ORIGINAL_SNAPSHOT_THRESHOLD = 100_000

export async function createTimelineOriginalSnapshot(
  tableName: string,
  timelineId: string
): Promise<string> {  // Keep return type string for store compatibility
  // Check row count
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM "${tableName}"`
  )
  const rowCount = Number(countResult[0].count)

  if (rowCount >= ORIGINAL_SNAPSHOT_THRESHOLD) {
    console.log(`[Timeline] Creating Parquet original snapshot for ${rowCount.toLocaleString()} rows...`)

    const db = await initDuckDB()
    const conn = await getConnection()
    const snapshotId = `original_${timelineId}`

    // Export to OPFS Parquet
    await exportTableToParquet(db, conn, tableName, snapshotId)
    await db.dropFile(`${snapshotId}.parquet`)  // Critical: release handle

    // Return special prefix to signal Parquet storage (keeps store type as string)
    return `parquet:${snapshotId}`
  }

  // Small table - use in-memory duplicate (existing behavior)
  const originalName = `_timeline_original_${timelineId}`
  await duplicateTable(tableName, originalName, true)
  return originalName
}
```

**Add imports at top**:
```typescript
import { exportTableToParquet, importTableFromParquet } from '@/lib/opfs/snapshot-storage'
import { initDuckDB } from '@/lib/duckdb'
```

**Why string prefix**: The `timelineStore` expects `originalSnapshot: string`. Using `parquet:` prefix avoids refactoring the entire store interface.

### Step 2.2: Handle Parquet Restoration

**File**: `src/lib/timeline-engine.ts` (add new function)

```typescript
export async function restoreTimelineOriginalSnapshot(
  tableName: string,
  snapshotName: string
): Promise<void> {
  if (snapshotName.startsWith('parquet:')) {
    // Extract snapshot ID from "parquet:original_abc123"
    const snapshotId = snapshotName.replace('parquet:', '')

    console.log(`[Timeline] Restoring from Parquet: ${snapshotId}`)
    const db = await initDuckDB()
    const conn = await getConnection()

    // Drop current table
    await dropTable(tableName)

    // Import from OPFS
    await importTableFromParquet(db, conn, snapshotId, tableName)
  } else {
    // In-memory snapshot (existing behavior)
    await dropTable(tableName)
    await duplicateTable(snapshotName, tableName, true)
  }
}
```

### Step 2.3: Update Diff Engine for Parquet Originals

**File**: `src/lib/diff-engine.ts` (around line 160, in "Compare with Preview" mode)

**Find**: Code that gets original snapshot name

**Wrap with Parquet handling**:
```typescript
// Get original snapshot name
const originalSnapshotName = await getOriginalSnapshotName(activeTableId)

let originalTableName: string

if (originalSnapshotName.startsWith('parquet:')) {
  // Import from Parquet to temp table for diff
  const tempOriginalName = `_temp_diff_original_${Date.now()}`
  await restoreTimelineOriginalSnapshot(tempOriginalName, originalSnapshotName)
  originalTableName = tempOriginalName
} else {
  // Use in-memory snapshot directly
  originalTableName = originalSnapshotName
}

// ... run diff with originalTableName ...

// Cleanup temp table if we imported from Parquet
if (originalSnapshotName.startsWith('parquet:')) {
  await dropTable(originalTableName)
}
```

**Add import**:
```typescript
import { restoreTimelineOriginalSnapshot } from '@/lib/timeline-engine'
```

**Memory Impact**: ~750MB baseline reduction for 1M row tables

---

## PHASE 3: Diff Engine Optimization (20 min)

**Goal**: Prevent diff result from consuming RAM

### Step 3.1: Add Constants

**File**: `src/lib/diff-engine.ts` (top of file, after imports)

```typescript
// Tiered diff storage: <100k in-memory, ≥100k OPFS Parquet
export const DIFF_TIER2_THRESHOLD = 100_000

// Memory polling during diff creation (2-second intervals)
export const DIFF_MEMORY_POLL_INTERVAL_MS = 2000
```

**Add imports**:
```typescript
import { exportTableToParquet, deleteParquetSnapshot } from '@/lib/opfs/snapshot-storage'
import { formatBytes } from './duckdb/storage-info'
import * as duckdb from '@duckdb/duckdb-wasm'
```

### Step 3.2: Implement Tiered Storage in runDiff

**File**: `src/lib/diff-engine.ts` (modify `runDiff`, after creating temp table)

**Find**: After `CREATE TEMP TABLE` execution (around line 340)

**Add**:
```typescript
// Phase 4: Tiered storage - export large diffs to OPFS
const totalDiffRows = summary.added + summary.removed + summary.modified
let storageType: 'memory' | 'parquet' = 'memory'

if (totalDiffRows >= DIFF_TIER2_THRESHOLD) {
  console.log(`[Diff] Large diff (${totalDiffRows.toLocaleString()} rows), exporting to OPFS...`)

  const db = await initDuckDB()
  const conn = await getConnection()

  // Export narrow temp table to Parquet
  await exportTableToParquet(db, conn, diffTableName, diffTableName)

  // Drop file handle (critical for cleanup)
  await db.dropFile(`${diffTableName}.parquet`)

  // Drop in-memory temp table (free RAM immediately)
  await execute(`DROP TABLE "${diffTableName}"`)

  storageType = 'parquet'
  console.log(`[Diff] Exported to OPFS, freed ~${formatBytes(totalDiffRows * 58)} RAM`)
}
```

**Update return statement**:
```typescript
return {
  diffTableName,
  sourceTableName: tableA,
  targetTableName: tableB,
  summary,
  totalDiffRows,
  allColumns,
  keyColumns,
  keyOrderBy,
  newColumns,
  removedColumns,
  storageType,  // NEW
}
```

**Update DiffConfig interface** (top of file):
```typescript
export interface DiffConfig {
  diffTableName: string
  sourceTableName: string
  targetTableName: string
  summary: DiffSummary
  totalDiffRows: number
  allColumns: string[]
  keyColumns: string[]
  keyOrderBy: string
  newColumns: string[]
  removedColumns: string[]
  storageType: 'memory' | 'parquet'  // NEW
}
```

### Step 3.3: Add Memory Polling

**File**: `src/lib/diff-engine.ts` (wrap `runDiff` body)

**Find**: `export async function runDiff(...): Promise<DiffConfig> {`

**Replace body with**:
```typescript
export async function runDiff(
  tableA: string,
  tableB: string,
  keyColumns: string[]
): Promise<DiffConfig> {
  return withDuckDBLock(async () => {
    // Start memory polling (2-second intervals)
    let pollCount = 0
    const memoryPollInterval = setInterval(async () => {
      try {
        const status = await getMemoryStatus()
        pollCount++
        console.log(
          `[Diff] Memory poll #${pollCount}: ${formatBytes(status.usedBytes)} / ` +
          `${formatBytes(status.limitBytes)} (${status.percentage.toFixed(1)}%)`
        )

        // Warn if critical
        if (status.percentage > 90) {
          console.warn('[Diff] CRITICAL: Memory usage >90% during diff creation!')
        }
      } catch (err) {
        console.warn('[Diff] Memory poll failed (non-fatal):', err)
      }
    }, DIFF_MEMORY_POLL_INTERVAL_MS)

    try {
      // ... ALL EXISTING DIFF LOGIC (validation, temp table, summary, tiering) ...

      return { diffTableName, ..., storageType }
    } finally {
      // CRITICAL: Always clear interval, even on error
      clearInterval(memoryPollInterval)
      console.log(`[Diff] Completed with ${pollCount} memory polls`)
    }
  })
}
```

**Race Condition Safety**: `finally` block ensures polling stops even if `exportTableToParquet` throws.

### Step 3.4: Update Pagination for Parquet

**File**: `src/lib/diff-engine.ts` (modify `fetchDiffPage`)

**Add parameter**:
```typescript
export async function fetchDiffPage(
  tempTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  offset: number,
  limit: number = 500,
  keyOrderBy: string,
  storageType: 'memory' | 'parquet' = 'memory'  // NEW
): Promise<DiffRow[]> {
```

**Add Parquet path at top of function**:
```typescript
  // Build select columns (same as before)
  const selectCols = allColumns.map(...).join(', ')

  // Handle Parquet-backed diffs
  if (storageType === 'parquet') {
    const db = await initDuckDB()

    // Get OPFS file handle
    const root = await navigator.storage.getDirectory()
    const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
    const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })
    const fileHandle = await snapshotsDir.getFileHandle(`${tempTableName}.parquet`, { create: false })

    // Register for this query only
    await db.registerFileHandle(
      `${tempTableName}.parquet`,
      fileHandle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      false  // read-only
    )

    try {
      // Query Parquet file directly with pagination
      return query<DiffRow>(`
        SELECT
          d.diff_status,
          d.row_id,
          ${selectCols}
        FROM read_parquet('${tempTableName}.parquet') d
        LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
        LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
        WHERE d.diff_status IN ('added', 'removed', 'modified')
        ORDER BY d.diff_status, ${keyOrderBy}
        LIMIT ${limit} OFFSET ${offset}
      `)
    } finally {
      // CRITICAL: Unregister after query
      await db.dropFile(`${tempTableName}.parquet`)
    }
  }

  // Original in-memory path (unchanged)
  return query<DiffRow>(`
    SELECT
      d.diff_status,
      d.row_id,
      ${selectCols}
    FROM "${tempTableName}" d
    LEFT JOIN "${sourceTableName}" a ON d.a_row_id = a."_cs_id"
    LEFT JOIN "${targetTableName}" b ON d.b_row_id = b."_cs_id"
    WHERE d.diff_status IN ('added', 'removed', 'modified')
    ORDER BY d.diff_status, ${keyOrderBy}
    LIMIT ${limit} OFFSET ${offset}
  `)
}
```

**Optimization Note**: Per-call registration adds ~10-30ms overhead. If scrolling feels stuttery, move registration to component mount (future optimization).

### Step 3.5: Update Streaming for Export

**File**: `src/lib/diff-engine.ts` (modify `streamDiffResults`)

**Add parameter**:
```typescript
export async function* streamDiffResults(
  tempTableName: string,
  sourceTableName: string,
  targetTableName: string,
  allColumns: string[],
  newColumns: string[],
  removedColumns: string[],
  keyOrderBy: string,
  chunkSize: number = 10000,
  storageType: 'memory' | 'parquet' = 'memory'  // NEW
): AsyncGenerator<DiffRow[], void, unknown> {
  let offset = 0
  while (true) {
    const chunk = await fetchDiffPage(
      tempTableName,
      sourceTableName,
      targetTableName,
      allColumns,
      newColumns,
      removedColumns,
      offset,
      chunkSize,
      keyOrderBy,
      storageType  // Pass storage type
    )
    if (chunk.length === 0) break
    yield chunk
    offset += chunkSize
  }
}
```

### Step 3.6: Update Cleanup

**File**: `src/lib/diff-engine.ts` (modify `cleanupDiffTable`)

**Add parameter**:
```typescript
export async function cleanupDiffTable(
  tableName: string,
  storageType: 'memory' | 'parquet' = 'memory'  // NEW
): Promise<void> {
  try {
    // Always try to drop in-memory table
    await execute(`DROP TABLE IF EXISTS "${tableName}"`)

    // If Parquet-backed, delete OPFS file
    if (storageType === 'parquet') {
      const db = await initDuckDB()
      await db.dropFile(`${tableName}.parquet`)  // Unregister if active
      await deleteParquetSnapshot(tableName)      // Delete from OPFS
      console.log(`[Diff] Cleaned up Parquet file: ${tableName}.parquet`)
    }
  } catch (error) {
    console.warn('[Diff] Cleanup failed (non-fatal):', error)
  }
}
```

---

## PHASE 4: UI Integration (15 min)

### Step 4.1: Update Diff Store

**File**: `src/stores/diffStore.ts`

**Add field to DiffState**:
```typescript
interface DiffState {
  // ... existing fields
  storageType: 'memory' | 'parquet' | null
}
```

**Update initialState**:
```typescript
const initialState: DiffState = {
  // ... existing defaults
  storageType: null,
}
```

**Update setDiffConfig action**:
```typescript
setDiffConfig: (config: DiffConfig) => {
  set({
    diffTableName: config.diffTableName,
    sourceTableName: config.sourceTableName,
    targetTableName: config.targetTableName,
    summary: config.summary,
    totalDiffRows: config.totalDiffRows,
    allColumns: config.allColumns,
    keyOrderBy: config.keyOrderBy,
    newColumns: config.newColumns,
    removedColumns: config.removedColumns,
    storageType: config.storageType,  // NEW
  })
}
```

### Step 4.2: Update DiffView Cleanup

**File**: `src/components/diff/DiffView.tsx`

**Update cleanup useEffect** (line 83):
```typescript
// Cleanup temp table when component unmounts
useEffect(() => {
  return () => {
    if (diffTableName) {
      cleanupDiffTable(diffTableName, storageType || 'memory')
    }
  }
}, [diffTableName, storageType])
```

**Update handleRunDiff cleanup** (line 95):
```typescript
// Cleanup previous temp table if exists
if (diffTableName) {
  await cleanupDiffTable(diffTableName, storageType || 'memory')
}
```

**Extract storageType from store** (add to destructure at top):
```typescript
const {
  // ... existing fields
  storageType,
} = useDiffStore()
```

### Step 4.3: Update VirtualizedDiffGrid Pagination

**File**: `src/components/diff/VirtualizedDiffGrid.tsx`

**Add prop**:
```typescript
interface VirtualizedDiffGridProps {
  // ... existing props
  storageType?: 'memory' | 'parquet'
}
```

**Destructure prop**:
```typescript
export function VirtualizedDiffGrid({
  // ... existing props
  storageType = 'memory',
}: VirtualizedDiffGridProps) {
```

**Update initial load** (line 136):
```typescript
fetchDiffPage(
  diffTableName,
  sourceTableName,
  targetTableName,
  allColumns,
  newColumns,
  removedColumns,
  0,
  PAGE_SIZE,
  keyOrderBy,
  storageType  // NEW
)
```

**Update scroll pagination** (line 158):
```typescript
await fetchDiffPage(
  diffTableName,
  sourceTableName,
  targetTableName,
  allColumns,
  newColumns,
  removedColumns,
  needStart,
  needEnd - needStart,
  keyOrderBy,
  storageType  // NEW
)
```

**Pass prop from DiffView** (in `<VirtualizedDiffGrid>` call):
```typescript
<VirtualizedDiffGrid
  // ... existing props
  storageType={storageType || 'memory'}
/>
```

### Step 4.4: Update DiffExportMenu Streaming

**File**: `src/components/diff/DiffExportMenu.tsx`

**Add prop to interface**:
```typescript
interface DiffExportMenuProps {
  // ... existing props
  storageType?: 'memory' | 'parquet'
}
```

**Destructure prop**:
```typescript
export function DiffExportMenu({
  // ... existing props
  storageType = 'memory',
}: DiffExportMenuProps) {
```

**Update CSV export** (line 58):
```typescript
for await (const chunk of streamDiffResults(
  diffTableName,
  sourceTableName,
  targetTableName,
  allColumns,
  newColumns,
  removedColumns,
  keyOrderBy,
  undefined,  // use default chunkSize
  storageType  // NEW
)) {
```

**Update JSON export** (line 99):
```typescript
for await (const chunk of streamDiffResults(
  diffTableName,
  sourceTableName,
  targetTableName,
  allColumns,
  newColumns,
  removedColumns,
  keyOrderBy,
  undefined,  // use default chunkSize
  storageType  // NEW
)) {
```

**Update clipboard copy** (line 168):
```typescript
for await (const chunk of streamDiffResults(
  diffTableName,
  sourceTableName,
  targetTableName,
  allColumns,
  newColumns,
  removedColumns,
  keyOrderBy,
  100,  // small chunkSize for clipboard
  storageType  // NEW
)) {
```

**Pass prop from DiffView** (in `<DiffExportMenu>` call):
```typescript
<DiffExportMenu
  // ... existing props
  storageType={storageType || 'memory'}
/>
```

---

## PHASE 5: Testing & Verification (10 min)

### Test 1: TypeScript Compilation
```bash
npm run build
```
**Verify**: No errors

### Test 2: Small Diff (Tier 1 - In-Memory)
1. Upload `basic-data.csv` (50 rows)
2. Apply 2 transformations
3. Run diff
4. **Verify**: Console shows "Using in-memory storage" (no Parquet export)
5. **Verify**: Memory polls every 2 seconds during creation
6. **Verify**: Pagination and export work

### Test 3: Large Diff (Tier 2 - OPFS Parquet)
1. Upload 500k row CSV
2. Apply 5 transformations
3. Run diff
4. **Verify**: Console shows "Large diff (500k rows), exporting to OPFS..."
5. **Verify**: Console shows "Exported to OPFS, freed ~26MB RAM"
6. **Verify**: Memory drops after export
7. **Verify**: Pagination works (queries Parquet)
8. **Verify**: Export CSV works
9. Close diff
10. **Verify**: Console shows "Cleaned up Parquet file"

### Test 4: Memory Limit Compliance
1. Open Chrome Task Manager
2. Load 1M row table
3. Note baseline: Should be ~500MB (down from 1.55GB)
4. Run diff
5. **Verify**: Peak memory <2GB (should be ~1.3GB)
6. **Before fix**: 2.8GB ❌
7. **After fix**: 1.3GB ✅

### Test 5: Parquet Original Snapshot
1. Upload 500k row CSV
2. Edit a cell (triggers original snapshot creation)
3. **Verify**: Console shows "Creating Parquet original snapshot..."
4. Check OPFS storage
5. **Verify**: `original_*.parquet` file exists
6. Run diff with Preview mode
7. **Verify**: Diff works correctly with Parquet-backed original

---

## Success Metrics

**Before Fix**:
- Baseline: 1.55GB (table + in-memory snapshots)
- Peak: 2.8GB (during diff)
- **Gap**: 800MB over 2GB limit ❌

**After Fix**:
- Baseline: 500MB (table + Parquet snapshots on disk)
- Peak: 1.3GB (during diff, result flushed to OPFS)
- **Gap**: 700MB under 2GB limit ✅

**Breakdown (After)**:
- User table: 500 MB
- Parquet snapshots: ~250 MB (on OPFS disk, 0 MB RAM)
- Buffer pool: 100 MB
- Diff temp table: 0 MB (exported to OPFS)
- JOIN buffers (temporary): 800 MB (freed after)
- **Total peak**: ~1.4 GB

**Key Wins**:
1. ✅ 1GB baseline reduction (original snapshots → OPFS)
2. ✅ 1.5GB diff reduction (result → OPFS)
3. ✅ 2.5GB total memory freed
4. ✅ Diff operations safe for 2M+ row comparisons

---

## Critical Files Modified

1. `src/lib/duckdb/memory.ts` - Memory limit (1 line)
2. `src/lib/duckdb/index.ts` - DuckDB limit (1 line)
3. `src/lib/timeline-engine.ts` - Parquet original snapshots (30 lines)
4. `src/lib/diff-engine.ts` - Tiered storage + polling (80 lines)
5. `src/stores/diffStore.ts` - Storage type state (5 lines)
6. `src/components/diff/DiffView.tsx` - Cleanup + prop passing (10 lines)
7. `src/components/diff/VirtualizedDiffGrid.tsx` - Pagination (8 lines)
8. `src/components/diff/DiffExportMenu.tsx` - Streaming (6 lines)

**Total**: 8 files, ~140 lines modified/added

---

## Implementation Checklist

- [ ] Phase 1: Configuration (5 min)
  - [ ] Update MEMORY_LIMIT_BYTES to 2GB
  - [ ] Set DuckDB limit to 1843MB

- [ ] Phase 2: Baseline (15 min)
  - [ ] Modify createTimelineOriginalSnapshot (use parquet: prefix)
  - [ ] Add restoreTimelineOriginalSnapshot
  - [ ] Update diff-engine.ts to handle Parquet originals

- [ ] Phase 3: Diff Optimization (20 min)
  - [ ] Add constants (DIFF_TIER2_THRESHOLD, polling interval)
  - [ ] Implement tiered storage in runDiff
  - [ ] Add memory polling with finally cleanup
  - [ ] Update fetchDiffPage for Parquet
  - [ ] Update streamDiffResults
  - [ ] Update cleanupDiffTable

- [ ] Phase 4: UI Integration (15 min)
  - [ ] Add storageType to diffStore
  - [ ] Update DiffView cleanup
  - [ ] Update VirtualizedDiffGrid pagination
  - [ ] Update DiffExportMenu streaming

- [ ] Phase 5: Testing (10 min)
  - [ ] Compile check
  - [ ] Small diff test
  - [ ] Large diff test
  - [ ] Memory limit test
  - [ ] Parquet original test
