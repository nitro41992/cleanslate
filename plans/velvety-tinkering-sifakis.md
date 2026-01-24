# CRITICAL: Fix DuckDB Parquet Flush to OPFS

**Status:** 🔴 CRITICAL BUG
**Branch:** `opfs-ux-polish`
**Date:** January 24, 2026
**Discovered:** User testing after hotfix merge
**Impact:** ALL Parquet snapshots are 0 bytes - RAM optimizations completely non-functional

---

## TL;DR - The Fundamental Mistake

**Current Code Assumes:** `registerFileHandle()` + `COPY TO parquet` writes directly to OPFS (like CSV does)

**Reality:** DuckDB-WASM's `COPY TO parquet` creates an **in-memory virtual file** that must be manually retrieved with `copyFileToBuffer()` and written to OPFS using File System Access API.

**Fix:** Remove all `registerFileHandle()` calls for Parquet exports and use the 4-step in-memory buffer pattern (COPY TO → copyFileToBuffer → write to OPFS → dropFile).

**Impact:** ~50 lines of code simplified, RAM will drop from 2.2GB to 0.8GB after transformations.

⚠️ **CRITICAL MEMORY WARNING:** `copyFileToBuffer()` copies data to JavaScript heap. Must NEVER be used on files > 250MB or browser will OOM crash. Chunking is mandatory for safety.

---

## Problem Summary

After implementing the duplicate snapshot hotfix, user testing revealed a **catastrophic failure**: All 74 Parquet snapshot files in OPFS are **0 bytes**. The entire Parquet-based RAM optimization strategy is non-functional.

**Root Cause (DISCOVERED):** The current implementation attempts to use `registerFileHandle()` with BROWSER_FSACCESS to have DuckDB write directly to OPFS. **This pattern does NOT work for Parquet exports in DuckDB-WASM.**

