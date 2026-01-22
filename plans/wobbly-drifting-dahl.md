# Plan: Optimize Standardize for Full Names with Spaces

## Problem Statement
The current Standardize feature has two algorithms:
1. **Fingerprint**: Normalizes and sorts tokens - handles word order but misses typos ("Jon" vs "John")
2. **Metaphone**: Phonetic matching but strips ALL spaces, losing token boundaries

Neither works well for full names like "John Smith" vs "Jon Smyth" where we need both:
- Word order flexibility (first/last name swapped)
- Typo/phonetic tolerance per name part

## Research Findings

Based on web search ([Fuzzy Matching Guide 2025](https://matchdatapro.com/fuzzy-matching-101-a-complete-guide-for-2025/), [Name Matching Techniques](https://singlequote.blog/name-matching-techniques-useful-algorithms-their-problems-absolute-solutions/)):

| Algorithm | Best For | Limitation |
|-----------|----------|------------|
| **Token-based Metaphone** | Multi-word names | Requires implementation |
| **Jaro-Winkler** | Short strings, names | Character-level only |
| **N-gram (trigram)** | Typo tolerance | May over-cluster |
| **Monge-Elkan** | Multi-token strings | Complexity |

**Recommended**: Add **Token Phonetic** algorithm - applies phonetic encoding to each word separately, then sorts and joins. This handles both word order AND spelling variations.

## Solution Design

### New Algorithm: Token Phonetic

```
"John Smith"  → ["john", "smith"]  → [metaphone("john"), metaphone("smith")]  → ["JN", "SM0"]  → sort → "JN SM0"
"Jon Smyth"   → ["jon", "smyth"]   → [metaphone("jon"), metaphone("smyth")]   → ["JN", "SM0"]  → sort → "JN SM0"
"Smith, John" → ["smith", "john"]  → [metaphone("smith"), metaphone("john")]  → ["SM0", "JN"]  → sort → "JN SM0"
```

All three cluster together! This is ideal for name standardization.

## Implementation Plan

### Step 1: Add Token Phonetic Algorithm
**File**: `src/lib/standardizer-engine.ts`

```typescript
export function generateTokenPhoneticKey(value: string): string {
  if (!value || typeof value !== 'string') return ''

  // Normalize: lowercase, remove accents, remove punctuation except spaces
  let normalized = value.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')

  // Split into tokens, filter empty
  const tokens = normalized.split(/\s+/).filter(t => t.length > 0)

  // Apply metaphone to each token
  const metaphoneCodes = tokens.map(token => {
    const [primary] = doubleMetaphone(token)
    return primary
  }).filter(code => code.length > 0)

  // Sort and join for order-independent matching
  return metaphoneCodes.sort().join(' ')
}
```

### Step 2: Update Type Definition
**File**: `src/types/index.ts`

```typescript
export type ClusteringAlgorithm = 'fingerprint' | 'metaphone' | 'token_phonetic'
```

### Step 3: Update Algorithm Switch
**File**: `src/lib/standardizer-engine.ts`

Add case for `token_phonetic` in `getClusterKey()`.

### Step 4: Update UI with Algorithm Descriptions
**File**: `src/features/standardizer/components/StandardizeConfigPanel.tsx`

Add helpful descriptions:
- Fingerprint: "Best for exact text with case/spacing variations"
- Metaphone: "Best for phonetic variations (Smith/Smyth)"
- Token Phonetic: "**Best for full names** - handles word order + phonetic variations"

### Step 5: Update Algorithm Selector Options
Show the new algorithm with a "Recommended for names" indicator.

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/standardizer-engine.ts` | Add `generateTokenPhoneticKey()`, update `getClusterKey()` |
| `src/types/index.ts` | Add `'token_phonetic'` to `ClusteringAlgorithm` type |
| `src/features/standardizer/components/StandardizeConfigPanel.tsx` | Add new algorithm option with description |

## UI Changes Detail

Current algorithm selector (lines 143-150):
```tsx
<SelectItem value="fingerprint">Fingerprint (Normalization)</SelectItem>
<SelectItem value="metaphone">Metaphone (Phonetic)</SelectItem>
```

Updated with new algorithm:
```tsx
<SelectItem value="fingerprint">Fingerprint (Normalization)</SelectItem>
<SelectItem value="metaphone">Metaphone (Phonetic)</SelectItem>
<SelectItem value="token_phonetic">Token Phonetic</SelectItem>
```

Updated description text (lines 152-156):
```tsx
{algorithm === 'fingerprint'
  ? 'Groups values by normalized form (case, punctuation, word order)'
  : algorithm === 'metaphone'
  ? 'Groups values by phonetic similarity (sounds-alike matching)'
  : 'Phonetic matching per word - ideal for multi-word values like names'}
```

## Verification

1. **Manual test**:
   - Upload CSV with full names column containing:
     - "John Smith", "Jon Smith", "Smith, John", "JOHN SMITH", "john  smith"
   - Select Token Phonetic algorithm
   - Verify all cluster together

2. **Regression test**:
   - Existing fingerprint/metaphone algorithms still work unchanged
   - Run `npm run lint` to verify no type errors
