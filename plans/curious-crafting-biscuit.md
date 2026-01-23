# OPFS-Backed DuckDB Storage: Implementation Plan

**Objective:** Replace CleanSlate's manual CSV-based OPFS persistence with native DuckDB OPFS storage for automatic persistence, 3-5x memory reduction via compression, and 10-100x faster load times.

**Context:** 240MB CSV file currently expands to 1.5GB in memory (6.25x). Root causes: uncompressed in-memory storage, snapshot proliferation, lack of native persistence.

---

## Approved Decisions

1. **Backwards Compatibility:** Migration path - detect existing CSV storage, auto-migrate to DuckDB format
2. **Browser Support:** Graceful fallback - Chrome/Edge/Safari use OPFS, Firefox uses in-memory
3. **User Experience:** Auto-persist - treat app like persistent workspace, remove manual save
4. **Testing:** Integration test with 50k row fixture to verify memory regression
5. **Priority:** Phase 2A (OPFS-Backed DuckDB) - skip in-memory optimizations, implement final architecture

---

## Architecture Overview

**Approach:** Pragmatic balance between minimal changes and clean architecture.

**Key Principles:**
- Direct OPFS integration in `initDuckDB()` with browser detection
- Browser-aware initialization: OPFS for Chrome/Edge/Safari, in-memory for Firefox
- One-time migration from legacy CSV storage to DuckDB format with row count verification
- **Debounced auto-flush** (1 second idle time) to prevent UI stuttering on rapid edits
- Storage quota monitoring via `navigator.storage.estimate()` for Safari/Chrome limits
- Audit log pruning (keep last 100 entries) to prevent database bloat
- Double-tab conflict handling with read-only mode fallback
- Compression enabled for 30-50% memory reduction

**Files to Create:** 5 utilities (~400 lines total)
**Files to Modify:** 4 core files (~150 lines total changes)
**Implementation Time:** 1-1.5 weeks

---

## Strategic Refinements (Post-Review)

Based on review feedback, the following optimizations were added to the original plan:

### 1. Debounced Auto-Flush
**Problem:** Flushing WAL after every command causes UI stuttering on bulk edits (10 transforms in rapid succession = 10 disk writes).

**Solution:** Implement 1-second debounce timer. High-frequency edits only flush once after idle time.

**Impact:** Smoother UX for power users applying multiple transformations quickly.

---

### 2. Storage Quota Monitoring
**Problem:** Safari's OPFS can be aggressive with storage eviction. Users may hit quota limits without warning.

**Solution:** Use `navigator.storage.estimate()` to show usage percentage. Warn at 80% capacity.

**Impact:** Proactive visibility prevents unexpected data loss from quota eviction.

---

### 3. Audit Log Pruning
**Problem:** `_audit_details` table grows indefinitely (1 entry per row affected = 100k+ rows for large operations).

**Solution:** Keep only last 100 audit entries. Prune on app init.

**Impact:** Prevents database bloat over months of use.

---

### 4. Migration Safety Double-Check
**Problem:** If CSV parsing fails silently, row counts may mismatch, but legacy files get deleted.

**Solution:** Verify row counts match metadata before deleting legacy storage. If mismatch, rename folder to `cleanslate_backup_failed_migration/`.

**Impact:** Zero data loss on failed migrations.

---

### 5. Double-Tab Conflict Handling
**Problem:** If user opens CleanSlate in two tabs, both try to acquire write lock on `cleanslate.db`. Second tab may fail.

**Solution:** Catch lock error, fall back to `READ_ONLY` mode with user warning.

**Impact:** Graceful degradation - user can view data in second tab, knows it's read-only.

---

## Component Design

### 1. Browser Detection Utility

**File:** `src/lib/duckdb/browser-detection.ts` (NEW)

**Purpose:** Detect browser capabilities for OPFS support

**Interface:**
```typescript
export interface BrowserCapabilities {
  browser: 'chrome' | 'edge' | 'safari' | 'firefox' | 'unknown'
  hasOPFS: boolean
  supportsAccessHandle: boolean
  version: string
}

export async function detectBrowserCapabilities(): Promise<BrowserCapabilities>
```

**Detection Logic:**
1. Parse `navigator.userAgent` for browser name/version
2. Test `navigator.storage.getDirectory()` for OPFS support
3. Check for `FileSystemFileHandle.createSyncAccessHandle` (Chrome/Edge only)
4. Return capabilities object

**Why:** Enables graceful fallback for Firefox, future-proofs for other browsers

---

### 2. OPFS Migration Utility

**File:** `src/lib/duckdb/opfs-migration.ts` (NEW)

**Purpose:** One-time migration from legacy CSV storage to DuckDB format

