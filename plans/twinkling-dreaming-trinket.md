# Fuzzy Matcher at Scale: Research & Options

## The Problem

Fuzzy matching 100k+ rows in the browser is running indefinitely (3+ minutes without completing).

**Original Goal:** Support up to 2M rows.

---

## Research Findings

### Hard Constraints: DuckDB-WASM Browser Limits

| Constraint | Limit | Source |
|------------|-------|--------|
| Memory per tab | ~4GB (Chrome) | [DuckDB-WASM Docs](https://duckdb.org/docs/stable/clients/wasm/overview) |
| Threading | **Single-threaded** (multi-threading experimental) | [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm) |
| Out-of-core | **Not supported** (can't spill to disk) | Known WASM limitation |
| RapidFuzz extension | **Not available** in WASM | [WASM Extensions](https://duckdb.org/docs/stable/clients/wasm/extensions) |
| DOM/browser limits | ~100k records safely | [AG Grid benchmarks](https://www.ag-grid.com/javascript-data-grid/massive-row-count/) |

### The Quadratic Problem

```
100k rows = 5,000,000,000 potential pair comparisons
Even with blocking: 10k "John" entries = 50M pairs from ONE block
```

**Levenshtein is expensive**: O(m×n) per string pair, computed in WHERE clause for EVERY candidate pair.

A single SQL self-join with Levenshtein in WHERE is fundamentally not scalable because:
1. DuckDB must evaluate `levenshtein()` for every pair before filtering
2. No early termination - computes ALL pairs then filters
3. Single-threaded execution in WASM

### How Splink Does It (Production-Grade Approach)

[Splink](https://moj-analytical-services.github.io/splink/index.html) deduplicates 7M records in 2 minutes using:

1. **Multiple blocking rules (3-10 rules)** with OR logic
2. **Each rule generates a small subset** of comparisons
3. **Rules run sequentially**, results combined and deduped
4. **Probabilistic scoring** (Fellegi-Sunter model)

Key insight: *"For a true match to be eliminated, it would have to have an error in BOTH email AND (first_name or dob)"*

---

## Realistic Options

### Option A: Tiered Row Limits (Recommended)

Accept that browser fuzzy matching has limits. Tier the approach:

| Dataset Size | Approach | Expected Time |
|--------------|----------|---------------|
| < 10k rows | Full comparison (no blocking) | < 5 sec |
| 10k - 50k | Single blocking rule | < 15 sec |
| 50k - 200k | Aggressive blocking (first 3 chars) | < 30 sec |
| > 200k | **Warn user**, suggest exact-match or sampling | N/A |

**Tradeoff:** Limited scale, but predictable performance.

### Option B: Sequential Multi-Pass Blocking (Splink-style)

Run 3-5 blocking passes sequentially, each with different blocking key:

```
Pass 1: First letter match → find "John" vs "Johnson"
Pass 2: First 2 letters match → find "Smith" vs "Smyth"
Pass 3: Length bucket + first letter → catch length variations
```

Combine results, dedupe, cap at 10k pairs.

**Tradeoff:** Better recall, but 3-5x slower. May still timeout on large datasets.

### Option C: Exact Match First, Fuzzy Sample Second

1. **Phase 1:** Find exact duplicates (fast, scales to millions)
2. **Phase 2:** Sample 10k-50k records for fuzzy matching
3. **UI shows:** "Found X exact duplicates. Sampled Y records for fuzzy matches."

**Tradeoff:** Doesn't find all fuzzy matches, but handles large data gracefully.

### Option D: Pre-filter with Cheap Comparisons

Before Levenshtein, filter with cheap checks:
```sql
WHERE ABS(LENGTH(a.name) - LENGTH(b.name)) <= 3  -- Length diff filter
  AND LEFT(a.name, 1) = LEFT(b.name, 1)          -- First letter match
```

Then run Levenshtein only on the filtered set.

**Tradeoff:** Still O(n²) but with much smaller n.

### Option E: Block-by-Block Processing with Progress

Process one blocking key at a time:
1. Get list of blocking keys (e.g., all first letters)
2. For each key, run comparison query with LIMIT
3. Report progress: "Processing block 'A'... (3/26)"
4. Stop when we have 10k total pairs

**Tradeoff:** Shows progress, cancellable, but complex implementation.

---

## My Recommendation

**Option A (Tiered Limits) + Option D (Pre-filters)** is the pragmatic choice:

1. Add row count check before fuzzy matching
2. Warn users when dataset > 100k rows
3. Use aggressive pre-filters (length diff, first char)
4. Process in chunks with progress reporting
5. Cap results at 10k pairs

This acknowledges browser limitations while still providing value.

---

## Final Solution: Chunked Multi-Pass Processing

### The Key Insight

Don't run ONE giant self-join. Instead:
1. **Analyze blocks first** (fast query to understand data distribution)
2. **Process each block separately** (small, bounded queries)
3. **Handle oversized blocks** (sample or sub-block)
4. **Report progress** ("Block 23/156...")
5. **Stop early** when we have 10k pairs

This mirrors how Splink works, adapted for browser constraints.

### Algorithm

```
1. ANALYZE: Get block distribution
   SELECT block_key, COUNT(*) as size
   FROM table GROUP BY UPPER(SUBSTR(col, 1, 2))

2. PLAN: Sort blocks, identify oversized ones
   - Normal blocks (< 500 rows): process fully
   - Large blocks (500-2000 rows): process with stricter distance
   - Oversized blocks (> 2000 rows): sample 500 random rows

3. PROCESS: For each block (with progress):
   - Run comparison query for that block only
   - Accumulate results
   - Check if we've hit 10k pairs limit

4. RETURN: Combined results with metadata
   - "Found 8,432 pairs from 156 blocks"
   - "3 oversized blocks were sampled"
```

### Why This Works for 2M Rows

| Concern | Solution |
|---------|----------|
| Memory | Process one block at a time, never load all data |
| Speed | Skip/sample oversized blocks, early termination |
| Progress | Report after each block completes |
| Cancellation | Check cancelled flag between blocks |
| Accuracy | Multiple blocking strategies, sample large blocks |

### Estimated Performance

| Dataset Size | Blocks | Time (est.) |
|--------------|--------|-------------|
| 100k rows | ~500 blocks | 30-60 sec |
| 500k rows | ~600 blocks | 2-3 min |
| 2M rows | ~700 blocks | 5-10 min |

Note: Times assume ~70% of blocks are small (<500 rows). Actual time depends on data distribution.

---

## Implementation Plan

### Files to Modify

| File | Changes |
|------|---------|
| `src/lib/fuzzy-matcher.ts` | Add `findDuplicatesChunked()` with progress callback |
| `src/hooks/useFuzzyMatcher.ts` | Wire up progress/cancellation |
| `src/features/matcher/MatchView.tsx` | Display detailed progress |

### Step 1: Add Block Analysis Function

```typescript
// In fuzzy-matcher.ts

interface BlockInfo {
  blockKey: string
  size: number
  strategy: 'full' | 'strict' | 'sample'
}

async function analyzeBlocks(
  tableName: string,
  matchColumn: string,
  blockKeyExpr: string
): Promise<BlockInfo[]> {
  const result = await query<{ block_key: string; cnt: number }>(`
    SELECT
      ${blockKeyExpr} as block_key,
      COUNT(*) as cnt
    FROM "${tableName}"
    WHERE "${matchColumn}" IS NOT NULL
    GROUP BY block_key
    ORDER BY cnt DESC
  `)

  return result.map(r => ({
    blockKey: r.block_key,
    size: Number(r.cnt),
    strategy: r.cnt < 500 ? 'full' : r.cnt < 2000 ? 'strict' : 'sample'
  }))
}
```

### Step 2: Process Single Block

```typescript
async function processBlock(
  tableName: string,
  matchColumn: string,
  blockKey: string,
  blockKeyExpr: string,
  strategy: 'full' | 'strict' | 'sample',
  maxDistance: number,
  limit: number
): Promise<RawMatchResult[]> {
  // For sampled blocks, add USING SAMPLE clause
  const sampleClause = strategy === 'sample'
    ? 'USING SAMPLE 500 ROWS'
    : ''

  // Stricter distance for large blocks
  const effectiveDistance = strategy === 'strict'
    ? Math.max(2, maxDistance - 2)
    : maxDistance

  const sql = `
    WITH block_data AS (
      SELECT ROW_NUMBER() OVER () as row_id, *
      FROM "${tableName}" ${sampleClause}
      WHERE ${blockKeyExpr} = '${blockKey}'
        AND "${matchColumn}" IS NOT NULL
    )
    SELECT
      a.*, b.*,
      levenshtein(LOWER(a."${matchColumn}"), LOWER(b."${matchColumn}")) as distance,
      GREATEST(LENGTH(a."${matchColumn}"), LENGTH(b."${matchColumn}")) as max_len
    FROM block_data a
    JOIN block_data b ON a.row_id < b.row_id
    WHERE ABS(LENGTH(a."${matchColumn}") - LENGTH(b."${matchColumn}")) <= ${effectiveDistance}
      AND levenshtein(LOWER(a."${matchColumn}"), LOWER(b."${matchColumn}")) <= ${effectiveDistance}
    ORDER BY distance
    LIMIT ${limit}
  `

  return query(sql)
}
```

### Step 3: Main Chunked Function with Progress

```typescript
interface ProgressInfo {
  phase: 'analyzing' | 'processing' | 'complete'
  currentBlock: number
  totalBlocks: number
  pairsFound: number
  maybeCount: number      // Uncertain pairs (most valuable for review)
  definiteCount: number   // High confidence pairs
  currentBlockKey?: string
  oversizedBlocks: number
}

export async function findDuplicatesChunked(
  tableName: string,
  matchColumn: string,
  blockingStrategy: BlockingStrategy,
  maybeThreshold: number,
  definiteThreshold: number,
  onProgress: (info: ProgressInfo) => void,
  shouldCancel: () => boolean
): Promise<MatchPair[]> {
  const columns = await getTableColumns(tableName)
  const blockKeyExpr = getBlockKeyExpr(matchColumn, blockingStrategy)
  const maxDistance = Math.ceil((100 - maybeThreshold) / 10)

  // Phase 1: Analyze block distribution
  onProgress({ phase: 'analyzing', currentBlock: 0, totalBlocks: 0, pairsFound: 0, maybeCount: 0, definiteCount: 0, oversizedBlocks: 0 })
  const blocks = await analyzeBlocks(tableName, matchColumn, blockKeyExpr)
  const oversizedCount = blocks.filter(b => b.strategy === 'sample').length

  // Phase 2: Process blocks sequentially
  const allPairs: MatchPair[] = []
  let maybeCount = 0
  let definiteCount = 0

  for (let i = 0; i < blocks.length; i++) {
    if (shouldCancel()) break

    const block = blocks[i]
    onProgress({
      phase: 'processing',
      currentBlock: i + 1,
      totalBlocks: blocks.length,
      pairsFound: allPairs.length,
      maybeCount,
      definiteCount,
      currentBlockKey: block.blockKey,
      oversizedBlocks: oversizedCount
    })

    const results = await processBlock(
      tableName, matchColumn, block.blockKey, blockKeyExpr,
      block.strategy, maxDistance, 1000 // Cap per block to prevent huge blocks
    )

    // Convert to MatchPair and categorize
    for (const row of results) {
      const pair = convertToMatchPair(row, columns, maybeThreshold)
      if (pair) {
        allPairs.push(pair)
        if (pair.similarity >= definiteThreshold) {
          definiteCount++
        } else {
          maybeCount++
        }
      }
    }
  }

  onProgress({
    phase: 'complete',
    currentBlock: blocks.length,
    totalBlocks: blocks.length,
    pairsFound: allPairs.length,
    maybeCount,
    definiteCount,
    oversizedBlocks: oversizedCount
  })

  // Stratified sort: maybe matches first (need review), then definite
  return stratifiedSort(allPairs, definiteThreshold)
}
```

### Step 4: Update UI for Detailed Progress

```tsx
// In MatchView.tsx
{isMatching && (
  <div className="flex flex-col gap-1">
    <Progress value={(currentBlock / totalBlocks) * 100} />
    <span className="text-xs text-muted-foreground">
      {phase === 'analyzing' && 'Analyzing data distribution...'}
      {phase === 'processing' && `Block ${currentBlock}/${totalBlocks} (${currentBlockKey})`}
      {pairsFound > 0 && ` • ${pairsFound.toLocaleString()} pairs found`}
      {oversizedBlocks > 0 && ` • ${oversizedBlocks} large blocks sampled`}
    </span>
  </div>
)}
```

---

## Verification

1. **10k rows**: Should complete in <10 seconds
2. **100k rows**: Should complete in 30-60 seconds with progress
3. **500k rows**: Should complete in 2-3 minutes, cancellable
4. **2M rows**: Should complete in 5-10 minutes
5. **Progress**: UI shows block-by-block progress with counts (maybe/definite)
6. **Cancellation**: User can cancel mid-operation
7. **No crash**: Memory stays bounded, no "Set exceeded" error
8. **Human focus**: Maybe matches (uncertain) shown first for review
9. **Category filters**: UI filters work correctly (All/Definite/Maybe/Not Match)

---

## Trade-offs Accepted

| Trade-off | Impact | Mitigation |
|-----------|--------|------------|
| Oversized blocks sampled | May miss some matches in popular values | User warned, can adjust blocking strategy |
| Sequential processing | Slower than parallel | Progress feedback makes wait acceptable |
| Single blocking key | Less recall than Splink's multi-rule | Users can run multiple times with different columns |
| 10k pair cap | Can't review all matches | Most valuable pairs (lowest distance) prioritized |

---

## Key Optimizations

### 1. Length Difference Pre-filter (Critical!)

Before computing Levenshtein, filter by length difference:
```sql
WHERE ABS(LENGTH(a.col) - LENGTH(b.col)) <= maxDistance
  AND levenshtein(...) <= maxDistance
```

**Why:** If strings differ by more than `maxDistance` characters in length, their Levenshtein distance MUST be > maxDistance. This filter is O(1) vs O(m×n) for Levenshtein.

### 2. Block Size Caps

| Block Size | Strategy | Rationale |
|------------|----------|-----------|
| < 500 rows | Full comparison | 124,750 pairs max, fast |
| 500-2000 rows | Stricter threshold | Reduce pairs, still comprehensive |
| > 2000 rows | Sample 500 rows | 124,750 pairs max, representative |

### 3. Processing Termination

Stop processing when:
- User cancels
- All blocks processed

**No arbitrary pair cap** - process all blocks to find all maybe matches.

### 4. Result Prioritization (Human-in-the-Loop Focus)

**Key insight:** The goal is human review of *uncertain* pairs, not just finding matches.

| Category | Similarity | Priority | Reason |
|----------|------------|----------|--------|
| Maybe matches | 60-85% | **Highest** | System uncertain, human judgment needed |
| Definite matches | >85% | Medium | System confident, could bulk-approve |
| Not matches | <60% | Lowest | Likely not duplicates, can filter out |

**Stratified sampling strategy:**
1. Collect ALL maybe matches (these are most valuable)
2. Sample definite matches (system is already confident)
3. Skip not matches entirely

This ensures human review focuses on cases where it actually matters.

### 5. No Arbitrary Cap

Instead of capping at 10k pairs:
1. Process all blocks
2. Prioritize maybe matches in memory
3. UI uses virtualization for smooth scrolling
4. Export all results if needed

The current UI already supports category filtering (definite/maybe/not_match tabs), so users can focus their review efficiently.
