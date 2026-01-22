# Memory Usage Bar & DuckDB Memory Management

## Problem Summary

1. **Usage bar doesn't update** when loading tables or doing transforms
2. **Root cause**: `performance.memory` tracks the main thread's JS heap, but DuckDB-WASM runs in a Web Worker with its own separate WASM heap
3. **4GB limit**: WebAssembly has a hard 4GB limit due to 32-bit pointers - this applies to the Worker's WASM heap

```
Main Thread (JS Heap)          Web Worker
┌─────────────────────┐       ┌─────────────────────┐
│ React UI, state     │       │ DuckDB-WASM Heap    │
│ ~200MB              │       │ ≤ 4GB (WASM limit)  │
│                     │       │ ← ALL TABLE DATA    │
│ performance.memory  │       │                     │
│ tracks THIS (wrong!)│       │ (not visible to     │
└─────────────────────┘       │  performance.memory)│
                              └─────────────────────┘
```

---

## Solution: Query DuckDB for Actual Memory Usage

DuckDB provides built-in functions to query its memory:

```sql
-- Get memory by component (buffer manager, tables, indexes, etc.)
SELECT * FROM duckdb_memory()

-- Get table metadata including estimated row counts
SELECT table_name, estimated_size, column_count FROM duckdb_tables()
```

---

## Implementation Plan

### Step 1: Create Memory Tracking Utilities

**New file:** `src/lib/duckdb/memory.ts`

```typescript
export const MEMORY_LIMIT_BYTES = 3 * 1024 * 1024 * 1024  // 3GB (75% of 4GB ceiling)
export const AVG_BYTES_PER_CELL = 50  // Conservative estimate

export interface DuckDBMemoryInfo {
  totalBytes: number
  byTag: Record<string, number>  // BASE_TABLE, HASH_TABLE, etc.
}

export interface MemoryStatus {
  usedBytes: number
  limitBytes: number
  percentage: number
  level: 'normal' | 'warning' | 'critical'
}

// Query DuckDB's internal memory usage
export async function getDuckDBMemoryUsage(): Promise<DuckDBMemoryInfo>

// Estimate total table data size (rows × columns × avgBytesPerCell)
export async function getEstimatedTableSize(): Promise<number>

// Combined status for UI
export async function getMemoryStatus(): Promise<MemoryStatus>
```

### Step 2: Set Memory Limit at DuckDB Init

**File:** `src/lib/duckdb/index.ts`

After `db.instantiate()`, configure a 3GB limit (leaving 1GB headroom):

```typescript
const initConn = await db.connect()
await initConn.query(`SET memory_limit = '3GB'`)
await initConn.close()
```

### Step 3: Update MemoryIndicator Component

**File:** `src/components/common/MemoryIndicator.tsx`

Replace `performance.memory` polling with DuckDB queries:

```typescript
useEffect(() => {
  if (!isDuckDBReady) return

  const updateMemory = async () => {
    const status = await getMemoryStatus()
    setMemoryUsage(status.usedBytes)
    setMemoryLimit(status.limitBytes)
  }

  updateMemory()
  const interval = setInterval(updateMemory, 5000)
  return () => clearInterval(interval)
}, [isDuckDBReady])
```

### Step 4: Update uiStore

**File:** `src/stores/uiStore.ts`

- Change `memoryLimit` default from 4GB to 3GB
- Add optional `memoryDetails` for breakdown display

### Step 5: Add Pre-Load Capacity Check

**File:** `src/hooks/useDuckDB.ts`

Before loading a file, check if there's enough headroom:

```typescript
const estimatedImpact = file.size * 2  // Files expand ~2x in memory
const status = await getMemoryStatus()

if (status.percentage + (estimatedImpact / status.limitBytes * 100) > 90) {
  toast.warning('Loading this file may exceed available memory')
}
```

---

## Safety Margins & Thresholds

| Level | Percentage | Indicator Color | Action |
|-------|------------|-----------------|--------|
| Normal | 0-60% | Blue/Green | None |
| Warning | 60-80% | Amber | Toast on file load |
| Critical | 80%+ | Red | Warning dialog, suggest deleting tables |

**Why 3GB limit (not 4GB)?**
- WASM ceiling is ~4GB
- Leave 1GB headroom for:
  - Temporary query buffers (sorts, joins)
  - DuckDB internal overhead
  - Browser GC pressure

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/duckdb/memory.ts` | **NEW** - Memory query utilities |
| `src/lib/duckdb/index.ts` | Add `SET memory_limit = '3GB'` at init, export `isDuckDBReady` if needed |
| `src/stores/uiStore.ts` | Change default `memoryLimit` to 3GB |
| `src/components/common/MemoryIndicator.tsx` | Replace `performance.memory` with `getMemoryStatus()` |

---

## Verification

1. **Load empty state** → Bar should show minimal usage (~0-50MB)
2. **Load 100K row CSV** → Bar should increase noticeably
3. **Apply transformations** → May show temporary spikes
4. **Delete table** → Bar should decrease
5. **Load multiple tables** → Watch bar approach warning threshold
6. **At 60%+** → Verify amber color
7. **At 80%+** → Verify red color

```bash
npm run lint
npm run dev  # Manual testing with large CSVs
```