**Interface:**
```typescript
export interface MigrationResult {
  migrated: boolean
  tablesImported: number
  auditEntriesRestored: number
  error?: string
}

export async function migrateFromCSVStorage(): Promise<MigrationResult>
```

**Migration Flow:**
1. Check for `cleanslate/metadata.json` (legacy storage indicator)
2. If not found, return `{ migrated: false }`
3. Load `metadata.json` and parse table list
4. For each table:
   - Use DuckDB's `CREATE TABLE FROM read_csv_auto('opfs://cleanslate/tables/{id}.csv')`
   - Import directly into OPFS-backed database
   - **NEW: Verify row count matches metadata** (safety check)
     ```typescript
     const expectedRows = metadata.tables.find(t => t.id === tableId).rowCount
     const actualRows = await query(`SELECT COUNT(*) FROM "${tableName}"`)
     if (actualRows !== expectedRows) {
       throw new Error(`Row count mismatch: expected ${expectedRows}, got ${actualRows}`)
     }
     ```
   - If verification fails, skip deletion and mark migration as partial
5. Import `cleanslate/audit_details.csv` to `_audit_details` table
6. **Pre-flight check:** Verify all tables have matching row counts
7. If all verified: Delete legacy files
8. If any failed: Rename `cleanslate/` → `cleanslate_backup_failed_migration/`, keep data safe
9. Return migration statistics with success/failure details

**Error Handling:**
- If any table fails import, log error but continue with others
- Preserve original CSV files until **full migration verified**
- If row count mismatch, do NOT delete legacy folder - rename for safety
- Show user toast: "Migration completed with warnings - check console for details"

**Why:** Seamless user upgrade - existing data preserved and auto-migrated on first load

---

### 3. Storage Info API

**File:** `src/lib/duckdb/storage-info.ts` (NEW)

**Purpose:** Provide storage backend info and quota monitoring for UI indicators

**Interface:**
```typescript
export interface StorageInfo {
  backend: 'opfs' | 'memory'
  isPersistent: boolean
  estimatedSizeBytes: number | null
  browserSupport: BrowserCapabilities
  quota: StorageQuota | null  // NEW: Quota tracking
}

export interface StorageQuota {
  usedBytes: number
  quotaBytes: number
  usagePercent: number
  isNearLimit: boolean  // true if >80%
}

export async function getStorageInfo(): Promise<StorageInfo>
```

**Implementation:**
- Query OPFS file size if persistent: `await dbFileHandle.getFile()` → `file.size`
- **NEW: Query storage quota** (Safari/Chrome quota management):
  ```typescript
  const estimate = await navigator.storage.estimate()
  const quota: StorageQuota = {
    usedBytes: estimate.usage || 0,
    quotaBytes: estimate.quota || 0,
    usagePercent: (estimate.usage! / estimate.quota!) * 100,
    isNearLimit: (estimate.usage! / estimate.quota!) > 0.8
  }
  ```
- Return `null` for in-memory (no persistent size/quota)
- Expose browser capabilities for UI display

**Why:**
- Users need visibility into storage mode and persistence status
- **Safari OPFS can be aggressive with eviction** - showing quota prevents unexpected data loss
- Enables proactive warning at 80% usage: "Storage almost full - consider archiving old tables"

---

### 4. Modified: DuckDB Initialization

**File:** `src/lib/duckdb/index.ts` (MODIFIED)

**Changes to `initDuckDB()` function (lines 49-74):**

