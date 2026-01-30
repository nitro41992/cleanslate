# Plan: Align Match Algorithms with Standardize

## Implementation Status: ✅ COMPLETE

All phases implemented:
- [x] Added `fingerprint_block`, `metaphone_block`, `token_phonetic_block` to `BlockingStrategy` type
- [x] Implemented `jaroWinklerSimilarity()` function (JS + DuckDB native)
- [x] Created `createPhoneticBlockingTable()` with CSV bulk registration
- [x] Updated `findDuplicates()` and `findDuplicatesChunked()` to use Jaro-Winkler + phonetic blocking
- [x] Updated `calculateFieldSimilarities()` to use Jaro-Winkler
- [x] Updated `MatchConfigPanel.tsx` with new strategy options
- [x] Changed default blocking strategy to `metaphone_block`
- [x] **Removed legacy strategies:** `first_letter`, `double_metaphone`, `ngram`
- [x] **Added row limit for `none` strategy:** Disabled for tables >1000 rows
- [x] Build passes, lint passes on changed files

### Final Strategy List
| Strategy | Description | Row Limit |
|----------|-------------|-----------|
| `metaphone_block` | True phonetic (Double Metaphone) | Unlimited |
| `token_phonetic_block` | Per-word phonetic + sorting | Unlimited |
| `fingerprint_block` | Word-order independent | Unlimited |
| `none` | Compare all pairs O(n²) | ≤1000 rows |

---

## Problem Statement

The **Standardize** feature uses sophisticated clustering algorithms (Fingerprint, Double Metaphone, Token Phonetic) that work well for grouping similar values. However, the **Match** feature uses **Levenshtein distance** for similarity calculation, with blocking strategies that only serve as performance optimization (reducing comparison pairs), not improving match quality.

The user has observed that Standardize's algorithms work better and wants them aligned.

---

## Industry Best Practices (2025-2026 Research)

### Algorithm Categories
| Type | Examples | Best For |
|------|----------|----------|
| **Character-based** | Levenshtein, Jaro-Winkler | Typos, short strings |
| **Phonetic** | Soundex, Double Metaphone | Sound-alike names |
| **Token-based** | Jaccard, Cosine | Word reordering |
| **Probabilistic** | Fellegi-Sunter | Weighted field matching |

### Key Research Findings

1. **Jaro-Winkler > Levenshtein for names** - Achieves ~10% higher sensitivity than exact matching, better handles transpositions and prefix similarities

