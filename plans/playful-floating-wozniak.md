# Plan: Optimize Phonetic Blocking Performance

## Problem Statement

The phonetic blocking strategies (`metaphone_block`, `token_phonetic_block`, `fingerprint_block`) are slow because they **recompute phonetic keys every time "Find Duplicates" is clicked**. For 50k distinct values, this takes 5-18 seconds of CPU-bound JavaScript processing.

### Current Bottleneck Flow
```
Click "Find Duplicates"
  ↓
Query DISTINCT values (1-2 sec)           ← DB
  ↓
Generate phonetic keys in JS loop (5-18 sec) ← CPU BOTTLENECK
  ↓
Build CSV string (0.5 sec)                ← CPU
  ↓
Register CSV + CREATE TEMP TABLE (1-2 sec) ← DB
  ↓
Process blocks with SQL JOINs             ← DB (fast)
```

**Root cause:** Line 562-568 in `fuzzy-matcher.ts` loops through distinct values calling `generateBlockingKey()` synchronously.

---

## Research: Industry Best Practices

| Strategy | Source | Benefit |
|----------|--------|---------|
| **Pre-compute phonetic codes** | [Python Record Linkage Toolkit](https://recordlinkage.readthedocs.io/en/latest/performance.html) | "After phonetic encoding of string variables, exact comparing can be used instead of computing string similarity" |
| **Persist as columns** | [Splink](https://moj-analytical-services.github.io/splink/index.html) | Splink deduplicates 7M records in 2 min by pre-computing blocking keys |
| **Multi-column blocking** | Research consensus | "Block on 2+ variables dramatically reduces block sizes" |
| **Meta-blocking** | [arXiv Survey](https://arxiv.org/pdf/1905.06167) | Prunes 30-66% redundant comparisons |

---

## Proposed Solution: Persist Phonetic Keys as Hidden Columns

### Strategy
Compute phonetic keys **once** when the user first selects a phonetic strategy for a column, then persist them as hidden table columns (like `_cs_id`). Subsequent "Find Duplicates" clicks reuse the persisted keys.

### Key Insight
The codebase already has this pattern:
- `_cs_id` is a hidden column that persists in Parquet but is filtered from `columnOrder`
- `__base` backup columns work the same way
- Zero changes needed to persistence layer

### Expected Performance Gain
| Scenario | Before | After |
|----------|--------|-------|
| First search (cold) | 8-20 sec | 8-20 sec (same) |
| Subsequent searches | 8-20 sec | **< 2 sec** |
| After page refresh | 8-20 sec | **< 2 sec** (loaded from Parquet) |

---

## Implementation Phases

### Phase 1: Add Hidden Phonetic Key Columns

**Concept:** When user selects a phonetic strategy, check if the key column exists. If not, compute and persist it.

**Column naming convention:**
```
_phonetic_{column}_{algorithm}
```
Examples:
- `_phonetic_name_metaphone`
- `_phonetic_email_fingerprint`
- `_phonetic_full_name_token_phonetic`

**File: `src/lib/fuzzy-matcher.ts`**

New function:
```typescript
async function ensurePhoneticKeyColumn(
  tableName: string,
  matchColumn: string,
  strategy: BlockingStrategy
): Promise<string> {
  const keyColumnName = `_phonetic_${matchColumn}_${strategy}`

  // Check if column already exists
  const columns = await query(`DESCRIBE "${tableName}"`)
  if (columns.some(c => c.column_name === keyColumnName)) {
    return keyColumnName  // Already computed, reuse
  }

  // Column doesn't exist - compute and persist
  // 1. Query DISTINCT values
  // 2. Generate keys in JS (same logic as now)
  // 3. Bulk load via CSV into temp table
  // 4. ALTER TABLE ADD COLUMN
  // 5. UPDATE table SET keyColumn = tempTable.key WHERE value matches

  return keyColumnName
}
```

### Phase 2: Update Block Analysis to Use Persisted Keys

**File: `src/lib/fuzzy-matcher.ts`**

Update `analyzeBlocks()` and `processBlock()` to:
- Check for existing key column first
- Skip CSV registration if key column exists
- JOIN directly on the persisted column

```sql
-- Before (temp table JOIN):
SELECT pk.block_key, COUNT(*) as cnt
FROM "table" t
INNER JOIN _phonetic_temp pk ON CAST(t.column AS VARCHAR) = pk.value
GROUP BY pk.block_key

-- After (persisted column):
SELECT t._phonetic_name_metaphone as block_key, COUNT(*) as cnt
FROM "table" t
WHERE t._phonetic_name_metaphone IS NOT NULL
GROUP BY t._phonetic_name_metaphone
```

### Phase 3: Filter Hidden Columns from UI

**File: `src/stores/tableStore.ts`**

Update column filtering to hide phonetic key columns:
```typescript
const isInternalColumn = (name: string) =>
  name === '_cs_id' ||
  name.endsWith('__base') ||
  name.startsWith('_phonetic_')  // NEW
```

### Phase 4: Add Progress Indicator for Key Generation

**File: `src/features/matcher/components/MatchConfigPanel.tsx`**

Show progress during initial key computation:
```
┌─────────────────────────────────────┐
│ Preparing phonetic index...         │
│ ████████████░░░░░░░░  60%           │
│ Processing 30,000 of 50,000 values  │
└─────────────────────────────────────┘
```

**File: `src/stores/matcherStore.ts`**

Add state for indexing progress:
```typescript
indexingPhase: 'idle' | 'indexing' | 'ready'
indexingProgress: number  // 0-100
```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/lib/fuzzy-matcher.ts` | Add `ensurePhoneticKeyColumn()`, update `analyzeBlocks()` and `processBlock()` to use persisted columns |
| `src/stores/tableStore.ts` | Add `_phonetic_*` to internal column filter |
| `src/stores/matcherStore.ts` | Add `indexingPhase`, `indexingProgress` state |
| `src/features/matcher/components/MatchConfigPanel.tsx` | Show indexing progress UI |

---

## Detailed Implementation

### 1. `src/lib/fuzzy-matcher.ts`

**New helper - check/create phonetic key column:**
```typescript
const PHONETIC_COLUMN_PREFIX = '_phonetic_'

function getPhoneticColumnName(matchColumn: string, strategy: BlockingStrategy): string {
  // Sanitize column name for SQL identifier
  const sanitized = matchColumn.replace(/[^a-zA-Z0-9_]/g, '_')
  return `${PHONETIC_COLUMN_PREFIX}${sanitized}_${strategy}`
}

async function ensurePhoneticKeyColumn(
  tableName: string,
  matchColumn: string,
  strategy: BlockingStrategy,
  onProgress?: (percent: number, current: number, total: number) => void
): Promise<string> {
  const keyColumnName = getPhoneticColumnName(matchColumn, strategy)

  // Check if column exists
  const tableInfo = await query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = '${tableName}'
  `)

  if (tableInfo.some(c => c.column_name === keyColumnName)) {
    return keyColumnName  // Already computed
  }

  // Compute and persist the key column
  // 1. Add the column
  await query(`ALTER TABLE "${tableName}" ADD COLUMN "${keyColumnName}" VARCHAR`)

  // 2. Query distinct values
  const distinctValues = await query<{ value: string, row_ids: string }>(`
    SELECT CAST("${matchColumn}" AS VARCHAR) as value
    FROM "${tableName}"
    WHERE "${matchColumn}" IS NOT NULL
  `)

  // 3. Generate keys in batches with progress
  const BATCH_SIZE = 5000
  const total = distinctValues.length
  const updates: { value: string, key: string }[] = []

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = distinctValues.slice(i, i + BATCH_SIZE)
    for (const row of batch) {
      const key = generateBlockingKey(row.value, strategy)
      if (key) updates.push({ value: row.value, key })
    }
    onProgress?.(Math.round((i + batch.length) / total * 100), i + batch.length, total)
  }

  // 4. Bulk update via temp table + UPDATE JOIN
  const csvContent = 'value,block_key\n' +
    updates.map(u => `${escapeCsvValue(u.value)},${escapeCsvValue(u.key)}`).join('\n')

  const db = await initDuckDB()
  const csvFileName = `_keys_${Date.now()}.csv`
  await db.registerFileText(csvFileName, csvContent)

  await query(`
    CREATE TEMP TABLE _key_updates AS
    SELECT * FROM read_csv_auto('${csvFileName}', header=true)
  `)

  await query(`
    UPDATE "${tableName}" t
    SET "${keyColumnName}" = k.block_key
    FROM _key_updates k
    WHERE CAST(t."${matchColumn}" AS VARCHAR) = k.value
  `)

  await query(`DROP TABLE IF EXISTS _key_updates`)

  return keyColumnName
}
```

**Update `findDuplicatesChunked()`:**
```typescript
// Before block analysis, ensure key column exists
let keyColumnName: string | null = null
if (isPhoneticBlockingStrategy(blockingStrategy)) {
  keyColumnName = await ensurePhoneticKeyColumn(
    tableName,
    matchColumn,
    blockingStrategy,
    (percent, current, total) => {
      onProgress?.({
        phase: 'indexing',
        progress: percent,
        message: `Building phonetic index: ${current.toLocaleString()} of ${total.toLocaleString()}`
      })
    }
  )
}

// Then use keyColumnName in block analysis/processing
```

### 2. `src/stores/tableStore.ts`

**Update column visibility filter:**
```typescript
// In getVisibleColumns or similar:
const isInternalColumn = (name: string): boolean =>
  name === '_cs_id' ||
  name.endsWith('__base') ||
  name.startsWith('_phonetic_')
```

### 3. `src/stores/matcherStore.ts`

**Add indexing state:**
```typescript
interface MatcherState {
  // ... existing fields ...

  // Indexing state (for phonetic key column creation)
  indexingPhase: 'idle' | 'indexing' | 'ready'
  indexingProgress: number
  indexingMessage: string | null
}

// Initial state
indexingPhase: 'idle',
indexingProgress: 0,
indexingMessage: null,

// Action
setIndexingProgress: (phase, progress, message) => set({
  indexingPhase: phase,
  indexingProgress: progress,
  indexingMessage: message
})
```

### 4. `src/features/matcher/components/MatchConfigPanel.tsx`

**Show indexing progress when building index:**
```typescript
{store.indexingPhase === 'indexing' && (
  <div className="bg-muted rounded-lg p-3 space-y-2">
    <div className="flex items-center gap-2 text-sm">
      <Loader2 className="w-4 h-4 animate-spin" />
      <span>Building phonetic index...</span>
    </div>
    <Progress value={store.indexingProgress} />
    <p className="text-xs text-muted-foreground">
      {store.indexingMessage}
    </p>
  </div>
)}
```

---

## Edge Cases

| Case | Handling |
|------|----------|
| Column data changes after indexing | Key column becomes stale. **Solution:** Invalidate key columns when data in source column changes (via Command hooks) |
| Multiple strategies on same column | Each creates its own key column (`_phonetic_name_metaphone`, `_phonetic_name_fingerprint`) |
| Table imported from Parquet with key columns | Works automatically - columns persist and load |
| Column with special characters in name | Sanitize to valid SQL identifier |
| Empty/NULL values | Skip indexing, handle in block analysis |

---

## Verification Plan

### Manual Testing
1. Import table with 50k+ rows
2. Select phonetic strategy → observe indexing progress
3. Click "Find Duplicates" → should complete in < 2 sec
4. Refresh page → click "Find Duplicates" again → should still be fast (key column persisted)
5. Verify key columns hidden from data grid
6. Verify key columns included in CSV/Parquet export

### Performance Benchmark
```typescript
console.time('first-search')  // Should be 8-20 sec (key generation)
await findDuplicates()
console.timeEnd('first-search')

console.time('second-search')  // Should be < 2 sec (reuse keys)
await findDuplicates()
console.timeEnd('second-search')
```

---

## Future Optimizations (Out of Scope)

| Optimization | Effort | Benefit |
|--------------|--------|---------|
| Web Worker for key generation | High | Non-blocking UI during indexing |
| Multi-column blocking UI | Medium | 10x fewer comparisons |
| Meta-blocking (prune pairs) | High | 30-66% fewer comparisons |
| Incremental indexing | Medium | Only index new/changed rows |

---

## Critical Files

| File | Purpose |
|------|---------|
| `src/lib/fuzzy-matcher.ts` | Core: `ensurePhoneticKeyColumn()`, update block analysis |
| `src/stores/tableStore.ts` | Filter `_phonetic_*` columns from visibility |
| `src/stores/matcherStore.ts` | Add indexing progress state |
| `src/features/matcher/components/MatchConfigPanel.tsx` | Indexing progress UI |