```typescript
export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (db) return db

  // 1. Detect browser capabilities
  const caps = await detectBrowserCapabilities()

  // 2. Initialize DuckDB-WASM (existing code)
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES)
  const bundleType = bundle.mainModule.includes('-eh') ? 'EH' : 'MVP'
  const worker = new Worker(bundle.mainWorker!)
  const logger = new duckdb.ConsoleLogger()

  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule)

  // 3. Open with OPFS or in-memory based on browser
  try {
    if (caps.hasOPFS && caps.supportsAccessHandle) {
      // Chrome/Edge/Safari: OPFS-backed persistent storage
      try {
        await db.open({
          path: 'opfs://cleanslate.db',
          query: {
            access_mode: 'READ_WRITE',
          },
        })
        isPersistent = true
        console.log(`DuckDB: OPFS persistence enabled (${caps.browser})`)

        // Run one-time migration if needed
        const migrationResult = await migrateFromCSVStorage()
        if (migrationResult.migrated) {
          console.log(`Migrated ${migrationResult.tablesImported} tables from CSV`)
        }
      } catch (openError) {
        // Check if error is due to database already open in another tab
        const errorMsg = openError instanceof Error ? openError.message : String(openError)
        if (errorMsg.includes('locked') || errorMsg.includes('busy')) {
          // Database locked by another tab - open in read-only mode
          console.warn('Database locked by another tab, opening read-only')
          await db.open({
            path: 'opfs://cleanslate.db',
            query: {
              access_mode: 'READ_ONLY',
            },
          })
          isPersistent = true
          isReadOnly = true

          toast({
            title: 'Read-Only Mode',
            description: 'CleanSlate is open in another tab. This tab is read-only.',
            variant: 'default',
          })
        } else {
          throw openError  // Re-throw if not a locking issue
        }
      }
    } else {
      // Firefox: In-memory fallback
      await db.open({
        path: ':memory:',
        query: {
          access_mode: 'READ_WRITE',
        },
      })
      isPersistent = false
      console.log(`DuckDB: In-memory mode (${caps.browser} - no OPFS)`)
    }
  } catch (error) {
    console.error('OPFS init failed, falling back to memory:', error)
    await db.open({ path: ':memory:' })
    isPersistent = false
  }

  // 4. Configure memory limit and compression
  const isTestEnv = typeof navigator !== 'undefined' &&
                    navigator.userAgent.includes('Playwright')
  const memoryLimit = isTestEnv ? '256MB' : '3GB'

  const initConn = await db.connect()
  await initConn.query(`SET memory_limit = '${memoryLimit}'`)

  // Enable compression (both OPFS and in-memory benefit)
  await initConn.query(`PRAGMA enable_object_cache=true`)
  await initConn.query(`PRAGMA force_compression='zstd'`)

  await initConn.close()

  console.log(`DuckDB: ${bundleType} bundle, ${memoryLimit} limit, compression enabled`)
  return db
}

// NEW: Export persistence status
let isPersistent = false
export function isDuckDBPersistent(): boolean {
  return isPersistent
}

// NEW: Export flush function for auto-persist
let flushTimer: NodeJS.Timeout | null = null

export async function flushDuckDB(immediate = false): Promise<void> {
  if (!isPersistent || isReadOnly) return // In-memory or read-only - nothing to flush

  // Clear existing timer
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  if (immediate) {
    // Immediate flush (called on app unload)
    const conn = await getConnection()
    await withMutex(async () => {
      await conn.query(`PRAGMA wal_checkpoint(TRUNCATE)`)
    })
  } else {
    // Debounced flush (1 second idle time)
    flushTimer = setTimeout(async () => {
      try {
        const conn = await getConnection()
        await withMutex(async () => {
          await conn.query(`PRAGMA wal_checkpoint(TRUNCATE)`)
        })
        console.log('[OPFS] Auto-flush completed')
      } catch (err) {
        console.warn('[OPFS] Auto-flush failed:', err)
      }
      flushTimer = null
    }, 1000)
  }
}

// NEW: Export read-only status
let isReadOnly = false
export function isDuckDBReadOnly(): boolean {
  return isReadOnly
}
```

**Why:** Minimal changes to existing function, clear branching logic, easy to test

---

### 5. Modified: Command Executor Auto-Flush

**File:** `src/lib/commands/executor.ts` (MODIFIED)

**Change location:** After `updateTableStore()` call (around line 280)

**Add:**
```typescript
// Step 8: Update stores
this.updateTableStore(ctx.table.id, executionResult)

// Auto-persist to OPFS (debounced, non-blocking)
// Waits 1 second of idle time before flushing to prevent stuttering on bulk edits
flushDuckDB() // Returns immediately, schedules flush for 1s later

return { success: true, ... }
```

**Why:**
- Every transformation triggers auto-save, but debounced to prevent UI stuttering
- **Bulk edits** (10 transforms in rapid succession) only flush once after 1s idle
- Non-blocking ensures UI responsiveness
- If user closes tab during debounce window, browser's `beforeunload` handler calls `flushDuckDB(true)` for immediate flush

---

### 6. Modified: useDuckDB Hook Migration Handling

**File:** `src/hooks/useDuckDB.ts` (MODIFIED)

**Changes to `useEffect` (lines 32-46):**

**Current:**
```typescript
useEffect(() => {
  initDuckDB()
    .then(() => {
      setIsReady(true)
      console.log('DuckDB ready')
    })
    .catch((err) => {
      console.error('Failed to initialize DuckDB:', err)
      toast({ title: 'Database Error', ... })
    })
}, [])
```

