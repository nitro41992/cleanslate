# Memory Optimization Plan: JS Heap & WASM Mitigation

## Status Summary

| Optimization | Status | Notes |
|--------------|--------|-------|
| **A: Array-based data transfer** | ❌ REVERTED | Implemented then reverted per user request |
| **B: Smart compaction triggers** | 🟡 PARTIAL | Infrastructure complete, toast UI pending |

---

## Optimization A: Array-Based Data Transfer (HIGH IMPACT)

### Status: ❌ REVERTED

**Reason:** User decided to revert this optimization after implementation.

**What was built (now removed):**
- `ArrayPageResult` interface and `getTableDataAsArrays()` in `src/lib/duckdb/index.ts`
- `getDataAsArrays` wrapper in `src/hooks/useDuckDB.ts`
- Dual-mode support in `DataGrid.tsx` (array mode + object mode)
- `FEATURE_FLAGS.USE_ARRAY_DATA_TRANSFER` in `src/lib/constants.ts`

**Current state:** Code reverted to object-based data transfer only. No array optimization code remains.

---

## Optimization B: Smart Compaction Triggers (MEDIUM IMPACT)

### Status: 🟡 PARTIAL (Infrastructure Complete)

### Problem
Worker restart (only way to release WASM memory) requires manual "Compact Memory" click.

### Solution (Two-Phase Rollout)

**Phase B.1: Suggestion-Based (Initial)**
- Show a toast notification when memory is high: "Memory is full. Click here to optimize."
- User remains in control, no surprise restarts

**Phase B.2: Auto-Compaction (Later, Once Stable)**
- Upgrade to auto-compaction after B.1 proves stable in production
- Add safety checks: not during active operations, user idle ≥5 min

### Implementation Progress

| Task | Status | File |
|------|--------|------|
| B1: Create idle-detector.ts | ✅ DONE | `src/lib/idle-detector.ts` |
| B2: Add shouldSuggestCompaction | ✅ DONE | `src/hooks/useDuckDB.ts` |
| B3: Post-operation toast in executor | ⬜ TODO | `src/lib/commands/executor.ts` |
| B4: Periodic check in AppShell | ⬜ TODO | `src/components/layout/AppShell.tsx` |
| B5: Auto-compaction upgrade | ⬜ FUTURE | - |

### What's Complete

#### 1. `src/lib/idle-detector.ts` ✅

```typescript
class IdleDetector {
  private lastActivityTime = Date.now()
  private callbacks = new Map<string, IdleCallback>()

  start(): void {
    // Tracks mousemove, keydown, scroll, click, touchstart
    // Checks idle state every 30s
  }

  registerCallback(id: string, cb: IdleCallback): void
  getIdleTimeMs(): number
  isIdle(): boolean  // Returns true if idle > 2 minutes
}

export const idleDetector = new IdleDetector()
```

#### 2. `src/hooks/useDuckDB.ts` - shouldSuggestCompaction ✅

```typescript
const shouldSuggestCompaction = useCallback(async (): Promise<boolean> => {
  const status = await getFullMemoryStatus()
  const idleTimeMs = idleDetector.getIdleTimeMs()

  // Threshold: 1.5GB memory usage AND 2+ minutes idle
  const MEMORY_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024
  const IDLE_THRESHOLD_MS = 2 * 60 * 1000

  return status.usedBytes > MEMORY_THRESHOLD_BYTES && idleTimeMs > IDLE_THRESHOLD_MS
}, [])
```

### What's Remaining

#### 3. `src/lib/commands/executor.ts` - Post-operation suggestion ⬜

```typescript
if (tier === 3 && ctx.table.rowCount > 100_000) {
  const memorySpike = memoryAfter.usedBytes - memoryBefore.usedBytes
  if (memorySpike > 500_MB) {
    // Show suggestion toast, don't auto-compact
    setTimeout(async () => {
      if (await shouldSuggestCompaction()) {
        toast({
          title: 'Memory usage is high',
          description: 'Click to optimize memory and improve performance.',
          action: <ToastAction onClick={compactMemory}>Optimize</ToastAction>,
          duration: 10_000,
        })
      }
    }, 5_000)
  }
}
```

#### 4. `src/components/layout/AppShell.tsx` - Periodic memory check ⬜

```typescript
useEffect(() => {
  idleDetector.start()

  // Check memory periodically during idle (every 60s)
  idleDetector.registerCallback('memory-suggestion', async () => {
    if (await shouldSuggestCompaction()) {
      toast({
        title: 'Memory usage is high',
        description: 'Click to free up memory.',
        action: <ToastAction onClick={compactMemory}>Optimize</ToastAction>,
        duration: 15_000,
      })
    }
  })

  return () => idleDetector.stop()
}, [])
```

#### 5. FUTURE: Auto-compaction upgrade (Phase B.2) ⬜

Once suggestion-based approach is stable, upgrade to auto-compaction:
```typescript
// Only auto-compact if:
// 1. Memory > 2GB (higher threshold than suggestions)
// 2. User idle > 5 minutes
// 3. No pending operations (busyCount === 0)
// 4. No unsaved changes (dirtyTables.size === 0)
if (await canAutoCompact()) {
  toast({ title: 'Optimizing memory...', duration: 2000 })
  await compactMemory()
}
```

---

## Verification

### Manual Testing
1. Load 100k+ row CSV
2. Open Chrome DevTools → Memory tab
3. For compaction: Wait 5+ min idle with >1GB memory, verify toast appears

### E2E Tests
- Add `e2e/tests/memory-optimization.spec.ts`
- Use existing `logMemoryUsage()` helper from `e2e/helpers/memory-monitor.ts`
- Verify data integrity after compaction (row identity preserved)

---

## What's Already Optimized (No Action Needed)

The undo/snapshot system already:
- Exports snapshots to Parquet files in OPFS (not keeping in-memory tables)
- Uses ~300x compression (1.5GB table → ~5MB file)
- Has global export queue preventing concurrent COPY TO operations
- Runs CHECKPOINT after large exports to release buffer pool

Files verified: `src/lib/timeline-engine.ts`, `src/lib/opfs/snapshot-storage.ts`
