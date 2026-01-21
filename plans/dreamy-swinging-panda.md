# Merge Audit Drill-Down & Row Selection UI

## Overview

Two enhancements to the Fuzzy Matcher feature:
1. **Audit Drill-Down for Merges** - Show kept/deleted row pairs in audit detail modal
2. **Row Selection UI** - Let users swap which row is kept before applying merges

---

## Feature 1: Row Selection UI in MatchRow

### Problem
Currently, `rowA` is always kept and `rowB` is always deleted. Users cannot choose which row to keep.

### Solution
Add a `keepRow` field to track user preference, with a swap button in the expanded view.

### UI Design

**Expanded MatchRow - Updated Layout:**
```
┌─────────────────────────────────────────────────────────────────────┐
│ ☐  John Smith  vs  Jon Smith     [92% Similar]  ▼   [✓] [✗]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────────────┐    ⇄    ┌─────────────────────┐          │
│   │ ✓ KEEPING           │  SWAP   │ ✗ DELETING          │          │
│   │ ─────────────────── │ BUTTON  │ ─────────────────── │          │
│   │ name: John Smith    │         │ name: Jon Smith     │          │
│   │ email: john@ex.com  │         │ email: j@example.com│          │
│   │ phone: 555-1234     │         │ phone: 555-1234     │          │
│   └─────────────────────┘         └─────────────────────┘          │
│                                                                     │
│   2 fields match exactly, 1 similar                                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Visual Styling:**
- **KEEPING column**: Green left border (`border-l-4 border-green-500`), subtle green background (`bg-green-500/5`)
- **DELETING column**: Red left border (`border-l-4 border-red-500`), subtle red background (`bg-red-500/5`), muted text (`text-muted-foreground`)
- **Swap button**: Centered between columns, icon-only (`ArrowLeftRight` from lucide), ghost variant with hover state

### Files to Modify

#### 1. `src/types/index.ts` - Add keepRow field
```typescript
export interface MatchPair {
  // ... existing fields
  keepRow: 'A' | 'B'  // NEW: Which row to keep (default 'A')
}
```

#### 2. `src/stores/matcherStore.ts` - Add swap action
```typescript
interface MatcherActions {
  // ... existing actions
  swapKeepRow: (pairId: string) => void
}

// Implementation
swapKeepRow: (pairId) => {
  const { pairs, definiteThreshold, maybeThreshold } = get()
  const updatedPairs = pairs.map((p) =>
    p.id === pairId ? { ...p, keepRow: p.keepRow === 'A' ? 'B' : 'A' } : p
  )
  set({ pairs: updatedPairs })
}
```

#### 3. `src/lib/fuzzy-matcher.ts` - Initialize keepRow & respect it in merge
```typescript
// In findDuplicates() - add default keepRow
pairs.push({
  // ... existing fields
  keepRow: 'A',  // Default to keeping first row
})