**After:**
```typescript
useEffect(() => {
  initDuckDB()
    .then(async () => {
      setIsReady(true)

      // Show persistence status
      const isPersistent = isDuckDBPersistent()
      if (isPersistent) {
        console.log('DuckDB ready with persistent storage')
      } else {
        console.log('DuckDB ready (in-memory - data will not persist)')
        toast({
          title: 'In-Memory Mode',
          description: 'Your browser does not support persistent storage. Data will be lost on refresh.',
          variant: 'default',
        })
      }
    })
    .catch((err) => {
      console.error('Failed to initialize DuckDB:', err)
      toast({
        title: 'Database Error',
        description: 'Failed to initialize the data engine',
        variant: 'destructive',
      })
    })
}, [])
```

**Why:** User gets immediate feedback on storage mode (OPFS vs in-memory)

**Note:** Migration happens transparently in `initDuckDB()`. Tables are already loaded when this hook runs. No additional restoration needed in the hook.

---

### 7. Modified: Deprecate Manual Persistence

**File:** `src/hooks/usePersistence.ts` (MODIFIED)

**Approach:** Mark as deprecated, show migration notice, remove save/load logic

**Changes:**
```typescript
/**
 * @deprecated Auto-persistence is now enabled for OPFS-capable browsers.
 * Manual save is no longer needed. This hook remains for backward compatibility.
 */
export function usePersistence() {
  const [hasShownNotice, setHasShownNotice] = useState(false)

  useEffect(() => {
    if (!hasShownNotice && isDuckDBPersistent()) {
      toast({
        title: 'Auto-Save Enabled',
        description: 'Your data now saves automatically. No manual save needed!',
      })
      setHasShownNotice(true)
    }
  }, [hasShownNotice])

  return {
    isAvailable: false,
    saveToStorage: async () => { /* no-op */ },
    loadFromStorage: async () => { /* no-op */ },
    clearStorage: async () => {
      // Keep this - users may want to clear data
      await clearOPFSDatabase()
      window.location.reload()
    },
  }
}
```

**Why:** Graceful deprecation - existing code doesn't break, users get migration notice

---

## Implementation Sequence

### Phase 1: Foundation (Days 1-2)

**Goal:** Create utilities and browser detection without changing behavior

**Tasks:**
1. Create `src/lib/duckdb/browser-detection.ts`
   - Implement `detectBrowserCapabilities()`
   - Unit test: Chrome/Safari return `hasOPFS: true`, Firefox returns `false`

2. Create `src/lib/duckdb/storage-info.ts`
   - Implement `getStorageInfo()`
   - Export `isPersistent` flag

3. Create `src/lib/duckdb/opfs-migration.ts` (stub only)
   - Implement detection logic (`hasLegacyStorage()`)
   - Implement CSV reading from OPFS
   - Defer actual migration until Phase 2

**Validation:**
- Run existing Playwright tests → all pass (no behavior change)
- Unit test browser detection with mocked `navigator.userAgent`

---

### Phase 2: OPFS Integration (Days 3-4)

**Goal:** Enable OPFS-backed DuckDB with compression

**Tasks:**
1. Modify `src/lib/duckdb/index.ts`
   - Add browser detection call
   - Add conditional `.open()` logic (OPFS vs memory)
   - Enable compression pragmas
   - Export `isDuckDBPersistent()` and `flushDuckDB()`

2. Test in Chrome DevTools
   - Load CSV file
   - Check OPFS: Application → Storage → Origin Private File System
   - Verify `cleanslate.db` file exists
   - Refresh page → data persists

3. Test in Firefox
   - Load CSV file
   - Verify in-memory mode logs
   - Refresh page → data lost (expected)

**Validation:**
- Chrome: Data persists after refresh
- Firefox: Shows in-memory warning, data lost on refresh
- Memory usage in Chrome: 240MB CSV → ~500-700MB (2-3x reduction from compression)

---

### Phase 3: Migration Implementation (Days 5-6)

**Goal:** Auto-migrate existing CSV storage to DuckDB format

**Tasks:**
1. Complete `opfs-migration.ts` implementation
   - Use DuckDB's `CREATE TABLE FROM read_csv_auto('opfs://...')`
   - Import all tables from `cleanslate/tables/*.csv`
   - Import audit details from `cleanslate/audit_details.csv`
   - Delete legacy files after success

2. Test migration manually
   - Create fake legacy storage (metadata.json + CSV files)
   - Load app → verify migration logs
   - Check tables restored correctly
   - Verify legacy files deleted

3. Handle edge cases
   - Missing audit_details.csv (optional)
   - Malformed CSV (skip table, continue)
   - Partial migration failure (preserve originals)

**Validation:**
- Migration restores all tables with correct row counts
- Audit log preserved
- Legacy OPFS directory cleaned up
- Second load skips migration (no metadata.json found)

---

### Phase 4: Auto-Persist (Days 7-8)

**Goal:** Enable auto-flush after every command

**Tasks:**
1. Modify `src/lib/commands/executor.ts`
   - Add `flushDuckDB()` call (debounced) after `updateTableStore()`
   - Add error handling (non-fatal)

