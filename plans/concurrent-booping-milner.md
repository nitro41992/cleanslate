# Workflow Restructure & Checkpoint Feature Plan

## Summary

Restructure the app workflow to be more linear and add table checkpoint functionality:

**New Workflow Order:** Laundromat → Matcher → Combiner → Scrubber → Diff

**New Features:**
- Checkpoint button (sidebar) - Save table state with lineage tracking
- New Table button (sidebar) - Import new tables
- Combiner module - Stack/join tables (FR-E)

---

## Phase 1: Type System Updates

### File: `src/types/index.ts`

Add lineage tracking to `TableInfo`:

```typescript
export interface TableInfo {
  // ... existing fields
  parentTableId?: string        // Source table ID (for checkpoints)
  isCheckpoint?: boolean        // Flag for checkpoint tables
  lineage?: TableLineage        // Full transformation history
}

export interface TableLineage {
  sourceTableId: string
  sourceTableName: string
  transformations: LineageTransformation[]
  checkpointedAt: Date
}

export interface LineageTransformation {
  action: string
  details: string
  timestamp: Date
  rowsAffected?: number
}
```

Add Combiner types:

```typescript
export type JoinType = 'left' | 'inner' | 'full_outer'

export interface StackValidation {
  isValid: boolean
  missingInA: string[]
  missingInB: string[]
  warnings: string[]
}

export interface JoinValidation {
  isValid: boolean
  keyColumnMismatch: boolean
  warnings: string[]
}
```

---

## Phase 2: DuckDB Layer

### File: `src/lib/duckdb/index.ts`

Add `duplicateTable` function:

```typescript
export async function duplicateTable(
  sourceName: string,
  targetName: string
): Promise<{ columns: ColumnInfo[]; rowCount: number }>
```

Uses `CREATE TABLE AS SELECT * FROM` for efficient copying.

---

## Phase 3: Combiner Engine

### New File: `src/lib/combiner-engine.ts`

Functions:
- `validateStack(tableA, tableB)` - Check column alignment
- `stackTables(tableA, tableB, resultName)` - UNION ALL with NULL for missing columns
- `validateJoin(tableA, tableB, keyColumn)` - FR-E3 clean-first guardrail
- `autoCleanKeys(tableA, tableB, keyColumn)` - Trim whitespace on key columns
- `joinTables(left, right, keyColumn, joinType, resultName)` - Execute join

---

## Phase 4: Combiner Store

### New File: `src/stores/combinerStore.ts`

State:
- `mode`: 'stack' | 'join'
- `stackTablesIds`: string[]
- `leftTableId`, `rightTableId`, `keyColumn`, `joinType`
- `stackValidation`, `joinValidation`
- `resultTableName`, `isProcessing`, `error`

---

## Phase 5: Sidebar Updates

### File: `src/components/layout/AppShell.tsx`

**1. Reorder `navItems` (lines 43-68):**

```typescript
const navItems = [
  { label: 'Laundromat', icon: Sparkles, path: '/laundromat', description: 'Clean & transform data' },
  { label: 'Matcher', icon: Users, path: '/matcher', description: 'Find duplicates' },
  { label: 'Combiner', icon: Merge, path: '/combiner', description: 'Stack & join tables' },
  { label: 'Scrubber', icon: Shield, path: '/scrubber', description: 'Obfuscate data' },
  { label: 'Diff', icon: GitCompare, path: '/diff', description: 'Compare tables' },
]
```

**2. Add imports:**
```typescript
import { Merge, Plus, Copy } from 'lucide-react'
```

**3. Add "New Table" button (line ~164):**

Add button next to "Tables" header that navigates to Laundromat and triggers file upload dialog.

**4. Add checkpoint button per table (lines 179-209):**

Add `Copy` icon button alongside existing `Trash2` button:
- Shows "(checkpoint)" label for checkpoint tables
- Hover reveals both checkpoint and delete buttons

**5. Add checkpoint handler:**

```typescript
const handleCheckpoint = async (tableId: string) => {
  // 1. Get audit entries for table (transformations)
  // 2. Generate checkpoint name: `{tableName}_checkpoint_{timestamp}`
  // 3. Call duplicateTable() in DuckDB
  // 4. Add to tableStore with lineage
}
```

---

## Phase 6: Table Store Updates

### File: `src/stores/tableStore.ts`

Add `checkpointTable` action:

```typescript
checkpointTable: async (
  sourceId: string,
  newName: string,
  transformations: LineageTransformation[]
) => string  // Returns new table ID
```

---

## Phase 7: Combiner Module

### New Directory: `src/features/combiner/`

```
src/features/combiner/
├── CombinerPage.tsx
└── components/
    ├── StackPanel.tsx
    ├── JoinPanel.tsx
    └── ValidationWarnings.tsx
```

**CombinerPage.tsx:**
- Tab interface: Stack | Join
- Stack: Multi-select tables, validate, execute UNION ALL
- Join: Select left/right tables, key column, join type
- FR-E3: Show warnings if keys need cleaning, offer "Auto-Clean Keys" button

---

## Phase 8: Router Update

### File: `src/App.tsx`

```typescript
import { CombinerPage } from '@/features/combiner/CombinerPage'

<Route path="/combiner" element={<CombinerPage />} />
```

---

## Critical Files

| File | Changes |
|------|---------|
| `src/types/index.ts` | Add lineage types, combiner types |
| `src/lib/duckdb/index.ts` | Add `duplicateTable()` |
| `src/lib/combiner-engine.ts` | **New** - stack/join logic |
| `src/stores/combinerStore.ts` | **New** - combiner state |
| `src/stores/tableStore.ts` | Add `checkpointTable()` action |
| `src/components/layout/AppShell.tsx` | Reorder nav, add buttons |
| `src/features/combiner/CombinerPage.tsx` | **New** - main UI |
| `src/App.tsx` | Add `/combiner` route |

---

## Verification Plan

1. **Navigation order**: Visually confirm sidebar shows correct order
2. **Checkpoint feature**:
   - Load table → Apply transform → Click checkpoint
   - Verify new table appears with "(checkpoint)" label
   - Verify lineage tracks parent and transformations
3. **New Table button**: Click button → Laundromat opens with file dialog
4. **Combiner - Stack (FR-E1)**:
   - Load `fr_e1_jan_sales.csv` (4 rows) and `fr_e1_feb_sales.csv` (5 rows)
   - Stack → Verify result has 9 rows
5. **Combiner - Join (FR-E2)**:
   - Load `fr_e2_orders.csv` and `fr_e2_customers.csv`
   - Inner join on `customer_id` → Verify 5 rows
   - Left join → Verify 6 rows with NULL for C004
6. **E2E Tests**: Remove `test.fail()` from FR-E1/FR-E2 tests and run:
   ```bash
   npm test -- --grep "FR-E"
   ```
7. **Lint check**: `npm run lint`
