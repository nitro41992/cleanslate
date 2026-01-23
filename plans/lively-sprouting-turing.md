# Cleanup: Dependency Injection + Dead Code Removal

## Overview

Two follow-up tasks from the Tier 2/3 audit implementation:

1. **Implement Dependency Injection in `audit-capture.ts`** - Remove global DB imports, pass connection as argument
2. **Remove Dead Code in `transformations.ts`** - Delete the legacy `captureRowDetails` function

---

## Task 1: Dependency Injection in audit-capture.ts

### Problem

The utility imports global `execute` and `query` from `@/lib/duckdb`:
```typescript
// Current (BAD):
import { execute, query } from '@/lib/duckdb'
```

This couples audit logic to a specific database instance and violates the plan's "Inversion of Control" principle.

### Solution

Define a `DbConnection` interface matching `CommandContext.db` and pass it as the first argument to all functions.

### Implementation

**File**: `src/lib/commands/audit-capture.ts`

#### Step 1.1: Add DbConnection interface

```typescript
/**
 * Database connection interface (matches CommandContext.db)
 * Supports dependency injection for testability
 */
export interface DbConnection {
  query: <T>(sql: string) => Promise<T[]>
  execute: (sql: string) => Promise<void>
}
```

#### Step 1.2: Remove global imports

```diff
- import { execute, query } from '@/lib/duckdb'
```

#### Step 1.3: Update function signatures

Add `db: DbConnection` as the first argument to all functions:

| Function | New Signature |
|----------|---------------|
| `ensureAuditDetailsTable` | `(db: DbConnection) => Promise<void>` |
| `captureTier23RowDetails` | `(db: DbConnection, params: Tier23CaptureParams) => Promise<boolean>` |
| `captureStandardizeDateDetails` | `(db: DbConnection, tableName, column, auditEntryId, params?) => Promise<boolean>` |
| `captureCalculateAgeDetails` | `(db: DbConnection, tableName, column, auditEntryId) => Promise<boolean>` |
| `captureFillDownDetails` | `(db: DbConnection, tableName, column, auditEntryId) => Promise<boolean>` |
| `captureCastTypeDetails` | `(db: DbConnection, tableName, column, auditEntryId, params?) => Promise<boolean>` |
| `captureSplitColumnDetails` | `(db: DbConnection, tableName, column, auditEntryId, params?) => Promise<boolean>` |
| `captureCombineColumnsDetails` | `(db: DbConnection, tableName, auditEntryId, params?) => Promise<boolean>` |
| `captureUnformatCurrencyDetails` | `(db: DbConnection, tableName, column, auditEntryId) => Promise<boolean>` |
| `captureFixNegativesDetails` | `(db: DbConnection, tableName, column, auditEntryId) => Promise<boolean>` |
| `capturePadZerosDetails` | `(db: DbConnection, tableName, column, auditEntryId, params?) => Promise<boolean>` |
| `captureFilterEmptyDetails` | `(db: DbConnection, tableName, column, auditEntryId) => Promise<boolean>` |
| `checkRowDetailsInserted` | `(db: DbConnection, auditEntryId) => Promise<boolean>` |

#### Step 1.4: Replace all calls inside functions

```diff
- await execute(insertSql)
+ await db.execute(insertSql)

- const countResult = await query<{ count: number }>(...)
+ const countResult = await db.query<{ count: number }>(...)
```

---

## Task 2: Update Callers (executor.ts)

**File**: `src/lib/commands/executor.ts`

### Critical: Type Mismatch Requires Adapter

**The Problem:**
- `ctx.db.query()` returns `Promise<Table>` (Apache Arrow format)
- `DbConnection.query()` expects `Promise<T[]>` (JSON array format)

**The Solution:** Create a lightweight adapter inside `executor.ts` that handles the conversion.

#### Step 2.1: Verify Type Compatibility (No Adapter Needed)

**Good news:** After checking `src/lib/commands/context.ts`, the `ctx.db` interface already matches `DbConnection`:

```typescript
// context.ts lines 55-59
db: {
  query: async <T>(sql: string): Promise<T[]> => {
    return query<T>(sql)  // Already returns T[] from global helper
  },
  execute: async (sql: string): Promise<void> => {
    return execute(sql)
  },
  // ...
}
```

The global `query` helper handles Arrow → JSON conversion internally, so `ctx.db` can be passed directly to `audit-capture.ts` functions.