2. Modify `src/hooks/useDuckDB.ts`
   - Show persistence status toast on init
   - Firefox warning for in-memory mode

3. Deprecate `src/hooks/usePersistence.ts`
   - Remove save/load logic
   - Show migration notice
   - Keep `clearStorage()`

4. **NEW: Implement audit log pruning**
   - Create `src/lib/audit-pruning.ts` utility
   - Keep only last 100 entries in `_audit_details` table
   - Prune on app init (after migration): `DELETE FROM _audit_details WHERE entry_id NOT IN (SELECT entry_id FROM _audit_details ORDER BY timestamp DESC LIMIT 100)`
   - Prevents database bloat over months of use

5. **NEW: Add beforeunload handler**
   - Create `src/hooks/useBeforeUnload.ts`
   - Call `flushDuckDB(true)` on window.beforeunload
   - Ensures pending debounced flush completes before tab closes

6. Test auto-persistence
   - Apply transformation in Chrome
   - Refresh immediately (no manual save)
   - Verify transformation persisted
   - Apply 10 rapid transformations → verify only one flush after 1s idle
   - Close tab immediately after edit → reopen → verify data persisted (beforeunload flush)

**Validation:**
- Transformations persist without manual save
- OPFS file size grows after operations
- Audit log persists across refresh
- Timeline snapshots persist

---

### Phase 5: Integration Testing (Days 9-10)

**Goal:** Create regression test to prevent memory creep

**Tasks:**
1. Create `e2e/tests/memory-optimization.spec.ts`
   - Use 50k row fixture (20 columns, ~50MB file)
   - Load CSV → verify memory < 200MB
   - Apply 5 transformations → verify memory < 300MB
   - Compare to baseline (without compression: expect 500MB+)

2. Add to CI pipeline
   - Run on Chrome only (OPFS test)
   - Fail if memory exceeds threshold

3. Document performance characteristics
   - Update CLAUDE.md with OPFS backend details
   - Document compression savings (30-50%)
   - Document load time improvements (10-100x)

**Validation:**
- E2E test passes on Chrome
- Memory regression prevented
- Documentation accurate

---

## Data Flow Diagrams

### Initialization Flow (First Load with Legacy Data)

```
User opens app
      ↓
useDuckDB.useEffect()
      ↓
initDuckDB()
      ↓
detectBrowserCapabilities()
      ├─ Chrome/Edge/Safari → { hasOPFS: true, supportsAccessHandle: true }
      └─ Firefox → { hasOPFS: false }
      ↓
db.open({ path: 'opfs://cleanslate.db' })  [Chrome]
db.open({ path: ':memory:' })               [Firefox]
      ↓
migrateFromCSVStorage()  [Chrome only]
      ├─ Check for metadata.json
      ├─ If found:
      │   ├─ CREATE TABLE FROM read_csv_auto('opfs://cleanslate/tables/t1.csv')
      │   ├─ CREATE TABLE FROM read_csv_auto('opfs://cleanslate/tables/t2.csv')
      │   ├─ Import audit_details.csv → _audit_details
      │   └─ Delete cleanslate/ directory
      └─ Return { migrated: true, tablesImported: 2 }
      ↓
SET memory_limit = '3GB'
PRAGMA enable_object_cache=true
PRAGMA force_compression='zstd'
      ↓
DuckDB ready (isPersistent = true/false)
      ↓
App renders with data
```

### Command Execution Flow (Auto-Persist)

```
User applies transformation (e.g., TRIM column)
      ↓
CommandExecutor.execute()
      ↓
Validate → Snapshot → Execute SQL → Diff → Audit
      ↓
updateTableStore()  (increment dataVersion → grid refreshes)
      ↓
flushDuckDB()
      ├─ OPFS mode: PRAGMA wal_checkpoint(TRUNCATE)
      │   → Writes WAL to cleanslate.db in OPFS
      └─ Memory mode: no-op
      ↓
Transformation complete (data persisted)
```

### Page Refresh Flow (OPFS Mode)

```
User refreshes browser
      ↓
initDuckDB()
      ↓
db.open({ path: 'opfs://cleanslate.db' })
      ↓
DuckDB auto-loads existing database file
      ↓
Tables, snapshots, audit details all restored
      ↓
tableStore.hydrate()  (rebuild metadata from DuckDB)
      ↓
App renders with previous session data
```

---

## Critical Implementation Details

### Browser Detection

**Chrome/Edge Detection:**
```typescript
const ua = navigator.userAgent.toLowerCase()
if (ua.includes('edg/')) return 'edge'
if (ua.includes('chrome') && !ua.includes('edg/')) return 'chrome'
```

