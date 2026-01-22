# Module F: Value Standardization (Clustering & Cleanup)

## Overview
Add a new feature module for clustering and standardizing values in a column using key collision algorithms (Fingerprint, Metaphone). Users can review clusters, select a master value, and bulk-update all variations to match.

## Requirements Summary
- **FR-F1**: Cluster distinct values using Fingerprint (normalization) or Metaphone (phonetic)
- **FR-F2**: Review interface with auto-suggested master values (most frequent)
- **FR-F3**: Bulk UPDATE with audit logging and drill-down support
- **Scale**: Up to 2M records; limit 50k unique values for clustering

---

## File Structure

### New Files
```
src/
├── stores/standardizerStore.ts          # Zustand store
├── lib/standardizer-engine.ts           # Clustering algorithms & DB operations
├── hooks/useStandardizer.ts             # Hook with progress/cancellation
├── features/standardizer/
│   ├── index.ts
│   ├── StandardizeView.tsx              # Full-screen overlay
│   └── components/
│       ├── StandardizeConfigPanel.tsx   # Left panel config
│       ├── ClusterList.tsx              # Virtualized cluster list
│       ├── ClusterCard.tsx              # Expandable cluster card
│       └── ClusterProgress.tsx          # Progress indicator
e2e/
├── fixtures/csv/fr_f_standardize.csv
├── page-objects/standardize-view.page.ts
└── tests/value-standardization.spec.ts
```

### Modified Files
- `src/types/index.ts` - Add standardizer types
- `src/stores/previewStore.ts` - Add 'standardize' panel type
- `src/components/layout/ActionToolbar.tsx` - Add toolbar button
- `src/App.tsx` - Render StandardizeView overlay

---

## Implementation Plan

### Phase 1: Core Infrastructure

**1. Types (`src/types/index.ts`)**
```typescript
export type ClusteringAlgorithm = 'fingerprint' | 'metaphone'

export interface ValueCluster {
  id: string
  clusterKey: string              // Computed key (fingerprint or metaphone)
  values: ClusterValue[]
  masterValue: string             // Most frequent (auto-suggested)
  selectedCount: number
}

export interface ClusterValue {
  id: string
  value: string
  count: number                   // Frequency in dataset
  isSelected: boolean
  isMaster: boolean
}
```

**2. Store (`src/stores/standardizerStore.ts`)**
- Follow `matcherStore.ts` pattern
- State: tableId, columnName, algorithm, clusters, isAnalyzing, progress, selectedIds
- Actions: openView, closeView, setColumn, setClusters, toggleValueSelection, setMasterValue

**3. Engine (`src/lib/standardizer-engine.ts`)**

Key functions:
```typescript
// Validation - MUST run before clustering
validateColumnForClustering(tableName, columnName): Promise<{valid, count, error?}>
  // Returns error if unique values > 50,000

// Clustering algorithms
generateFingerprint(value): string
  // lowercase → remove accents → remove punctuation → sort tokens → join
  // "Smith, John" → "john smith"

generateMetaphoneKey(value): string
  // Reuse doubleMetaphone from fuzzy-matcher.ts
  // "Mik Smith" → "MK SM0"

// Main clustering function with chunked processing
buildClusters(tableName, columnName, algorithm, onProgress, shouldCancel): Promise<ValueCluster[]>
  // 1. Query distinct values with counts from DuckDB
  // 2. Compute keys in JS (chunked, 5000 at a time)
  // 3. Group by key, identify master (most frequent)

// Apply changes
applyStandardization(tableName, columnName, mappings, auditEntryId): Promise<{rowsAffected, hasRowDetails}>
```

**4. Hook (`src/hooks/useStandardizer.ts`)**
- Wrap engine functions with React state
- Support cancellation via ref
- Report progress to store

### Phase 2: UI Components

**5. StandardizeView (`src/features/standardizer/StandardizeView.tsx`)**
- Full-screen overlay (like MatchView)
- Layout: Header | Left Config Panel (w-80) | Right Results Area
- Header: Back button, title, progress bar, Apply button
- Keyboard: Escape to close, 1/2 for filters