**Simplified Implementation:**
```typescript
// No adapter needed - ctx.db matches DbConnection interface
await ensureAuditDetailsTable(ctx.db)
await captureTier23RowDetails(ctx.db, { ... })
```

#### Step 2.2: Update `capturePreExecutionDetails`

```typescript
private async capturePreExecutionDetails(
  ctx: CommandContext,
  command: Command,
  auditEntryId: string
): Promise<void> {
  const column = (command.params as { column?: string }).column

  await ensureAuditDetailsTable(ctx.db)  // Pass ctx.db directly

  const transformationType = command.type
    .replace('transform:', '')
    .replace('scrub:', '')
    .replace('edit:', '')

  const isStructuralTransform = ['combine_columns', 'split_column'].includes(transformationType)
  if (column || isStructuralTransform) {
    await captureTier23RowDetails(ctx.db, {  // Pass ctx.db directly
      tableName: ctx.table.name,
      column: column || '',
      transformationType,
      auditEntryId,
      params: command.params as Record<string, unknown>,
    })
  }
}
```

#### Step 2.3: Update `captureTier1RowDetails`

```typescript
private async captureTier1RowDetails(
  ctx: CommandContext,
  column: string,
  auditEntryId: string
): Promise<void> {
  await ensureAuditDetailsTable(ctx.db)  // Pass ctx.db directly
  // ... rest of existing logic unchanged ...
}
```

---

## Task 3: Replace Legacy Code in transformations.ts

**File**: `src/lib/transformations.ts`

### Problem

The legacy `captureRowDetails` function (starting at line 721) duplicates the logic now in `audit-capture.ts`. However, it's still being called by `applyTransformation` (line 1209) which is used by `timeline-engine.ts` for replay functionality.

### Solution

Replace the ~340-line implementation with a thin wrapper that calls the shared `audit-capture.ts` utility. This eliminates code duplication while maintaining backward compatibility.

### Implementation

#### Step 3.1: Create a DbConnection adapter from global imports

Since `transformations.ts` doesn't have a `CommandContext`, create a simple adapter:

```typescript
import { execute, query } from '@/lib/duckdb'
import { captureTier23RowDetails, DbConnection } from '@/lib/commands/audit-capture'

// Adapter to use global DB functions with the new interface
const globalDbConnection: DbConnection = {
  query: query,
  execute: execute,
}
```

#### Step 3.2: Replace `captureRowDetails` with wrapper

Delete the ~340-line function and replace with:

```typescript
/**
 * Capture row-level details for a transformation
 * @deprecated Use audit-capture.ts directly for new code
 */
async function captureRowDetails(
  tableName: string,
  step: TransformationStep,
  auditEntryId: string,
  affectedCount: number
): Promise<boolean> {
  // Skip if no rows affected or threshold exceeded
  if (affectedCount === 0 || affectedCount > ROW_DETAIL_THRESHOLD) {
    return affectedCount > 0 && affectedCount <= ROW_DETAIL_THRESHOLD
  }

  return await captureTier23RowDetails(globalDbConnection, {
    tableName,
    column: step.column || '',
    transformationType: step.type,
    auditEntryId,
    params: step.params,
  })
}
```

#### Step 3.3: Update imports in transformations.ts

```typescript
import {
  ensureAuditDetailsTable,
  captureTier23RowDetails,
  ROW_DETAIL_THRESHOLD,
  DbConnection,
} from '@/lib/commands/audit-capture'
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/commands/audit-capture.ts` | 1) Add `DbConnection` interface, 2) Remove global imports, 3) Add `db` param to all functions |
| `src/lib/commands/executor.ts` | Update calls to pass `ctx.db` |
| `src/lib/transformations.ts` | Replace `captureRowDetails` (~340 lines) with thin wrapper (~15 lines) calling shared utility |

---

## Verification Steps

### After Implementation

```bash
# 1. TypeScript build check
npm run build

# 2. Lint check
npm run lint

# 3. Run regression tests
npm test -- --grep "FR-REGRESSION"

# 4. Verify wrapper is small (~15 lines, not ~340)
wc -l src/lib/transformations.ts
# Should be significantly smaller than before
```

### Manual Verification

1. Load a CSV with date data
2. Apply "Standardize Date" transformation
3. Open Audit Sidebar → Click "View details"
4. Verify modal shows correct before/after values

---

## Key Points

- **Keep `break-all` CSS** - Required for JSON strings without spaces
- **Keep split-timing strategy** - Tier 2/3 before execution, Tier 1 after execution
- **Interface matches `CommandContext.db`** - Full compatibility with existing code