**Safari Detection:**
```typescript
if (ua.includes('safari') && !ua.includes('chrome')) return 'safari'
```

**Firefox Detection:**
```typescript
if (ua.includes('firefox')) return 'firefox'
```

**OPFS AccessHandle Check:**
```typescript
const hasAccessHandle = 'createSyncAccessHandle' in FileSystemFileHandle.prototype
```

---

### Migration Strategy

**Detection:**
1. Check if `opfs://cleanslate.db` exists → skip migration
2. Check if `cleanslate/metadata.json` exists → run migration
3. Otherwise → fresh start

**CSV Import via DuckDB:**
```sql
CREATE OR REPLACE TABLE "table_name" AS
SELECT * FROM read_csv_auto('opfs://cleanslate/tables/{id}.csv')
```

**Why DuckDB's `read_csv_auto()` instead of manual parsing:**
- Native C++ CSV parser (10-100x faster than JS)
- Handles quoted fields, escaped chars, encodings
- Direct write to OPFS-backed table (no intermediate buffer)

**Cleanup:**
```typescript
const root = await navigator.storage.getDirectory()
await root.removeEntry('cleanslate', { recursive: true })
```

---

### Compression Configuration

**Pragmas:**
```sql
PRAGMA enable_object_cache=true  -- Cache parsed objects (reduces recomputation)
PRAGMA force_compression='zstd'  -- Force zstd compression (level 6 default)
```

**Expected Impact:**
- 30-50% memory reduction for typical datasets
- Higher reduction for text-heavy data (70%+)
- Minimal CPU overhead (zstd is fast)

---

### Error Handling

**Initialization Errors:**
- OPFS init fails → fallback to `:memory:` (log error, show warning)
- Migration fails → log error, continue with empty DB (preserve CSV files)

**Flush Errors:**
- Non-fatal → log warning, continue (next flush will retry)
- Show toast: "Auto-save temporarily unavailable"

**Migration Errors:**
- Table import fails → skip table, log error, continue with others
- Audit import fails → non-fatal (app works without audit history)
- Cleanup fails → non-fatal (legacy files remain, harmless)

---

### State Management

**Module-level state in `duckdb/index.ts`:**
```typescript
let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null
let isPersistent = false  // NEW: Track persistence mode
```

**Zustand stores unchanged:**
- `tableStore`: Still manages table metadata (name, columns, rowCount)
- `auditStore`: Still manages audit entries in memory
- `timelineStore`: Still manages timeline positions
- DuckDB is source of truth for actual data

**Important:** Stores don't duplicate data - they cache metadata only.

---

## Testing Strategy

### Unit Tests (New)

**`browser-detection.test.ts`:**
- Mock `navigator.userAgent` → Chrome → expect `hasOPFS: true`
- Mock `navigator.userAgent` → Firefox → expect `hasOPFS: false`
- Mock missing `storage.getDirectory()` → expect graceful fallback

**`opfs-migration.test.ts`:**
- Mock OPFS with fake metadata.json → expect migration success
- Mock missing metadata.json → expect `migrated: false`
- Mock malformed CSV → expect skip + continue

### Integration Tests (Existing)

**No changes needed** - existing Playwright tests will pass:
- File upload tests → work with OPFS backend
- Transformation tests → auto-persist transparently
- Audit log tests → persist to OPFS

### E2E Tests (New)

**`memory-optimization.spec.ts`:**
```typescript
test('should reduce memory footprint with compression', async ({ page }) => {
  await page.goto('/')

  // Load 50k row fixture (~50MB CSV)
  const fixture = getFixturePath('large-dataset-50k.csv')
  await uploadFile(page, fixture)

  // Get memory status
  const memoryBefore = await inspector.getMemoryStatus()
  expect(memoryBefore.usedBytes).toBeLessThan(200 * 1024 * 1024) // <200MB

  // Apply 5 transformations
  await applyTransform('trim', 'column1')
  await applyTransform('uppercase', 'column2')
  // ... 3 more transforms

  // Memory should not exceed 300MB
  const memoryAfter = await inspector.getMemoryStatus()
  expect(memoryAfter.usedBytes).toBeLessThan(300 * 1024 * 1024)
})
```