**6. StandardizeConfigPanel**
- Table selector
- Column selector
- Algorithm selector (Fingerprint / Metaphone)
- Validation status display
- "Analyze Values" button

**7. ClusterList (virtualized)**
- Use @tanstack/react-virtual for performance
- Filter: All / Actionable (clusters with >1 value)
- Search input

**8. ClusterCard**
```
┌─────────────────────────────────────────────┐
│ 🔗 "john smith"           3 values     [▼] │
│    Master: "John Smith" (150 rows)          │
├─────────────────────────────────────────────┤
│ ☑ "John Smith"    (150)    ⭐ Master       │
│ ☑ "JOHN SMITH"    (45)     [Set Master]    │
│ ☐ "john  smith"   (12)     [Set Master]    │
└─────────────────────────────────────────────┘
```

### Phase 3: Integration

**9. Toolbar & Routing**
- Add "Standardize" button to ActionToolbar (keyboard shortcut: 6)
- Add to App.tsx render logic
- Wire keyboard shortcuts in AppLayout

### Phase 4: Audit Integration

**10. Audit Table Schema**
```sql
CREATE TABLE IF NOT EXISTS _standardize_audit_details (
  id VARCHAR PRIMARY KEY,
  audit_entry_id VARCHAR NOT NULL,
  from_value VARCHAR NOT NULL,
  to_value VARCHAR NOT NULL,
  row_count INTEGER NOT NULL,
  created_at TIMESTAMP
)
```

**11. Audit Entry**
```typescript
addTransformationEntry({
  tableId, tableName,
  action: 'Standardize Values',
  details: `Standardized ${count} values in '${column}' using ${algorithm}`,
  rowsAffected: totalRows,
  hasRowDetails: totalRows <= 10000,
  auditEntryId,
})
```

**12. Drill-down Modal**
- Extend AuditDetailModal to handle 'Standardize Values' action
- Display: Original Value | Standardized To | Rows Changed

### Phase 5: Testing

**13. Test Fixture (`fr_f_standardize.csv`)**
```csv
id,name,email,company
1,John Smith,john@example.com,Acme Inc
2,JOHN SMITH,john.smith@test.org,Acme Inc
3,john  smith,jsmith@mail.com,ACME INC
4,Mik Smith,mik@example.com,Beta Corp
5,Mike Smith,mike@example.com,Beta Corp
```

**14. E2E Tests (TDD - expected to fail initially)**
- FR-F1: Validate 50k unique value limit
- FR-F1: Cluster values using fingerprint algorithm
- FR-F1: Cluster values using metaphone algorithm
- FR-F2: Auto-suggest most frequent as master
- FR-F2: Allow user to change master value
- FR-F3: Apply bulk standardization
- FR-F3: Create audit entry with drill-down details

---

## Performance Strategy

1. **Pre-validation**: Count distinct values BEFORE clustering
   - If > 50,000: Block with error message

2. **Chunked processing**: Process 5,000 values per chunk
   - Yield to UI thread between chunks
   - Report progress after each chunk

3. **Cancellation**: Check shouldCancel() between chunks

4. **SQL optimization**: Single UPDATE with CASE-WHEN for bulk changes

---

## Key Reference Files
- `src/features/matcher/MatchView.tsx` - Full-screen overlay pattern
- `src/stores/matcherStore.ts` - Store structure pattern
- `src/lib/fuzzy-matcher.ts` - doubleMetaphone function, chunked processing
- `src/lib/transformations.ts` - Audit detail capture pattern

---

## Verification Plan

1. **Manual Testing**
   - Load CSV with name variations
   - Open Standardize view, select name column
   - Run Fingerprint clustering → verify "John Smith" variants grouped
   - Run Metaphone clustering → verify "Mik/Mike Smith" grouped
   - Select values, set master, apply
   - Verify data updated in grid
   - Check audit log entry with drill-down

2. **E2E Tests**
   ```bash
   npm test -- --grep "FR-F"
   ```

3. **Performance Testing**
   - Test with 50,001 unique values → expect block message
   - Test with 2M rows, 10k unique values → should complete
