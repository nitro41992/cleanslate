# Plan: Unified Audit Log Drill-Down System

## User Requirements (Clarified)

- **Drill-down scope**: Only for **modifications** (cell value changes), not additions/deletions
- **Summaries fine for**: Remove Duplicates, Scrub (hash, mask, redact), Combine (stack, join)
- **Undo/redo**: Required for all transforms (already works via Timeline)
- **Highlighting**: Cell-level for edits, column-level for transforms
- **Skip highlight button**: For full-table operations (stack, join, remove_duplicates, filter_empty)

### Key Distinction: Highlighting vs Drill-Down
| Feature | What it does | User interaction |
|---------|--------------|------------------|
| **Highlighting** | Highlights affected column(s)/cell(s) in grid | Click "Highlight" button in audit sidebar |
| **Drill-down** | Shows before/after values per row | Click audit entry to open modal |

Both features need to work independently - a transform can have working highlighting but broken drill-down (and vice versa).

## Problem Summary

| Issue | Transforms Affected | Root Cause |
|-------|---------------------|------------|
| **Empty drill-down** | Find & Replace (`replace`), Tier 1 transforms (trim, lowercase, uppercase, etc.) | `hasRowDetails: true` set but no capture logic in `audit-capture.ts` |
| **Identical before/after** | Date Standardization | Captures value but if input is already in target format, both look the same |
| **Three separate tables** | Generic, Merge, Standardize | Fragmented architecture with bespoke capture logic per type |

## Current State Analysis

### What Works Well
- **Undo/redo** via Timeline (single source of truth)
- **Highlighting** already implemented (`timelineStore.setHighlightedCommand()` → grid canvas rendering)
- **Audit entries** derived from Timeline commands automatically
- **Some drill-downs** work: `pad_zeros`, `cast_type`, `fill_down`, `standardize_date`, etc.

### What's Broken
1. **Find & Replace** claims `hasRowDetails: true` but no capture in `audit-capture.ts` switch
2. **Tier 1 transforms** (trim, lowercase, uppercase, etc.) claim drill-down support but no capture
3. **Date standardization** captures before/after but doesn't filter "no actual change" cases

### Architecture (Current - Fragmented)

```
_audit_details           → Generic transforms (audit-capture.ts)
_merge_audit_details     → Matcher merge operations (fuzzy-matcher.ts)
_standardize_audit_details → Value standardization (standardizer-engine.ts)
```

## Implementation Plan

### Phase 1: Fix Immediate Bugs

**1.1 Add Find & Replace capture** (`audit-capture.ts`)
```typescript
case 'replace':
  return await captureReplaceDetails(db, tableName, column, auditEntryId, transformParams)
```

The capture logic:
```sql
INSERT INTO _audit_details (...)
SELECT uuid(), auditEntryId, rowid, column,
  CAST(column AS VARCHAR) AS previous_value,
  REPLACE(column, 'find', 'replace') AS new_value
FROM table
WHERE column LIKE '%find%'
LIMIT 10000
```

**1.2 Fix Date Standardization "no visible change" case**

Update `captureStandardizeDateDetails()` to only capture rows where before ≠ after:
```sql
WHERE previous_value != new_value  -- Filter out no-change rows
```

**1.3 Update `drillDownSupported` set**

Remove transforms that shouldn't show drill-down (deletions/additions):
```typescript
const drillDownSupported = new Set([
  // Tier 1 modifications
  'trim', 'lowercase', 'uppercase', 'title_case', 'replace',
  'remove_accents', 'remove_non_printable', 'collapse_spaces', 'sentence_case',
  // Tier 2/3 modifications
  'unformat_currency', 'fix_negatives', 'pad_zeros',
  'standardize_date', 'calculate_age', 'fill_down', 'cast_type',
  'replace_empty',
])
// REMOVED: remove_duplicates, filter_empty (deletions - no drill-down)
```

### Phase 2: Pre/Post Capture for Tier 1 Transforms

**Concept**: Instead of bespoke capture per transform, capture actual before/after at execution time.

**2.1 Create `capturePreSnapshot()` utility** (new file: `src/lib/commands/audit-snapshot.ts`)

```typescript
export async function capturePreSnapshot(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string,
  affectedPredicate?: string // e.g., "column LIKE '% %'" for trim
): Promise<void> {
  // Store up to 10k affected rows in temporary snapshot
  await db.execute(`
    CREATE TEMP TABLE _audit_pre_${auditEntryId.slice(0,8)} AS
    SELECT _cs_id, CAST("${column}" AS VARCHAR) AS value
    FROM "${tableName}"
    WHERE ${affectedPredicate || '1=1'}
    LIMIT 10000
  `)
}
```