// In mergeDuplicates() - respect keepRow choice
for (const pair of mergedPairs) {
  const rowToDelete = pair.keepRow === 'A' ? pair.rowB : pair.rowA
  const keyValue = rowToDelete[keyColumn]
  // ... delete logic using keyValue
}
```

#### 4. `src/features/matcher/components/MatchRow.tsx` - Update UI
- Add `onSwapKeepRow` prop
- Replace "Record A / Record B" headers with "KEEPING / DELETING" labels
- Add swap button between columns
- Apply conditional styling based on `pair.keepRow`

---

## Feature 2: Merge Audit Drill-Down

### Problem
"Apply Merges" creates audit entry but no row-level details. Users cannot see which rows were kept/deleted.

### Solution
Capture merge details before deletion and display in a pair-focused modal view.

### Data Schema

#### New table: `_merge_audit_details`
```sql
CREATE TABLE IF NOT EXISTS _merge_audit_details (
  id VARCHAR PRIMARY KEY,
  audit_entry_id VARCHAR NOT NULL,
  pair_index INTEGER NOT NULL,
  similarity INTEGER NOT NULL,
  match_column VARCHAR NOT NULL,
  kept_row_data JSON NOT NULL,      -- Full row as JSON
  deleted_row_data JSON NOT NULL,   -- Full row as JSON
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
CREATE INDEX idx_merge_audit_entry ON _merge_audit_details(audit_entry_id)
```

### UI Design - Merge Detail Modal

**Modal Layout:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  🔀 Merge Details                                    [Export CSV]    │
│  Detailed view of merged duplicate pairs                             │
├──────────────────────────────────────────────────────────────────────┤
│  Action: Apply Merges    Table: customers    Pairs: 3    2:34 PM     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  PAIR 1                                         92% Similar    │  │
│  │  ──────────────────────────────────────────────────────────── │  │
│  │                                                                │  │
│  │  ✓ KEPT                          ✗ DELETED                     │  │
│  │  ┌─────────────────────┐        ┌─────────────────────┐       │  │
│  │  │ name: John Smith    │        │ name: Jon Smith     │       │  │
│  │  │ email: john@ex.com  │        │ email: j@ex.com     │       │  │
│  │  │ id: 1               │        │ id: 8               │       │  │
│  │  └─────────────────────┘        └─────────────────────┘       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  PAIR 2                                         87% Similar    │  │
│  │  ...                                                           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ◀ ■ ■ ■ ▶   Page 1 of 2                                            │
└──────────────────────────────────────────────────────────────────────┘
```

**Visual Styling:**
- **Pair cards**: Border with subtle gradient (`border border-border/50`), rounded corners
- **KEPT section**: Green accent (`border-l-4 border-green-500`), green badge with checkmark
- **DELETED section**: Red accent (`border-l-4 border-red-500`), red badge with X, strikethrough on key values
- **Similarity badge**: Positioned top-right of card, uses existing classification colors (green/yellow/red)

### Files to Create/Modify

#### 1. `src/lib/fuzzy-matcher.ts` - Capture merge details
```typescript
export async function mergeDuplicates(
  tableName: string,
  pairs: MatchPair[],
  keyColumn: string,
  auditEntryId?: string  // NEW: For linking to audit
): Promise<number> {
  const mergedPairs = pairs.filter((p) => p.status === 'merged')
  if (mergedPairs.length === 0) return 0

  // Capture details BEFORE deleting
  if (auditEntryId) {
    await ensureMergeAuditTable()
    for (let i = 0; i < mergedPairs.length; i++) {
      const pair = mergedPairs[i]
      const keptRow = pair.keepRow === 'A' ? pair.rowA : pair.rowB
      const deletedRow = pair.keepRow === 'A' ? pair.rowB : pair.rowA
      await query(`
        INSERT INTO _merge_audit_details VALUES (
          '${generateId()}',
          '${auditEntryId}',
          ${i},
          ${pair.similarity},
          '${keyColumn}',
          '${JSON.stringify(keptRow)}',
          '${JSON.stringify(deletedRow)}',
          CURRENT_TIMESTAMP
        )
      `)
    }
  }

  // ... existing delete logic
}
```

#### 2. `src/features/matcher/MatchView.tsx` - Pass auditEntryId
```typescript
const handleApplyMerges = async () => {
  const auditEntryId = generateId()  // Generate before merge
  const deletedCount = await mergeDuplicates(tableName, pairs, matchColumn, auditEntryId)

  if (deletedCount > 0 && tableId) {
    // ... existing row count update

    addAuditEntry(tableId, tableName, 'Apply Merges',
      `Removed ${deletedCount} duplicate rows from table`, 'A',
      deletedCount, true, auditEntryId)  // hasRowDetails=true, auditEntryId
  }
}
```

#### 3. `src/stores/auditStore.ts` - Update addEntry signature
Add optional `hasRowDetails` and `auditEntryId` parameters.

#### 4. `src/components/common/MergeDetailTable.tsx` - NEW COMPONENT
New component for displaying merge pair details (card-based layout).

#### 5. `src/components/common/AuditDetailModal.tsx` - Conditional rendering
```typescript
// Detect merge action and render appropriate view
{entry.action === 'Apply Merges' ? (
  <MergeDetailTable auditEntryId={entry.auditEntryId} />
) : (
  <AuditDetailTable auditEntryId={entry.auditEntryId} />
)}
```

---

## Implementation Order

### Phase 1: Row Selection UI
1. Add `keepRow` field to `MatchPair` type
2. Add `swapKeepRow` action to matcherStore
3. Update `findDuplicates()` to initialize `keepRow: 'A'`
4. Update `mergeDuplicates()` to respect `keepRow` choice
5. Update `MatchRow.tsx` with new UI (swap button, KEEPING/DELETING labels)

### Phase 2: Merge Audit Drill-Down
1. Create `ensureMergeAuditTable()` function
2. Update `mergeDuplicates()` to capture details
3. Update `addAuditEntry` to support `hasRowDetails` and `auditEntryId`
4. Update `handleApplyMerges()` to pass auditEntryId
5. Create `MergeDetailTable.tsx` component
6. Update `AuditDetailModal.tsx` to conditionally render merge view

---

## Verification

### Manual Testing
1. Load CSV with duplicates → Open Match view
2. Find duplicates → Expand a pair → Click swap button → Verify labels change
3. Mark pairs as merged (some with swapped rows) → Apply Merges
4. Open Audit sidebar → Click "Apply Merges" entry → Verify drill-down shows:
   - Each pair with KEPT/DELETED labels
   - Correct rows based on swap choices
   - Similarity percentage
   - All column values

### Automated Tests
```bash
npm test -- --grep "FR-C1"
npm run lint
```

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/types/index.ts` | Modify | Add `keepRow` to MatchPair |
| `src/stores/matcherStore.ts` | Modify | Add `swapKeepRow` action |
| `src/stores/auditStore.ts` | Modify | Update `addEntry` signature |
| `src/lib/fuzzy-matcher.ts` | Modify | Initialize keepRow, capture merge details |
| `src/features/matcher/components/MatchRow.tsx` | Modify | Add swap UI, KEEPING/DELETING labels |
| `src/features/matcher/MatchView.tsx` | Modify | Pass auditEntryId to merge |
| `src/components/common/MergeDetailTable.tsx` | Create | New merge-specific detail view |
| `src/components/common/AuditDetailModal.tsx` | Modify | Conditional render for merges |
