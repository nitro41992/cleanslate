# CRITICAL: Fix DuckDB Parquet Flush to OPFS

**Status:** 🔴 CRITICAL BUG
**Branch:** `opfs-ux-polish`
**Date:** January 24, 2026
**Discovered:** User testing after hotfix merge
**Impact:** ALL Parquet snapshots are 0 bytes - RAM optimizations completely non-functional

---

## Problem Summary

After implementing the duplicate snapshot hotfix, user testing revealed a **catastrophic failure**: All 74 Parquet snapshot files in OPFS are **0 bytes**. The entire Parquet-based RAM optimization strategy is non-functional.

**Root Cause:** DuckDB's `COPY TO` command writes to internal buffers, but we call `db.dropFile()` immediately after, which unregisters the file handle before DuckDB flushes write buffers to OPFS.

**Evidence:**
- 74 Parquet files in OPFS, all showing 0 bytes
- OPFS write test passes (permissions work)
- Console logs show "Exported 5 chunks" but files remain empty
- RAM at 2.2GB instead of expected 1.9GB (data never leaves DuckDB memory)

---

## Investigation Results

### OPFS Permission Test: ✅ PASS
```javascript
// Manual write to OPFS succeeds
const writable = await testFile.createWritable()
await writable.write('Hello OPFS!')  // ✅ Works - 11 bytes written
```

### DuckDB Parquet Export: ❌ FAIL
```javascript
// DuckDB COPY TO writes to buffers but doesn't flush
await conn.query(`COPY (...) TO 'file.parquet'`)
await db.dropFile('file.parquet')  // ❌ Unregisters before flush!
// Result: 0 byte file in OPFS
```

**The Issue:** DuckDB-WASM buffers Parquet writes in memory. The `db.dropFile()` call immediately unregisters the file handle, preventing the flush from completing.

---

## Solution: Add `db.flushFiles()` Before Unregistering

DuckDB-WASM provides `db.flushFiles()` to force write buffers to flush to the registered file handles. We must call this after `COPY TO` and before `db.dropFile()`.

### Fix Location

**File:** `src/lib/opfs/snapshot-storage.ts`

**Two code paths need fixing:**

#### 1. Chunked Export (lines 84-94)
```typescript
// Export chunk (only buffers batchSize rows)
await conn.query(`
  COPY (
    SELECT * FROM "${tableName}"
    LIMIT ${batchSize} OFFSET ${offset}
  ) TO '${fileName}'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
`)

// ❌ MISSING: Flush before unregister
await db.dropFile(fileName)
```

**Fix:**
```typescript
await conn.query(`COPY (...) TO '${fileName}' (...)`)

// ✅ ADD THIS: Force flush to OPFS
await db.flushFiles()

await db.dropFile(fileName)
```

#### 2. Single File Export (lines 114-119)
```typescript
await conn.query(`
  COPY "${tableName}" TO '${fileName}'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
`)

// ❌ MISSING: Flush before unregister
// (Currently no db.dropFile() call here, but should add for consistency)
```

**Fix:**
```typescript
await conn.query(`COPY "${tableName}" TO '${fileName}' (...)`)

// ✅ ADD THIS: Force flush to OPFS
await db.flushFiles()

// ✅ ADD THIS: Unregister after flush (currently missing)
await db.dropFile(fileName)
```

---

## Implementation Plan

### Step 1: Add Flush to Chunked Export
**Location:** `src/lib/opfs/snapshot-storage.ts:84-94`

Add `await db.flushFiles()` after the `COPY TO` query and before `db.dropFile()`.

**Before:**
```typescript
await conn.query(`COPY (...) TO '${fileName}' (...)`)
await db.dropFile(fileName)
```

**After:**
```typescript
await conn.query(`COPY (...) TO '${fileName}' (...)`)
await db.flushFiles()  // ← ADD THIS
await db.dropFile(fileName)
```

### Step 2: Add Flush + Cleanup to Single File Export
**Location:** `src/lib/opfs/snapshot-storage.ts:114-119`

The single file export path currently doesn't call `db.dropFile()` at all. Add both flush and cleanup.

**Before:**
```typescript
await conn.query(`COPY "${tableName}" TO '${fileName}' (...)`)
console.log(`[Snapshot] Exported to ${fileName}`)
```

**After:**
```typescript
await conn.query(`COPY "${tableName}" TO '${fileName}' (...)`)
await db.flushFiles()  // ← ADD THIS
await db.dropFile(fileName)  // ← ADD THIS
console.log(`[Snapshot] Exported to ${fileName}`)
```

### Step 3: Clean Up Orphaned 0-Byte Files
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

### Test 1: File Size Check
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

1. **`src/lib/opfs/snapshot-storage.ts`** (CRITICAL)
   - Line 84-94: Add `db.flushFiles()` in chunked export
   - Line 114-119: Add `db.flushFiles()` + `db.dropFile()` in single file export

2. **OPFS Cleanup** (Manual via console)
   - Delete 74 empty Parquet files from previous sessions

---

## Follow-Up Tasks (Post-Fix)

1. **Add File Size Validation**
   - After `db.flushFiles()`, verify file size > 0
   - Throw error if flush failed

2. **Add Startup Health Check**
   - On app load, scan OPFS for 0-byte Parquet files
   - Show warning toast if found
   - Offer "Clean Up" button

3. **Add E2E Test**
   - Test that Parquet files have actual data after export
   - Test that snapshots can be restored correctly

4. **Add Monitoring**
   - Log file sizes after export
   - Track OPFS storage quota usage