According to official DuckDB-WASM patterns ([Discussion #1714](https://github.com/duckdb/duckdb-wasm/discussions/1714), [duckdb-wasm-kit](https://github.com/holdenmatt/duckdb-wasm-kit/blob/main/src/files/exportFile.ts)), `COPY TO` creates an **in-memory virtual file**, not a direct write to registered handles. You must:
1. Create in-memory file with `COPY TO`
2. Retrieve buffer with `db.copyFileToBuffer()`
3. Manually write buffer to OPFS using File System Access API
4. Cleanup with `db.dropFile()`

**Evidence:**
- 74 Parquet files in OPFS, all showing 0 bytes
- OPFS write test passes (permissions work)
- Console errors: "Buffering missing file: tmp_snapshot_*.parquet" (DuckDB creating in-memory files, not finding registered handles)
- RAM at 2.2GB instead of expected 0.8GB (data never leaves DuckDB memory)

---

## Investigation Results

### Research Sources
- [DuckDB-WASM Discussion #1714](https://github.com/duckdb/duckdb-wasm/discussions/1714) - "By default everything in WASM is in memory"
- [duckdb-wasm-kit exportFile.ts](https://github.com/holdenmatt/duckdb-wasm-kit/blob/main/src/files/exportFile.ts) - Reference implementation
- [DuckDB-WASM OPFS Test](https://github.com/duckdb/duckdb-wasm/blob/main/packages/duckdb-wasm/test/opfs.test.ts) - Official patterns
- [voluntas/duckdb-wasm-parquet](https://github.com/voluntas/duckdb-wasm-parquet) - Real-world example

### Current (WRONG) Implementation
```typescript
// ❌ Attempting to write Parquet directly to registered OPFS handle
const fileHandle = await snapshotsDir.getFileHandle('file.parquet', { create: true })
await db.registerFileHandle('file.parquet', fileHandle, BROWSER_FSACCESS, true)
await conn.query(`COPY (...) TO 'file.parquet' (FORMAT PARQUET)`)
await db.flushFiles()  // ← Doesn't work for Parquet!
await db.dropFile('file.parquet')
// Result: 0 byte file in OPFS
```

**Why It Fails:** DuckDB-WASM's `COPY TO` for Parquet creates an **in-memory virtual file**, ignoring registered file handles. The official test suite only shows CSV exports working with `registerFileHandle()`, NOT Parquet.

### Correct Pattern (from duckdb-wasm-kit)
```typescript
// ✅ COPY TO creates in-memory file
await conn.query(`COPY (...) TO 'temp.parquet' (FORMAT PARQUET)`)

// ✅ Retrieve buffer from memory
const buffer = await db.copyFileToBuffer('temp.parquet')

// ✅ Write to OPFS manually
const fileHandle = await snapshotsDir.getFileHandle('final.parquet', { create: true })
const writable = await fileHandle.createWritable()
await writable.write(buffer)
await writable.close()

// ✅ Cleanup in-memory file
await db.dropFile('temp.parquet')
```

---

## Solution: Use In-Memory Buffer Pattern

**CRITICAL:** Remove all `registerFileHandle()` calls for Parquet exports. Use the correct 4-step pattern:
1. `COPY TO` → creates in-memory virtual file
2. `copyFileToBuffer()` → retrieves buffer from memory
3. Write buffer to OPFS using File System Access API
4. `dropFile()` → cleanup virtual file

### Architectural Changes

**File:** `src/lib/opfs/snapshot-storage.ts`

**Impact:** Complete rewrite of `exportTableToParquet()` function

### Current Broken Code (lines 46-164)

The current implementation has these fatal flaws:
- ✗ Calls `registerFileHandle()` for Parquet files (doesn't work)
- ✗ Attempts to use `db.flushFiles()` (only works for CSV)
- ✗ Manual file copying with tmp_ prefix (unnecessary complexity)
- ✗ `NoModificationAllowedError` when deleting registered files

### New Implementation Pattern

```typescript
export async function exportTableToParquet(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tableName: string,
  snapshotId: string
): Promise<void> {
  await ensureSnapshotDir()

  // Check table size
  const countResult = await conn.query(`SELECT COUNT(*) as count FROM "${tableName}"`)
  const rowCount = Number(countResult.toArray()[0].toJSON().count)

  console.log(`[Snapshot] Exporting ${tableName} (${rowCount.toLocaleString()} rows) to OPFS...`)

  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: true })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: true })

  const CHUNK_THRESHOLD = 250_000

  // CRITICAL: Always chunk for tables > 250k rows to prevent JS heap OOM
  // copyFileToBuffer() copies data to JS heap, so we must limit buffer size
  if (rowCount > CHUNK_THRESHOLD) {
    // Chunked export (safe for any table size)
    const batchSize = CHUNK_THRESHOLD
    let offset = 0
    let partIndex = 0

    while (offset < rowCount) {
      const tempFileName = `temp_${snapshotId}_part_${partIndex}.parquet`
      const finalFileName = `${snapshotId}_part_${partIndex}.parquet`

      // 1. COPY TO in-memory file (DuckDB WASM memory)
      await conn.query(`
        COPY (
          SELECT * FROM "${tableName}"
          ORDER BY "${CS_ID_COLUMN}"
          LIMIT ${batchSize} OFFSET ${offset}
        ) TO '${tempFileName}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
      `)

      // 2. Retrieve buffer from WASM memory → JS heap (~50MB compressed)
      const buffer = await db.copyFileToBuffer(tempFileName)

      // 3. Write to OPFS (buffer cleared after write)
      const fileHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(buffer)
      await writable.close()

      // 4. Cleanup virtual file in WASM
      await db.dropFile(tempFileName)

      offset += batchSize
      partIndex++
      console.log(`[Snapshot] Exported chunk ${partIndex}: ${Math.min(offset, rowCount).toLocaleString()}/${rowCount.toLocaleString()} rows`)
    }

    console.log(`[Snapshot] Exported ${partIndex} chunks to ${snapshotId}_part_*.parquet`)
  } else {
    // Single file export (ONLY safe for tables <= 250k rows)
    // If rowCount == CHUNK_THRESHOLD, this path is safe (equality handled by > check above)
    const tempFileName = `temp_${snapshotId}.parquet`
    const finalFileName = `${snapshotId}.parquet`

    // 1. COPY TO in-memory file
    await conn.query(`
      COPY (
        SELECT * FROM "${tableName}"
        ORDER BY "${CS_ID_COLUMN}"
      ) TO '${tempFileName}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
    `)

    // 2. Retrieve buffer from WASM → JS heap (safe: < 50MB)
    const buffer = await db.copyFileToBuffer(tempFileName)

    // 3. Write to OPFS
    const fileHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(buffer)
    await writable.close()

    // 4. Cleanup virtual file
    await db.dropFile(tempFileName)

    console.log(`[Snapshot] Exported to ${finalFileName}`)
  }
}
```

### Key Changes
1. **Remove all `registerFileHandle()` calls** - not needed for exports
2. **Add `db.copyFileToBuffer(tempFileName)`** - retrieve in-memory file
3. **Use File System Access API directly** - `createWritable()` + `write(buffer)`
4. **Simplify cleanup** - just `dropFile()` the temp virtual file
5. **Remove tmp_ prefix handling** - no longer relevant
6. **Add safety comments** - explain why chunking is mandatory (JS heap OOM prevention)

### Memory Safety Guarantees

**Why Chunking is MANDATORY:**
- `copyFileToBuffer()` copies data from WASM heap → JavaScript heap
- Large buffers (>250MB) cause browser OOM crashes
- Chunking limits each buffer to ~50MB compressed (~250k rows)

**Edge Case Handling:**
- `if (rowCount > CHUNK_THRESHOLD)` uses strict inequality (`>`)
- Tables with **exactly** 250,000 rows use single-file export (safe: ~50MB compressed)
- Tables with 250,001+ rows use chunked export (safe: multiple ~50MB buffers)
- `while (offset < rowCount)` correctly handles remainder chunks (e.g., 275k rows = 250k + 25k)

**Memory Pattern Per Export:**
- Single file (≤250k rows): Peak JS heap +50MB (temporary), clears after OPFS write
- Chunked (>250k rows): Peak JS heap +50MB per chunk (temporary), clears after each chunk write
- Total RAM impact: Minimal (buffers are temporary and GC'd immediately)

---

## Implementation Plan

### Step 1: Rewrite Chunked Export Loop (lines 64-121)

**Remove:**
- All `registerFileHandle()` calls
- All `db.flushFiles()` calls
- Manual file copying with `createWritable()` on fileHandle from tmp file
- `removeEntry(tmpFileName)` cleanup

**Add:**
- `db.copyFileToBuffer(tempFileName)` after COPY TO
- Direct write to OPFS using final file handle
- Single `dropFile()` call for cleanup

**Pattern per chunk:**
```typescript
const tempFileName = `temp_${snapshotId}_part_${partIndex}.parquet`
const finalFileName = `${snapshotId}_part_${partIndex}.parquet`

await conn.query(`COPY (...) TO '${tempFileName}' (...)`)
const buffer = await db.copyFileToBuffer(tempFileName)

const fileHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
const writable = await fileHandle.createWritable()
await writable.write(buffer)
await writable.close()

await db.dropFile(tempFileName)
```

### Step 2: Rewrite Single File Export (lines 122-163)

**Remove:**
- `registerFileHandle()` call
- Manual file copying logic
- tmp_ prefix handling

**Add:**
- Same 4-step pattern as chunked export

**Pattern:**
```typescript
const tempFileName = `temp_${snapshotId}.parquet`
const finalFileName = `${snapshotId}.parquet`

await conn.query(`COPY (...) TO '${tempFileName}' (...)`)
const buffer = await db.copyFileToBuffer(tempFileName)

const fileHandle = await snapshotsDir.getFileHandle(finalFileName, { create: true })
const writable = await fileHandle.createWritable()
await writable.write(buffer)
await writable.close()

await db.dropFile(tempFileName)
```

### Step 3: Add File Size Validation

After writing to OPFS, verify the file has actual data:

```typescript
await writable.close()

// Verify file was written
const file = await fileHandle.getFile()
if (file.size === 0) {
  throw new Error(`[Snapshot] Failed to write ${finalFileName} - file is 0 bytes`)
}
console.log(`[Snapshot] Wrote ${(file.size / 1024 / 1024).toFixed(2)} MB to ${finalFileName}`)
```

### Step 4: Clean Up Orphaned 0-Byte Files
After fixing the code, we should clean up the 74 empty Parquet files from previous failed exports.

**Option A:** Manual cleanup via console
```javascript
async function cleanupEmptyParquetFiles() {
  const root = await navigator.storage.getDirectory()
  const appDir = await root.getDirectoryHandle('cleanslate', { create: false })
  const snapshotsDir = await appDir.getDirectoryHandle('snapshots', { create: false })

  let deletedCount = 0
  for await (const [name, handle] of snapshotsDir.entries()) {
    if (handle.kind === 'file' && name.endsWith('.parquet')) {
      const file = await handle.getFile()
      if (file.size === 0) {
        await snapshotsDir.removeEntry(name)
        deletedCount++
      }
    }
  }
  console.log(`Deleted ${deletedCount} empty Parquet files`)
}

await cleanupEmptyParquetFiles()
```

**Option B:** Add cleanup logic to app startup (lower priority)

---

## Verification Plan

### Test 1: File Size Check (Large Table)
1. Clear all existing snapshots (run cleanup function above)
2. Reload app with fresh DuckDB instance
3. Upload 1M row CSV file
4. Run 1 transformation (e.g., Standardize Date)
5. Check OPFS file sizes via console:

```javascript
await listOPFSSnapshots()
// Expected: 5 original files + 5 step files, each ~40-50MB
// NOT: 0 bytes
```

### Test 1b: Edge Case - Exactly 250k Rows
1. Create a CSV with exactly 250,000 rows
2. Upload and transform
3. Verify single-file export (no _part_0.parquet suffix)
4. Verify file size ~50MB

### Test 1c: Edge Case - 250k + 1 Row
1. Create a CSV with 250,001 rows
2. Upload and transform
3. Verify chunked export (files: *_part_0.parquet, *_part_1.parquet)
4. Verify part_0 is ~50MB and part_1 is tiny

### Test 2: RAM Usage Check
1. Monitor RAM in Chrome Task Manager
2. Run 2 consecutive transformations
3. Expected RAM pattern:
   - Baseline after load: ~400MB
   - During transform 1: Spike to ~1.5GB (COPY TO)
   - After transform 1 completes: Drop to ~600MB (data flushed to OPFS)
   - During transform 2: Spike to ~1.5GB
   - After transform 2 completes: Drop to ~800MB

**Success Criteria:**
- ✅ Parquet files have actual data (40-50MB each)
- ✅ RAM drops after each transformation completes
- ✅ Total RAM stays under 1.0GB between transformations

### Test 3: Snapshot Restore
1. Create snapshot with transformation
2. Close and reopen browser tab
3. Undo transformation (should restore from Parquet)
4. Verify data is correct

**Success Criteria:**
- ✅ No errors during import
- ✅ Data matches pre-transformation state
- ✅ Undo completes in <5 seconds

---

## Expected Impact

### Before Fix
- **OPFS Usage:** 0 MB (all files empty)
- **RAM at Rest:** 2.2GB (all data in DuckDB memory)
- **RAM Spike:** 2.5GB during transformations
- **Parquet Strategy:** Completely broken

### After Fix
- **OPFS Usage:** ~400-500MB (compressed Parquet files)
- **RAM at Rest:** 600-800MB (most data in OPFS)
- **RAM Spike:** 1.5GB during transformations (drops after flush)
- **Parquet Strategy:** Fully functional

**Projected RAM Savings:** 1.4GB reduction (2.2GB → 0.8GB)

---

## Risk Assessment

**Risk Level:** 🔴 **CRITICAL**

**Why This Wasn't Caught Earlier:**
1. Console logs show "Exported 5 chunks" - misleading success message
2. No file size verification in code
3. DuckDB's silent buffer handling (no errors thrown)

**Blast Radius:**
- Every table snapshot ever created is 0 bytes
- Undo/redo relies on these snapshots
- Diff highlighting relies on these snapshots
- Memory management strategy completely non-functional

**Mitigation:**
- Add file size assertions after export
- Add startup validation (warn if Parquet files are 0 bytes)
- Add E2E test that verifies actual file sizes in OPFS

---

## Files to Modify

1. **`src/lib/opfs/snapshot-storage.ts`** (CRITICAL - Complete Rewrite)
   - **Lines 64-121** (Chunked Export): Remove `registerFileHandle()` + manual file copy, add `copyFileToBuffer()` pattern
   - **Lines 122-163** (Single File Export): Remove `registerFileHandle()` + manual file copy, add `copyFileToBuffer()` pattern
   - **Add file size validation** after each write
   - **Net change**: ~30 lines removed (registration/tmp handling), ~15 lines added (buffer retrieval)

2. **OPFS Cleanup** (Manual via console - ONE TIME)
   - Delete 74 empty Parquet files from previous sessions (see cleanup function in plan)

---

## Follow-Up Tasks (Post-Fix)

1. **File Size Validation** (Included in Step 3)
   - ✅ Already added to implementation plan
   - Verify file size > 0 after write
   - Throw error if write failed

2. **Add Startup Health Check** (Optional, lower priority)
   - On app load, scan OPFS for 0-byte Parquet files
   - Show warning toast if found
   - Offer "Clean Up" button

3. **Add E2E Test** (High priority)
   - Test that Parquet files have actual data after export (check file size)
   - Test that snapshots can be restored correctly (undo transformation)
   - Verify RAM drops after transformation completes

4. **Add Monitoring** (Included in Step 3)
   - ✅ Already added to implementation plan
   - Log file sizes after export
   - Track OPFS storage quota usage

5. **Documentation**
   - Add JSDoc comment explaining in-memory buffer pattern
   - Document why `registerFileHandle()` doesn't work for Parquet exports
   - Link to upstream DuckDB-WASM discussion #1714