**2.2 Create `capturePostDiff()` utility**

```typescript
export async function capturePostDiff(
  db: DbConnection,
  tableName: string,
  column: string,
  auditEntryId: string
): Promise<boolean> {
  // Compare pre-snapshot with current values, store differences
  await db.execute(`
    INSERT INTO _audit_details (id, audit_entry_id, row_index, column_name, previous_value, new_value)
    SELECT uuid(), '${auditEntryId}', t.rowid, '${column}', pre.value, CAST(t."${column}" AS VARCHAR)
    FROM "${tableName}" t
    JOIN _audit_pre_${auditEntryId.slice(0,8)} pre ON t._cs_id = pre._cs_id
    WHERE pre.value != CAST(t."${column}" AS VARCHAR)  -- Only actual changes
  `)
  // Cleanup temp table
  await db.execute(`DROP TABLE IF EXISTS _audit_pre_${auditEntryId.slice(0,8)}`)
  return await checkRowDetailsInserted(db, auditEntryId)
}
```

**2.3 Integrate in `Tier1TransformCommand.execute()`**

```typescript
// In base.ts Tier1TransformCommand.execute()
if (drillDownSupported.has(transformType)) {
  await capturePreSnapshot(ctx.db, tableName, column, this.id, predicate)
}

// ... execute transform ...

if (drillDownSupported.has(transformType)) {
  await capturePostDiff(ctx.db, tableName, column, this.id)
}
```

### Phase 3: Unify Audit Detail Tables

**3.1 Create unified schema**

```sql
CREATE TABLE _unified_audit_details (
  id VARCHAR PRIMARY KEY,
  audit_entry_id VARCHAR NOT NULL,
  detail_type VARCHAR NOT NULL,  -- 'modification' | 'merge' | 'standardize'

  -- For modifications (cell changes)
  row_id VARCHAR,
  column_name VARCHAR,
  previous_value VARCHAR,
  new_value VARCHAR,

  -- For merge pairs (summary only)
  similarity FLOAT,
  kept_row_id VARCHAR,
  deleted_row_id VARCHAR,

  -- For standardization (value mappings)
  from_value VARCHAR,
  to_value VARCHAR,
  row_count INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

**3.2 Migrate existing tables**

```sql
-- Migrate _audit_details
INSERT INTO _unified_audit_details (id, audit_entry_id, detail_type, row_id, column_name, previous_value, new_value)
SELECT id, audit_entry_id, 'modification', row_index::VARCHAR, column_name, previous_value, new_value
FROM _audit_details;

