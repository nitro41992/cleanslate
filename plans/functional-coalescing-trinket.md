# Plan: Update CLAUDE.md with Command Pattern Architecture

## Objective

Update CLAUDE.md to document the current Command Pattern paradigm shift that replaced the legacy transformation/undo system.

## Changes to Make

### File: `CLAUDE.md`

**Location:** Add new section after "Key Patterns" (around line 77), before "TypeScript Configuration"

### Content to Add

#### 1. Command Pattern Architecture Section

```markdown
### Command Pattern Architecture

CleanSlate Pro uses a unified Command Pattern for all data operations:

**Core Concepts:**
- **Declarative commands** via typed `Command<TParams>` interface
- **Automatic audit logging** with row-level drill-down
- **Three-tier undo strategy** (Tier 1: instant, Tier 2: inverse SQL, Tier 3: snapshot)
- **Diff views** for highlighting affected rows in the grid

**Directory Structure:**
```
src/lib/commands/
├── index.ts              # Public API + command registration
├── executor.ts           # CommandExecutor singleton (8-step lifecycle)
├── registry.ts           # Factory pattern, tier classification
├── types.ts              # Core types (Command, CommandContext, etc.)
├── context.ts            # Context builder, column version state
├── column-versions.ts    # Tier 1 expression chaining manager
├── diff-views.ts         # Diff view creation (v_diff_step_X)
├── transform/            # 22 transform commands (tier1/, tier2/, tier3/)
├── edit/                 # EditCellCommand (Tier 2)
├── match/                # MatchMergeCommand (Tier 3)
├── combine/              # Stack/Join commands (Tier 2)
├── standardize/          # StandardizeApplyCommand (Tier 3)
├── scrub/                # Hash/Mask/Redact/YearOnly (Tier 1-3)
└── utils/                # SQL helpers, date parsing
```

**Three-Tier Undo Strategy:**
| Tier | Mechanism | Speed | Commands |
|------|-----------|-------|----------|
| **1** | Expression chaining | Instant | trim, lowercase, uppercase, replace, hash, mask (12 total) |
| **2** | Inverse SQL | Fast | rename_column, edit:cell, combine:stack/join (5 total) |
| **3** | Snapshot restore | Slower | remove_duplicates, cast_type, split_column, standardize:apply, match:merge (15 total) |

**Usage Pattern:**
```typescript
import { createCommand, getCommandExecutor } from '@/lib/commands'

const command = createCommand('transform:trim', { tableId, column: 'email' })
const result = await getCommandExecutor().execute(command)

// Undo/Redo
if (executor.canUndo(tableId)) await executor.undo(tableId)
if (executor.canRedo(tableId)) await executor.redo(tableId)
```

**Key Files:**
- `executor.ts` - Central orchestrator (validate → snapshot → execute → diff → audit → timeline)
- `column-versions.ts` - Tier 1 expression chaining with `__base` backup columns
- `registry.ts` - Maps command types to tier classification
```

#### 2. Update Data Flow Section

Update the existing Data Flow diagram (around line 63) to reflect command pattern:

```markdown
### Data Flow
```
File Upload → DuckDB-WASM → tableStore → DataGrid
                  ↓
            CommandExecutor
            (validate → execute → audit → timeline)
                  ↓
            auditStore → Export CSV
```
```

#### 3. Add Phase 6 Optimizations Note

In the "Key Patterns" section or new subsection:

```markdown
**Performance Optimizations (Phase 6):**
- Snapshot pruning: Max 5 Tier 3 snapshots per table (LRU eviction)
- Column materialization: After 10 Tier 1 transforms, materialize expression stack
- `__base` columns filtered from UI/export via `filterInternalColumns()`
```

## Files to Modify

| File | Change |
|------|--------|
| `CLAUDE.md` | Add Command Pattern Architecture section (~60 lines) |

## Verification

1. Read updated CLAUDE.md to verify formatting
2. Run `npm run lint` to ensure no issues
3. Verify the documentation accurately reflects the codebase

## Implementation Order

1. Read current CLAUDE.md to find exact insertion point
2. Add Command Pattern Architecture section after "Key Patterns"
3. Update Data Flow diagram
4. Verify formatting and accuracy
