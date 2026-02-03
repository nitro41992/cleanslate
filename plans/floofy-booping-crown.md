# Plan: Consolidate Scrub into Transform Panel

## Summary

Consolidate the Scrub feature into the Transform panel as a new **"Privacy"** group. When a user selects any privacy transform, an **expanded sub-panel** appears allowing them to:
- Select multiple columns with different privacy methods
- Apply all transforms at once
- Generate a single unified key map table

This preserves the current Scrub panel's batch workflow while integrating it into the Transform panel.

## Changes Overview

### 1. New "Privacy" Transform Group

Add to `TRANSFORMATION_GROUPS` in `src/lib/transformations.ts`:

| Property | Value |
|----------|-------|
| id | `privacy` |
| label | `Privacy` |
| icon | `🛡️` |
| color | `teal` (new color) |
| transforms | `privacy_batch` |

Only one entry - clicking it opens the privacy sub-panel for multi-column configuration.

### 2. Privacy Transform Methods

Individual privacy methods available in the sub-panel:

| Method | Description | Per-Column Params | Tier |
|--------|-------------|-------------------|------|
| **redact** | Replace with [REDACTED] | `replacement` (text) | Tier 3 (exists) |
| **mask** | Show first/last N chars | `preserveFirst`, `preserveLast` | Tier 1 (exists) |
| **hash** | MD5 hash with secret | Uses shared `secret` | Tier 1 (exists) |
| **last4** | Show only last 4 digits | - | Tier 1 (new) |
| **zero** | Replace digits with 0 | - | Tier 1 (new) |
| **scramble** | Shuffle digits deterministically | - | Tier 1 (new) |
| **year_only** | Keep only year (YYYY-01-01) | - | Tier 3 (exists) |

**Removed:** `faker` (non-deterministic), `jitter` (non-deterministic)

### 2b. Batch Privacy Transform

Add ONE transform definition that triggers the sub-panel:

```typescript
{
  id: 'privacy_batch',
  label: 'Privacy / Scrub',
  description: 'Apply privacy transforms to multiple columns at once',
  icon: '🛡️',
  requiresColumn: false,  // Uses sub-panel for column selection
  params: [], // Handled by sub-panel UI
  examples: [
    { before: 'john@email.com', after: 'a8f5e2b1c9d3...' },
    { before: '555-123-4567', after: '5*****7' },
  ],
  hints: [
    'Select multiple columns with different methods',
    'Generate unified key map table',
  ],
}
```

When this transform is selected, CleanPanel shows the privacy sub-panel instead of standard params.

### 3. New Command Implementations

#### 3a. New Individual Scrub Commands

**`src/lib/commands/scrub/last4.ts` (Tier 1)**
```sql
-- Show last 4 digits, mask the rest
CONCAT(
  REPEAT('*', GREATEST(0, LENGTH(regexp_replace(col, '[^0-9]', '', 'g')) - 4)),
  RIGHT(regexp_replace(col, '[^0-9]', '', 'g'), 4)
)
```

**`src/lib/commands/scrub/zero.ts` (Tier 1)**
```sql
-- Replace all digits with zeros
regexp_replace(col, '[0-9]', '0', 'g')
```

**`src/lib/commands/scrub/scramble.ts` (Tier 1)**
Deterministic shuffle using hash-based positioning:
- Extract digits from value
- Use `MD5(value)` as seed for consistent shuffle order
- Sort digits by `MD5(digit || position || seed)`
- Reconstruct with non-digit characters preserved in place
- Same input always produces same scrambled output (recipe-compatible)

#### 3b. Batch Privacy Command

**`src/lib/commands/scrub/batch.ts` (Tier 3)**

A composite command that:
1. Takes array of `{ column, method, params }` rules
2. Optionally captures DISTINCT values before transforms (for key map)
3. Executes each transform sequentially using existing scrub commands
4. Creates unified key map table if enabled

```typescript
interface ScrubBatchParams extends BaseTransformParams {
  rules: Array<{
    column: string
    method: 'redact' | 'mask' | 'hash' | 'last4' | 'zero' | 'scramble' | 'year_only'
    params?: Record<string, unknown>
  }>
  secret?: string  // Shared secret for hash methods
  generateKeyMap?: boolean
}
```

**Command Type:** `scrub:batch`

**Recipe Serialization:** Stores full rules array - recipes can replay exact column/method configurations.

### 4. Key Map Generation

**Approach:** Create a single unified key map table for all privacy transforms in the batch

When `generateKeyMap: true` is enabled:
1. Before transforms: Query DISTINCT original values for each column
2. Execute all privacy transforms
3. Create one key map table: `{tableName}_keymap`
4. Table schema: `column_name VARCHAR, original VARCHAR, obfuscated VARCHAR`
5. Insert all mappings for all columns

**Benefits:**
- Single table for entire batch (not one per column)
- Works with recipes (table creation is part of the batch command)
- No user interaction needed during recipe execution
- Key map table can be exported like any other table
- Easy to look up any column's mapping in one place

### 5. Privacy Sub-Panel UI

When user selects any privacy transform, CleanPanel shows an **expanded sub-panel** instead of the standard single-column config:

**Sub-Panel Layout:**
```
┌─────────────────────────────────────────────────────┐
│ Privacy Transforms                                   │
├─────────────────────────────────────────────────────┤
│ Secret Key: [__________________] (for hash)         │
│                                                      │
│ Column Rules:                                        │
│ ┌─────────────┬──────────────┬─────┐               │
│ │ Column      │ Method       │  ✕  │               │
│ ├─────────────┼──────────────┼─────┤               │
│ │ email       │ [hash    ▼]  │  ✕  │               │
│ │ phone       │ [mask    ▼]  │  ✕  │               │
│ │ ssn         │ [last4   ▼]  │  ✕  │               │
│ └─────────────┴──────────────┴─────┘               │
│ [+ Add Column]                                       │
│                                                      │
│ ☐ Generate Key Map Table                            │
│                                                      │
│ Preview:                                             │
│ ┌─────────────────────────────────────┐             │
│ │ (ScrubPreview component)            │             │
│ └─────────────────────────────────────┘             │
│                                                      │
│ [Apply All] [Cancel]                                │
└─────────────────────────────────────────────────────┘
```

**Key Features:**
- Reuses `ScrubPreview` component for live preview
- Secret input validates min 5 chars when hash method is used
- Single "Generate Key Map" checkbox for all rules
- One key map table created: `{tableName}_keymap` with columns: `column_name`, `original`, `obfuscated`
- Apply executes all transforms sequentially as a batch command

**State Management:**
- Use local component state for rule configuration (similar to current ScrubPanel)
- No need for scrubberStore - state is ephemeral within CleanPanel

### 6. Files to Modify

| File | Changes |
|------|---------|
| `src/lib/transformations.ts` | Add `privacy_batch` TransformationDefinition + `privacy` group |
| `src/types/index.ts` | Add `privacy_batch` to `TransformationType`, add `ScrubMethod` type |
| `src/lib/commands/registry.ts` | Add `scrub:batch`, `scrub:last4`, `scrub:zero`, `scrub:scramble` mappings |
| `src/lib/commands/scrub/index.ts` | Export new commands |
| `src/lib/recipe/recipe-exporter.ts` | Add `scrub:batch` to `INCLUDED_COMMANDS` |
| `src/components/clean/GroupedTransformationPicker.tsx` | Add `teal` color |
| `src/components/panels/CleanPanel.tsx` | Render PrivacySubPanel when `privacy_batch` selected |
| `src/components/layout/FeaturePanel.tsx` | Remove ScrubPanel case |
| `src/stores/previewStore.ts` | Remove 'scrub' panel type |
| `src/lib/obfuscation.ts` | Remove faker/jitter, add last4/zero/scramble preview functions |

### 7. New Files to Create

| File | Purpose |
|------|---------|
| `src/lib/commands/scrub/last4.ts` | Last 4 digits command (Tier 1) |
| `src/lib/commands/scrub/zero.ts` | Zero out digits command (Tier 1) |
| `src/lib/commands/scrub/scramble.ts` | Scramble digits command (Tier 1) |
| `src/lib/commands/scrub/batch.ts` | Batch privacy command (Tier 3) |
| `src/components/clean/PrivacySubPanel.tsx` | Sub-panel UI for multi-column config |

### 8. Files to Delete

| File | Reason |
|------|--------|
| `src/components/panels/ScrubPanel.tsx` | Consolidated into CleanPanel |
| `src/features/scrubber/ScrubberPage.tsx` | No longer needed |
| `src/features/scrubber/components/ColumnRuleTable.tsx` | No longer needed |
| `src/features/scrubber/components/PreviewPanel.tsx` | No longer needed |
| `src/stores/scrubberStore.ts` | No longer needed |

## Implementation Order

1. **Phase 1: Add Privacy Transform Entry**
   - Add `privacy_batch` TransformationDefinition to `transformations.ts`
   - Add `privacy` group with `teal` color
   - Add `teal` color to GroupedTransformationPicker
   - Update types

2. **Phase 2: Create Individual Scrub Commands**
   - Implement `last4`, `zero`, `scramble` commands (Tier 1)
   - Register in registry with tier classifications
   - Update obfuscation.ts with preview functions

3. **Phase 3: Create Batch Command**
   - Implement `scrub:batch` command (Tier 3)
   - Handle key map table creation
   - Add to recipe exporter

4. **Phase 4: Create Privacy Sub-Panel UI**
   - Create `PrivacySubPanel.tsx` component
   - Reuse ScrubPreview for live preview
   - Integrate into CleanPanel (conditional render)

5. **Phase 5: Cleanup**
   - Remove ScrubPanel from FeaturePanel
   - Delete deprecated files (scrubberStore, ScrubberPage, etc.)
   - Remove faker/jitter from obfuscation.ts

## Verification

- [ ] "Privacy" group appears in Transform panel with `privacy_batch` entry
- [ ] Clicking opens sub-panel with multi-column configuration
- [ ] All 7 methods available in method dropdown (redact, mask, hash, last4, zero, scramble, year_only)
- [ ] Hash method requires secret (min 5 chars) before apply
- [ ] Preview shows before/after for all configured columns
- [ ] "Generate Key Map Table" checkbox creates `{tableName}_keymap` table
- [ ] Key map table appears in sidebar and can be exported
- [ ] Batch privacy transform can be added to recipes
- [ ] Recipes with batch privacy create key map tables when run
- [ ] Undo/redo works for batch privacy transforms (restores all columns)
- [ ] Scrub panel is removed from sidebar
- [ ] No console errors or TypeScript errors