**`opfs-persistence.spec.ts`:**
```typescript
test.describe.serial('OPFS Persistence', () => {
  test('should persist data across page refresh', async ({ page }) => {
    // Load CSV
    await uploadFile(page, 'basic-data.csv')
    const rowCount = await inspector.getRowCount('basic_data')

    // Apply transformation
    await applyTransform('uppercase', 'name')

    // Refresh page (hard reload)
    await page.reload()
    await inspector.waitForDuckDBReady()

    // Verify data persisted
    const rowCountAfter = await inspector.getRowCount('basic_data')
    expect(rowCountAfter).toBe(rowCount)

    const data = await inspector.getTableData('basic_data')
    expect(data[0].name).toBe('ALICE') // Uppercase transformation persisted
  })

  test('should auto-migrate legacy CSV storage', async ({ page }) => {
    // Pre-populate OPFS with legacy metadata.json + CSV
    await createLegacyStorage(page)

    // Load app
    await page.goto('/')
    await inspector.waitForDuckDBReady()

    // Verify tables restored
    const tables = await inspector.getTables()
    expect(tables).toContain('legacy_table_1')
    expect(tables).toContain('legacy_table_2')

    // Verify legacy files deleted
    const hasLegacy = await checkForLegacyStorage(page)
    expect(hasLegacy).toBe(false)
  })
})
```

---

## Rollback Strategy

**If OPFS implementation fails in production:**

1. **Immediate rollback:**
   - Revert commits for `initDuckDB()` changes
   - Keep compression pragmas (safe, beneficial even in-memory)
   - Users fall back to in-memory mode
   - No data loss (OPFS file preserved)

2. **Gradual rollout:**
   - Add feature flag: `ENABLE_OPFS_STORAGE`
   - Default to `false` initially
   - Enable for 10% of users → monitor errors
   - Gradually increase to 100%

3. **Fallback UX:**
   - If OPFS fails, show toast: "Persistent storage unavailable, using in-memory mode"
   - Keep manual "Export CSV" button for backup
   - Document Firefox limitations in help docs

---

## Success Metrics

### Functional Requirements
- [ ] Chrome/Edge/Safari users see persistent storage (check OPFS file exists)
- [ ] Firefox users see in-memory warning banner
- [ ] Data persists across page refresh (Chrome/Edge/Safari)
- [ ] Legacy CSV storage auto-migrates on first load
- [ ] Transformations auto-save (no manual save button)
- [ ] Audit log persists across sessions
- [ ] Timeline snapshots persist

### Performance Requirements
- [ ] Memory footprint: 240MB CSV → 500-700MB (2-3x reduction, not 6x)
- [ ] Load time: <500ms for 50k rows (vs 2-5 seconds with CSV parsing)
- [ ] Save time: <50ms per operation (WAL checkpoint)
- [ ] Compression: 30-50% storage reduction
- [ ] No regression in transformation speed

### Maintainability Requirements
- [ ] Zero breaking changes to existing commands
- [ ] All existing Playwright tests pass
- [ ] New E2E tests for persistence and memory
- [ ] Documentation updated (CLAUDE.md)
- [ ] Code coverage: 80%+ for new utilities

---

## File Modification Summary

### Files to Create (7)
1. `src/lib/duckdb/browser-detection.ts` (~70 lines) - Browser capability detection
2. `src/lib/duckdb/opfs-migration.ts` (~150 lines) - Legacy CSV migration with row count verification
3. `src/lib/duckdb/storage-info.ts` (~80 lines) - Storage backend info + quota monitoring
4. `src/lib/audit-pruning.ts` (~40 lines) - **NEW: Keep last 100 audit entries**
5. `src/hooks/useBeforeUnload.ts` (~30 lines) - **NEW: Immediate flush on tab close**
6. `e2e/tests/memory-optimization.spec.ts` (~100 lines)
7. `e2e/tests/opfs-persistence.spec.ts` (~150 lines)

### Files to Modify (4)
1. `src/lib/duckdb/index.ts`
   - `initDuckDB()`: Browser detection + OPFS/memory init + double-tab handling (~60 lines added)
   - Export `isDuckDBPersistent()`, `isDuckDBReadOnly()`, and `flushDuckDB()` (~40 lines added)
   - **NEW: Debounced flush with 1-second idle timer**

2. `src/lib/commands/executor.ts`
   - Add debounced `flushDuckDB()` call after `updateTableStore()` (~3 lines)

3. `src/hooks/useDuckDB.ts`
   - Add persistence status toast (~10 lines)
   - **NEW: Call audit pruning utility on init**

4. `src/hooks/usePersistence.ts`
   - Deprecate save/load, show migration notice (~20 lines modified)

### Files to Deprecate (1)
- `src/lib/opfs/storage.ts` - Keep for helper functions only, mark as `@deprecated`

---

## Verification Plan

### Manual Testing Checklist

