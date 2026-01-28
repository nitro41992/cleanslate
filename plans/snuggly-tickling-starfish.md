# Plan: Enhanced Status Bar Indicators

## Overview

Two enhancements to CleanSlate Pro's bottom status bar:
1. **Snapshot Progress Indicator** - Show save queue depth and current operation
2. **Enhanced Memory Indicator** - Provide meaningful metrics and usage breakdown

---

## Feature 1: Snapshot Progress Indicator

### Problem
Users see only "Saving..." with no visibility into queue depth, which table is being saved, or chunked export progress.

### Solution
Expose save queue state from `usePersistence.ts` to `uiStore.ts`, then display in an enhanced indicator with tooltip details.

### UI Mockup
```
StatusBar:  [ Saving 1 of 3... [==  ] ]

Tooltip (hover):
+----------------------------------+
| Currently saving:                |
|   - Raw_Data (chunk 2/4)         |
| Queued:                          |
|   - Cleaned_Data                 |
|   - Final_Output                 |
| 47 cell edits pending compaction |
+----------------------------------+
```

### State Changes (uiStore.ts)

```typescript
// NEW state fields
savingTables: string[]           // Tables currently being saved
pendingTables: string[]          // Tables queued for next save
chunkProgress: {                 // Chunked export progress (null if not chunking)
  tableName: string
  currentChunk: number
  totalChunks: number
} | null
compactionStatus: 'idle' | 'running'
pendingChangelogCount: number    // Cell edits pending compaction

// NEW actions
addSavingTable: (tableName: string) => void
removeSavingTable: (tableName: string) => void
addPendingTable: (tableName: string) => void
removePendingTable: (tableName: string) => void
setChunkProgress: (progress) => void
setCompactionStatus: (status) => void
setPendingChangelogCount: (count: number) => void
```

### Hook Changes (usePersistence.ts)

Wire up save lifecycle callbacks:
```typescript
// In saveTable():
uiStore.addSavingTable(tableName)  // on start
uiStore.removeSavingTable(tableName)  // on complete

// In coalescing logic:
uiStore.addPendingTable(tableName)  // when queued for re-save

// In compaction:
uiStore.setCompactionStatus('running')  // on start
uiStore.setPendingChangelogCount(count)  // after check
```

### snapshot-storage.ts Changes

Add optional progress callback for chunked exports:
```typescript
interface ExportOptions {
  onChunkProgress?: (current: number, total: number) => void
}
```

---

## Feature 2: Enhanced Memory Indicator

### Problem
- Number doesn't match Chrome's RAM (only tracks DuckDB heap, not total browser memory)
- No breakdown of what's consuming memory
- Arbitrary percentage thresholds with no context

### Solution
Show percentage (clearer than raw bytes), add breakdown tooltip, track usage metrics for future monetization.

### UI Mockup
```
StatusBar:  [ [====    ] 42% ]

Tooltip (hover):
+----------------------------------+
| DuckDB Memory        412 MB / 2GB |
+----------------------------------+
| Your Data      [========]  312 MB |
| Undo History   [===     ]   78 MB |
| Diff View      [=       ]   12 MB |
| Engine         [=       ]   10 MB |
+----------------------------------+
| Memory usage is high.            |
| Consider deleting unused tables. |
+----------------------------------+
| 3 tables | 1.2M rows             |
+----------------------------------+
```

### State Changes (uiStore.ts)

```typescript
// NEW state fields
memoryBreakdown: {
  tableDataBytes: number     // User tables
  timelineBytes: number      // _timeline_*, snapshot_*, _original_*
  diffBytes: number          // _diff_* tables
  overheadBytes: number      // Buffer pool, indexes, temp storage
}

usageMetrics: {              // For future monetization
  totalTables: number
  totalRows: number
  opfsUsedBytes: number
  peakMemoryBytes: number
  transformCount: number
}

// NEW actions
setMemoryBreakdown: (breakdown) => void
updateUsageMetrics: (metrics: Partial<UsageMetrics>) => void
```

### memory.ts Changes

Add breakdown calculation:
```typescript
export async function getMemoryBreakdown(): Promise<MemoryBreakdown> {
  const tableSizes = await getEstimatedTableSizes()
  // Categorize by table name prefix:
  // - _timeline_*, snapshot_*, _original_* → timelineBytes
  // - _diff_* → diffBytes
  // - others → tableDataBytes
  // - remainder → overheadBytes
}
```

---

## Implementation Sequence

### Phase 1: State Infrastructure
- [ ] Add queue state fields to `uiStore.ts`
- [ ] Add memory breakdown fields to `uiStore.ts`
- [ ] Add usage metrics fields to `uiStore.ts`

### Phase 2: Hook Wiring
- [ ] Add save lifecycle callbacks in `usePersistence.ts`
- [ ] Add chunk progress callback in `snapshot-storage.ts`
- [ ] Wire compaction status and changelog count

### Phase 3: Memory Tracking
- [ ] Add `getMemoryBreakdown()` to `memory.ts`
- [ ] Update `refreshMemory()` to also fetch breakdown
- [ ] Track OPFS usage via `navigator.storage.estimate()`

### Phase 4: UI Components
- [ ] Enhance `PersistenceIndicator.tsx` with queue display + tooltip
- [ ] Enhance `MemoryIndicator.tsx` with percentage + breakdown tooltip
- [ ] Keep both compact and full views working

---

## Critical Files

| File | Changes |
|------|---------|
| `src/stores/uiStore.ts` | Add queue state, memory breakdown, usage metrics |
| `src/hooks/usePersistence.ts` | Wire save lifecycle callbacks |
| `src/lib/opfs/snapshot-storage.ts` | Add chunk progress callback |
| `src/lib/duckdb/memory.ts` | Add `getMemoryBreakdown()` |
| `src/components/common/PersistenceIndicator.tsx` | Queue depth + tooltip |
| `src/components/common/MemoryIndicator.tsx` | Percentage + breakdown tooltip |

---

## Verification

1. **Queue indicator**: Load 3 tables, edit all, trigger save - should show "Saving 1 of 3..."
2. **Chunk progress**: Import 500k+ row file - should show chunk N/M during save
3. **Memory breakdown**: Hover tooltip should show categorized bars
4. **Compaction**: Make 1000+ cell edits, should see changelog count then compaction status

---

## Research Sources

- [NN/g Progress Indicators](https://www.nngroup.com/articles/progress-indicators/) - Determinate for 3-10s, multi-modal for longer
- [web.dev Memory Monitoring](https://web.dev/articles/monitor-total-page-memory-usage) - `measureUserAgentSpecificMemory()` limitations
- [Maxio Usage-Based Pricing](https://www.maxio.com/blog/consumption-based-billing) - 67% of SaaS use usage-based pricing
- [Stripe Usage Pricing Guide](https://stripe.com/resources/more/usage-based-pricing-for-saas-how-to-make-the-most-of-this-pricing-model) - Real-time dashboards best practice