2. **Double Metaphone Blocking is state-of-the-art** - A 2025 paper ([Springer](https://link.springer.com/chapter/10.1007/978-981-95-0695-8_12)) shows Double Metaphone blocking outperforms other record linkage algorithms with higher F-1 scores

3. **Hybrid approach recommended** - Combine phonetic blocking + multiple similarity algorithms + human review

4. **Standard workflow**: Normalization → Blocking → Scoring → Thresholding → Human Review

### Current State vs Best Practice
| Aspect | Standardize | Match | Best Practice |
|--------|-------------|-------|---------------|
| Phonetic | ✅ Double Metaphone | ❌ First 2 letters only | Double Metaphone |
| Similarity | N/A (grouping) | ❌ Levenshtein | Jaro-Winkler |
| Token handling | ✅ Fingerprint sorts | ❌ None | Token-based |
| Human review | ✅ Cluster selection | ✅ Multi-column compare | ✅ |

---

## Current State Analysis

### Standardize Algorithms (`src/lib/standardizer-engine.ts`)
| Algorithm | How It Works | Strength |
|-----------|--------------|----------|
| **Fingerprint** | Normalize → remove accents → sort tokens → join | Order-independent ("John Smith" = "Smith, John") |
| **Double Metaphone** | Full phonetic encoding (250+ lines of rules) | Spelling variations (Smith/Smyth, Jon/John) |
| **Token Phonetic** | Metaphone per word → sort phonetic codes | Both word-order + spelling variations |

### Match Blocking Strategies (`src/lib/fuzzy-matcher.ts`)
| Strategy | Implementation | Limitation |
|----------|----------------|------------|
| `first_letter` | First character only | Misses "Jon" vs "John" |
| `double_metaphone` | **Just first 2 letters** (not actual phonetic) | Misses "Smyth" vs "Smith" |
| `ngram` | First 3 characters | Misses rearranged names |
| `none` | Compare all pairs | O(n²) - unusable at scale |

### Core Issue
Match's "double_metaphone" blocking is misleading - it's NOT using the same phonetic algorithm as Standardize. The actual similarity is calculated via Levenshtein, which:
- Penalizes character differences equally (Jon→John = 1 edit)
- Doesn't understand phonetic equivalence (Smyth→Smith = 2 edits)
- Doesn't handle word reordering ("John Smith" vs "Smith, John" = many edits)

---

## Implementation Plan

### Phase 1: Add True Phonetic Blocking Strategies

**Challenge**: DuckDB has no built-in Metaphone function, so phonetic keys must be computed in JavaScript.

**Solution**: Preprocessing approach with bulk ingestion:
1. Query `SELECT DISTINCT matchColumn` (crucial - don't process all rows)
2. Compute phonetic keys in JavaScript using existing `doubleMetaphone()`
3. **Bulk load via CSV registration** (NOT individual INSERTs):
   ```typescript
   // Generate CSV string from key mappings
   const csvContent = mappings.map(m => `"${escape(m.value)}","${m.key}"`).join('\n')
   db.registerFileText('_phonetic_keys.csv', csvContent)
   await query(`CREATE TEMP TABLE _keys AS SELECT * FROM read_csv_auto('_phonetic_keys.csv')`)
   ```
4. Join on phonetic_key for blocking

#### New Blocking Strategies

| Strategy | Description | Best For |
|----------|-------------|----------|
| `fingerprint_block` | Normalize → sort tokens → join | Word reordering ("John Smith" = "Smith, John") |
| `metaphone_block` | Full Double Metaphone codes | Sound-alike ("Smyth" = "Smith") |
| `token_phonetic_block` | Metaphone per word → sort | Both variations (recommended for names) |

---

### Phase 2: Add Jaro-Winkler Similarity

Replace Levenshtein with Jaro-Winkler for better name matching.

**Why Jaro-Winkler is better for names:**
- Weights prefix matches higher (important for names)
- Handles transpositions better (Jon vs John)
- More forgiving of minor character differences
- Research shows ~10% higher sensitivity than exact matching

**Key Insight: DuckDB has native `jaro_winkler_similarity()`!**

Use native SQL for filtering candidates, JS implementation only for `calculateFieldSimilarities()`:

```sql
-- Use native DuckDB function for efficient SQL filtering
SELECT a.*, b.*, jaro_winkler_similarity(a.name, b.name) as similarity
FROM block_data a
JOIN block_data b ON a.block_key = b.block_key AND a.row_id < b.row_id
WHERE jaro_winkler_similarity(a.name, b.name) >= 0.85  -- Filter in SQL!
```

**Critical: Threshold Logic Inversion**
- Levenshtein is **distance** (0 = exact match, higher = worse)
- Jaro-Winkler is **similarity** (1.0 = exact match, higher = better)

| Old Query | New Query |
|-----------|-----------|
| `WHERE levenshtein(...) <= distance` | `WHERE jaro_winkler_similarity(...) >= (threshold / 100.0)` |

**JS Implementation (~50 lines)** - Only needed for `calculateFieldSimilarities()`:
```typescript
function jaroWinklerSimilarity(s1: string, s2: string): number {
  // 1. Calculate Jaro similarity (matching chars + transpositions)
  // 2. Add Winkler prefix bonus (up to 4 chars, scaling factor 0.1)
  // 3. Convert to 0-100 scale
}
```

---

## File Changes

| File | Changes |
|------|---------|
| `src/types/index.ts:143` | Add `fingerprint_block`, `metaphone_block`, `token_phonetic_block` to `BlockingStrategy` union |
| `src/lib/fuzzy-matcher.ts` | Add `jaroWinklerSimilarity()`, `createPhoneticBlockingTable()`, update SQL queries |
| `src/lib/standardizer-engine.ts` | Export existing functions (already implemented, just need exports) |
| `src/features/matcher/components/MatchConfigPanel.tsx` | Add new strategy options to `strategyInfo` object (follow existing pattern with `examples` array) |
| `src/stores/matcherStore.ts:115` | Update `blockingStrategy` default from `'double_metaphone'` to `'metaphone_block'` |

**UI Consistency Note**: Recent commits (6ac1846, 22f2918) modernized Match/Standardize UIs. The `MatchConfigPanel` already uses:
- `StrategyInfo` interface with `examples` array
- `TableCombobox` / `ColumnCombobox` components
- Flat design with `bg-muted` cards and border patterns

New strategies should follow the same pattern.

---

## Detailed Changes

### 1. `src/types/index.ts`
```typescript
export type BlockingStrategy =
  | 'first_letter'
  | 'double_metaphone'  // Keep for backwards compat (rename in UI to "First 2 Chars")
  | 'ngram'
  | 'none'
  | 'fingerprint_block'      // NEW
  | 'metaphone_block'        // NEW
  | 'token_phonetic_block'   // NEW
```

### 2. `src/lib/fuzzy-matcher.ts`

**Add Jaro-Winkler algorithm (~50 lines):**
- `jaroSimilarity()` - Core Jaro calculation (for JS-side field comparison)
- `jaroWinklerSimilarity()` - Add Winkler prefix bonus, return 0-100 scale

**Add phonetic blocking with bulk CSV registration:**
```typescript
async function createPhoneticBlockingTable(tableName: string, matchColumn: string, algorithm: string) {
  // 1. Query DISTINCT values only
  const distinctValues = await query(`SELECT DISTINCT "${matchColumn}" as value FROM "${tableName}" WHERE ...`)

  // 2. Generate keys in JS
  const mappings = distinctValues.map(r => ({ value: r.value, key: keyFunction(r.value) }))

  // 3. BULK LOAD via CSV registration (not individual INSERTs!)
  const csvContent = 'value,block_key\n' + mappings.map(m => `"${escape(m.value)}","${m.key}"`).join('\n')
  db.registerFileText('_phonetic_keys.csv', csvContent)
  await query(`CREATE TEMP TABLE _phonetic_keys AS SELECT * FROM read_csv_auto('_phonetic_keys.csv')`)

  // 4. Return temp table name for JOIN
}
```

**Update `processBlock()` SQL to use native Jaro-Winkler:**
```sql
-- OLD: WHERE levenshtein(...) <= maxDistance
-- NEW: Use native DuckDB function + INNER JOIN with phonetic keys
SELECT a.*, b.*, jaro_winkler_similarity(a.val, b.val) as similarity
FROM blocked_data a
INNER JOIN _phonetic_keys ka ON a.match_col = ka.value
INNER JOIN blocked_data b ON ka.block_key = kb.block_key AND a.row_id < b.row_id
INNER JOIN _phonetic_keys kb ON b.match_col = kb.value
WHERE jaro_winkler_similarity(a.val, b.val) >= 0.85  -- Filter in SQL, not JS!
```

**Update `calculateFieldSimilarities()` (JS-side):**
- Add `similarityAlgorithm` parameter (default: `'jaro_winkler'`)
- Use JS Jaro-Winkler for per-field comparison in UI

### 3. `src/features/matcher/components/MatchConfigPanel.tsx`

**Follow existing UI patterns** from recent commits (flat design, examples array):

```typescript
// Extend strategyInfo record (matches existing StrategyInfo interface)
const strategyInfo: Record<BlockingStrategy, StrategyInfo> = {
  // ... existing strategies ...

  // Rename existing double_metaphone in UI only:
  double_metaphone: {
    title: 'First 2 Characters',  // RENAMED from "Phonetic - Double Metaphone"
    description: 'Compare records sharing first 2 letters. Fast but may miss variations.',
    examples: [{ before: 'Smith', after: 'Smyth' }],
  },

  // NEW strategies:
  fingerprint_block: {
    title: 'Fingerprint (Word-Order Safe)',
    description: 'Groups values with same words regardless of order.',
    badge: 'Best for addresses',
    examples: [
      { before: 'John Smith', after: 'Smith, John' },
      { before: 'ACME Inc.', after: 'ACME, Inc' },
    ],
  },
  metaphone_block: {
    title: 'True Phonetic (Sound-Alike)',
    description: 'Groups values that sound similar using Double Metaphone.',
    badge: 'Best for names',
    badgeVariant: 'default',
    examples: [
      { before: 'Smith', after: 'Smyth' },
      { before: 'John', after: 'Jon' },
      { before: 'Catherine', after: 'Katherine' },
    ],
  },
  token_phonetic_block: {
    title: 'Token Phonetic (Names)',
    description: 'Phonetic + word order handling. Best for full names.',
    badge: 'Recommended',
    badgeVariant: 'default',
    examples: [
      { before: 'John Smith', after: 'Smith, Jon' },
      { before: 'Jon Smyth', after: 'John Smith' },
    ],
  },
}
```

**Note**: Uses same `StrategyInfo` interface with `examples` array as existing code.

---

## Verification Plan

### Test Cases

| Test | Input A | Input B | Old Result | New Result |
|------|---------|---------|------------|------------|
| Word Order | "John Smith" | "Smith, John" | ❌ Different blocks | ✅ Same block (fingerprint) |
| Phonetic | "Jon Smyth" | "John Smith" | ⚠️ Low similarity | ✅ Same block + high JW score |
| Combined | "Smyth, Jon" | "John Smith" | ❌ Never compared | ✅ Matched (token_phonetic) |
| JW vs Lev | "Johnson" | "Jonson" | 85% (Lev) | 93% (JW) |

### E2E Test File
Create `e2e/tests/matcher-algorithms.spec.ts` with fixture `e2e/fixtures/csv/fr_c1_phonetic_dedupe.csv`

### Performance Benchmark
Add console timer to "Analyze Block Distribution" phase:
```typescript
console.time('phonetic-key-generation')
// Generate keys for DISTINCT values only (crucial!)
console.timeEnd('phonetic-key-generation')
```

**Constraint**: Always `SELECT DISTINCT matchColumn` before generating keys in JS. Generating Double Metaphone for 1M rows (vs 50k distinct) will hang the browser.

---

## Backwards Compatibility

1. Keep existing `double_metaphone` strategy working (remains first-2-letters blocking)
2. Rename it in UI to "First 2 Characters" to avoid confusion
3. Default new sessions to `metaphone_block`
4. **Migration handling**: If user loads old saved config with `strategy: 'double_metaphone'`, UI must display "First 2 Characters" (not break)

---

## Critical Files

| File | Purpose |
|------|---------|
| `src/lib/fuzzy-matcher.ts` | Core: Jaro-Winkler + phonetic blocking |
| `src/lib/standardizer-engine.ts` | Source of phonetic algorithms (import from here) |
| `src/features/matcher/components/MatchConfigPanel.tsx` | UI for selecting strategy |
| `src/types/index.ts` | Extend `BlockingStrategy` type |
| `src/stores/matcherStore.ts` | Update default strategy |