**Chrome (OPFS mode):**
1. [ ] Open DevTools → Application → Storage → OPFS → verify `cleanslate.db` exists
2. [ ] Load 240MB CSV → check memory (should be <800MB, not 1.5GB)
3. [ ] Apply transformation → refresh immediately → data persists
4. [ ] Create 10 timeline snapshots → refresh → verify snapshots persist
5. [ ] **NEW: Open second tab** → verify read-only mode warning appears
6. [ ] **NEW: Apply 10 rapid transformations** → wait 1 second → verify only one flush log
7. [ ] **NEW: Check storage quota** → verify UI shows usage percentage
8. [ ] **NEW: Verify audit pruning** → create 150 audit entries → refresh → check only last 100 remain

**Firefox (in-memory mode):**
1. [ ] Load CSV → see "In-memory mode" warning
2. [ ] Apply transformation → refresh → data lost (expected)
3. [ ] Export CSV manually → verify export works
4. [ ] Check console for "In-memory mode" log

**Migration (first load with legacy data):**
1. [ ] Manually create `cleanslate/metadata.json` + CSV files in OPFS
2. [ ] Load app → verify "Migrated X tables" console log
3. [ ] Check tables restored with correct row counts
4. [ ] Verify legacy `cleanslate/` directory deleted
5. [ ] Refresh again → migration skipped (no metadata.json found)

### Automated Testing

**Run existing tests:**
```bash
npm test  # All Playwright tests should pass
```

**Run new tests:**
```bash
npm test -- memory-optimization  # Memory regression test
npm test -- opfs-persistence     # OPFS persistence test
```

**Verify coverage:**
```bash
npm run test:coverage  # Should be 80%+ for new files
```

---

## Timeline

**Total Duration:** 1-1.5 weeks (10 working days)

| Phase | Days | Deliverable |
|-------|------|-------------|
| Phase 1: Foundation | 1-2 | Utilities created, tests passing |
| Phase 2: OPFS Integration | 3-4 | OPFS working in Chrome, fallback in Firefox |
| Phase 3: Migration | 5-6 | Legacy CSV migration complete |
| Phase 4: Auto-Persist | 7-8 | Commands auto-flush, manual save removed |
| Phase 5: Testing | 9-10 | E2E tests written, CI passing, docs updated |

---

## Risk Assessment

### High Risk
- **Migration failures** (malformed CSV, encoding issues)
  - Mitigation: Skip failed tables, preserve originals, log errors
  - Fallback: Manual re-import tool in Settings

### Medium Risk
- **Firefox users lose persistence** (browser limitation)
  - Mitigation: Show clear warning banner, keep manual export
  - Acceptance: This is a known limitation, acceptable trade-off

### Low Risk
- **OPFS quota limits** (browsers cap storage at ~5-10GB)
  - Mitigation: Show storage usage in UI, warn at 80%
  - Long-term: Implement table archival/deletion

### Very Low Risk
- **Performance regression** (compression overhead)
  - Mitigation: Benchmark shows zstd is fast, negligible overhead
  - Validation: E2E tests verify no slowdown

---

## Open Questions

None - all decisions approved by user in Phase 3.

---

## References

### Research Sources
- [DuckDB-WASM OPFS Discussion](https://github.com/duckdb/duckdb-wasm/discussions/1470)
- [OPFS Caching with DuckDB-WASM](https://medium.com/@hadiyolworld007/opfs-caching-ftw-react-duckdb-wasm-blazing-parquet-0442ff695db5)
- [DuckDB and OPFS for Browser Storage](https://markwylde.com/blog/duckdb-opfs-todo-list/)
- [Memory Management in DuckDB](https://duckdb.org/2024/07/09/memory-management)
- [Origin Private File System (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)

### Codebase Files
- `src/lib/duckdb/index.ts` - Current DuckDB initialization
- `src/lib/opfs/storage.ts` - Legacy CSV persistence
- `src/hooks/useDuckDB.ts` - DuckDB React integration
- `src/lib/commands/executor.ts` - Command pattern orchestrator
- `CLAUDE.md` - Project documentation

---

## Next Steps After Implementation

1. **Monitor production metrics:**
   - Memory usage vs. file size ratio
   - OPFS storage consumption
   - Migration success rate
   - Browser distribution (OPFS vs in-memory)

2. **User education:**
   - Add tooltip: "Data saves automatically in Chrome/Safari/Edge"
   - Update help docs with browser compatibility matrix
   - FAQ: "Why doesn't Firefox persist data?"

3. **Future enhancements:**
   - Implement table archival (export old tables to free space)
   - Add manual OPFS cleanup tool (clear all data)
   - Explore IndexedDB fallback for Firefox (if OPFS lands)
   - Add storage quota warnings (80% usage alert)

4. **Performance tuning:**
   - Profile compression levels (zstd 1-9)
   - Benchmark WAL checkpoint frequency
   - Consider async flush (debounce 1 second)
   - Implement snapshot pruning enforcement (max 5 per table)