-- Similar for _merge_audit_details, _standardize_audit_details
```

**3.3 Update query functions**

- `getAuditRowDetails()` → query `_unified_audit_details WHERE detail_type = 'modification'`
- `getMergeAuditDetails()` → query `_unified_audit_details WHERE detail_type = 'merge'`
- `getStandardizeAuditDetails()` → query `_unified_audit_details WHERE detail_type = 'standardize'`

**3.4 Update AuditDetailModal routing**

No change needed - the modal already routes based on `parsedDetails.type` or `entry.action`.

## Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `src/lib/commands/audit-capture.ts` | 1 | Add `captureReplaceDetails()`, fix date standardization WHERE clause |
| `src/lib/commands/transform/base.ts` | 1, 2 | Update `drillDownSupported` set, call pre/post capture |
| `src/lib/commands/audit-snapshot.ts` | 2 | NEW FILE: Pre/post snapshot utilities |
| `src/lib/commands/executor.ts` | 2 | Integrate pre/post capture for Tier 1 |
| `src/lib/transformations.ts` | 3 | Update `getAuditRowDetails()` to use unified table |
| `src/lib/fuzzy-matcher.ts` | 3 | Update `getMergeAuditDetails()` to use unified table |
| `src/lib/standardizer-engine.ts` | 3 | Update `getStandardizeAuditDetails()` to use unified table |
| `src/components/common/AuditDetailTable.tsx` | 1 | Handle "no changes" case gracefully (already shows "No row details available") |

## Verification

1. **Find & Replace**: Apply find/replace, open drill-down, verify before/after values shown
2. **Date Standardization**: Apply on already-formatted dates, verify empty drill-down (no changes)
3. **Tier 1 Transforms**: Apply trim/lowercase/uppercase, verify drill-down shows actual changes
4. **Highlighting**: Click "Highlight" on any audit entry, verify affected column/cells highlighted
5. **Undo/Redo**: Verify all transforms can be undone/redone from audit log

## Highlighting Audit Results

### Working (15 commands)
All Tier 1 transforms: `trim`, `lowercase`, `uppercase`, `title_case`, `sentence_case`, `replace`, `replace_empty`, `remove_accents`, `collapse_spaces`, `remove_non_printable`, `scrub:hash`, `scrub:mask`, `scrub:redact`, `scrub:year_only`, `edit:cell`

### Broken/Missing Highlighting (6 commands)
| Command | Issue | Fix |
|---------|-------|-----|
| `combine_columns` | No `getAffectedRowsPredicate()` | Add predicate: source columns not null |
| `calculate_age` | No predicate | Add predicate: DOB column not null |
| `match:merge` | No predicate | Add predicate: surviving rows from merge |
| `standardize:apply` | Stores IDs but no predicate | Use stored `affectedRowIds` |
| `edit:batch` | Returns null | Aggregate all changed cell predicates |
| `custom_sql` | Unknown affected rows | Can't reliably determine |

### Skip Highlight Button (user request: full-table ops)
- `combine:stack` - Creates new table
- `combine:join` - Creates new table
- `transform:rename_column` - Metadata only (no data change)
- `transform:remove_duplicates` - Rows deleted (nothing to highlight)
- `transform:filter_empty` - Rows deleted

## Implementation: Highlighting Fixes (Phase 4)

**4.1 Fix `combine_columns` highlighting** (`src/lib/commands/transform/combine-columns.ts`)
```typescript
async getAffectedRowsPredicate(): Promise<string | null> {
  const columns = this.params.columns || []
  if (columns.length === 0) return null
  // Rows where ANY source column is not null
  return columns.map(c => `"${c}" IS NOT NULL`).join(' OR ')
}
```

**4.2 Fix `calculate_age` highlighting** (`src/lib/commands/transform/calculate-age.ts`)
```typescript
async getAffectedRowsPredicate(): Promise<string | null> {
  const column = this.params.column
  if (!column) return null
  return `"${column}" IS NOT NULL` // All rows with DOB
}
```

**4.3 Fix `match:merge` highlighting** (`src/lib/commands/match/merge.ts`)
```typescript
async getAffectedRowsPredicate(): Promise<string | null> {
  // After merge, highlight surviving rows (kept records)
  const keptIds = this.params.keptRowIds || []
  if (keptIds.length === 0) return null
  return `"_cs_id" IN (${keptIds.map(id => `'${id}'`).join(', ')})`
}
```

**4.4 Fix `standardize:apply` highlighting** (`src/lib/commands/standardize/apply.ts`)
```typescript
async getAffectedRowsPredicate(): Promise<string | null> {
  // Use stored affected row IDs from standardization
  const rowIds = this.affectedRowIds || []
  if (rowIds.length === 0) return null
  return `"_cs_id" IN (${rowIds.map(id => `'${id}'`).join(', ')})`
}
```

**4.5 Fix `edit:batch` highlighting** (`src/lib/commands/edit/batch.ts`)
```typescript
async getAffectedRowsPredicate(): Promise<string | null> {
  const changes = this.params.changes || []
  if (changes.length === 0) return null
  const csIds = [...new Set(changes.map(c => c.csId))]
  return `"_cs_id" IN (${csIds.map(id => `'${id}'`).join(', ')})`
}
```

**4.6 Hide highlight button for full-table ops** (`src/components/layout/AuditSidebar.tsx`)

Add check before showing highlight button:
```typescript
const shouldShowHighlight = (entry: AuditLogEntry) => {
  const cmd = findTimelineCommand(entry.auditEntryId)
  if (!cmd) return false
  // Skip full-table operations
  const skipTypes = ['stack', 'join', 'remove_duplicates', 'filter_empty', 'rename_column']
  const cmdType = cmd.params?.transformationType || cmd.params?.type
  return !skipTypes.includes(cmdType)
}
```

## Out of Scope (Summaries Only - No Drill-Down)

These transforms show in audit log with summary but no drill-down (modifications not applicable):
- **Remove Duplicates** - Deletes rows
- **Filter Empty Rows** - Deletes rows
- **Combine: Stack/Join** - Creates new table
- **Rename Column** - Metadata change only

## Drill-Down Scope (Modifications Only)

Per user requirements, drill-down is ONLY for modifications (cell value changes):
- Tier 1 transforms (trim, lowercase, etc.) - Shows before/after values
- Tier 3 transforms that modify data (pad_zeros, cast_type, etc.)
- Manual/batch edits
- Standardization value mappings
