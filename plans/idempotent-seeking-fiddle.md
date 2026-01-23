# Fix Test Failures

## Problem Summary

Test run shows 14 failing tests with two distinct failure patterns:

1. **Browser Crashes** (majority): "Target crashed", "Target page, context or browser has been closed"
2. **Audit Detail Capture Bug**: Missing `ensureAuditDetailsTable` call for Tier 1 transforms

---

## Issue 1: Browser Crashes - MEMORY EXHAUSTION

### Root Cause:

**System Memory:** 1.5GB available (7.7GB total, 6.2GB in use)

**Problem:** DuckDB configured for 3GB + 2 parallel workers = OOM crashes

---

## Implementation Plan

### Step 1: Reduce Playwright Workers

**File:** `playwright.config.ts`

**Change line 8:**
```typescript
workers: 1,  // Force single worker to prevent OOM on constrained systems
```

### Step 2: Make DuckDB Memory Limit Dynamic (via userAgent)

**File:** `src/lib/duckdb/index.ts`

**Replace lines 60-66 (the memory limit configuration):**
```typescript
// Configure memory limit based on environment
// Detect test environment via userAgent (set by Playwright config)
// Tests use small CSVs - 512MB is plenty
// Production uses 3GB (75% of 4GB WASM ceiling)
const isTestEnv = typeof navigator !== 'undefined' &&
                  navigator.userAgent.includes('Playwright');
const memoryLimit = isTestEnv ? '512MB' : '3GB';

const initConn = await db.connect()
await initConn.query(`SET memory_limit = '${memoryLimit}'`)
await initConn.close()

console.log(`DuckDB WASM: Using ${bundleType} bundle (${memoryLimit} memory limit)`)
```

### Step 3: Set Custom userAgent in Playwright

**File:** `playwright.config.ts`

**Update the `use` section (around line 17-22):**
```typescript
use: {
  baseURL: 'http://localhost:5173',
  trace: 'on-first-retry',
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  // ADD: Custom userAgent for test detection
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Playwright/Test',
},
```

**Why userAgent over window flag:** The userAgent is available immediately when the page loads (before any JS runs). This ensures `initDuckDB()` sees the test flag on first call, before any navigation/evaluation timing issues.

---

## Issue 2: Missing `ensureAuditDetailsTable` in Tier 1 Capture

### Root Cause:
`captureTier1RowDetails` in `executor.ts` (line ~775) does NOT call `ensureAuditDetailsTable(ctx.db)` before INSERT.

### Step 4: Fix Audit Table Initialization

**File:** `src/lib/commands/executor.ts`

**Add at line ~775 (start of `captureTier1RowDetails` method body):**
```typescript
private async captureTier1RowDetails(
  ctx: CommandContext,
  column: string,
  auditEntryId: string
): Promise<void> {
  // ADD THIS LINE:
  await ensureAuditDetailsTable(ctx.db)

  const baseColumn = getBaseColumnName(column)
  // ... rest unchanged
}
```

---

## Files to Modify Summary

| File | Change |
|------|--------|
| `playwright.config.ts` | Set `workers: 1` + add custom `userAgent` containing "Playwright" |
| `src/lib/duckdb/index.ts` | Detect `navigator.userAgent.includes('Playwright')` for 512MB limit |
| `src/lib/commands/executor.ts` | Add `ensureAuditDetailsTable(ctx.db)` in `captureTier1RowDetails` |

---

## Verification

1. Run tests with changes:
   ```bash
   npm test
   ```

2. Expected: No browser crashes, audit tests should pass

3. If crashes persist, verify memory flag is being injected:
   ```bash
   npm test -- --workers=1 --debug
   ```

---

## Risk Assessment

- **Memory changes:** Safe - only affects test environment
- **Audit fix:** Minimal - `ensureAuditDetailsTable` is idempotent (CREATE TABLE IF NOT EXISTS)
- **Worker reduction:** Tests run slower but reliably
