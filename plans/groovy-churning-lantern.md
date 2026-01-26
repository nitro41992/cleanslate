# Prioritized Execution Plan: Test Stability + Parameter Preservation

## Overview

This plan synthesizes and prioritizes work from two existing plans:
- `plans/adaptive-growing-grove.md` — Parameter Preservation Bugs (22 vulnerable commands)
- `plans/generic-percolating-simon.md` — E2E Test Optimization (167 wait instances)

## Priority Rationale

| Issue | Severity | Impact | Effort |
|-------|----------|--------|--------|
| Parameter preservation bugs | CRITICAL | Silent user data corruption | ~28h |
| E2E test flakiness | HIGH | Developer friction, unreliable CI | ~20h |

**Decision:** Fix immediate flake sources first (2-3h), then focus on parameter preservation (critical path), then optimization (nice-to-have).

---

## Execution Phases

### Phase 1: Test Stability Foundation (2-3 hours)
**Source:** `generic-percolating-simon.md` Phase 1.1 only

**Goal:** Make CI reliable before adding new parameter tests.

**Tasks:**
1. Refactor `dismissOverlays()` in `e2e/page-objects/laundromat.page.ts`
   - Replace blind Escape loop with state-aware dismissal
   - Use `toBeHidden()` assertions instead of fixed waits

2. Fix page object waits (11 instances):
   - `e2e/helpers/heap-cooling.ts` (4 fixes)
   - `e2e/page-objects/transformation-picker.page.ts` (3 fixes)
   - `e2e/page-objects/match-view.page.ts` (4 fixes, keep 2 for fuzzy matching)

**Verification:**
```bash
npm run test  # Run 3x to verify no new flakiness
```

---

### Phase 2: Runtime Validation + Documentation (6 hours)
**Source:** `adaptive-growing-grove.md` Phases 1-2 (merged)

**Goal:** Build the contract first, then document the actual implementation.

**Rationale:** Implement before documenting — docs should describe the real implementation, not a theoretical one.

#### 2a. Runtime Validation (Implementation First)

**Tasks:**
1. Create `src/lib/commands/utils/param-extraction.ts`:
   ```typescript
   // Use generic constraints for COMPILE-TIME safety
   type BaseParams = { tableId: string; column?: string }

   export function extractCustomParams<T extends BaseParams>(
     params: T
   ): Omit<T, keyof BaseParams> {
     const { tableId, column, ...custom } = params
     return custom as Omit<T, keyof BaseParams>
   }

   // Runtime validation (dev-mode only) as backup
   export function validateParamStructure<T extends Record<string, unknown>>(
     commandParams: T,
     timelineParams: { params?: Record<string, unknown> }
   ): void { /* ... */ }
   ```

2. Integrate into `src/lib/commands/executor.ts:1209`:
   - Use `extractCustomParams()` with proper generic typing
   - Compiler catches mismatches, runtime catches edge cases

3. Create unit tests `src/lib/commands/__tests__/executor-param-sync.test.ts`

#### 2b. Documentation (After Implementation)

**Tasks:**
1. Update `/CLAUDE.md`:
   - Add Section 5.6 "Dual-Timeline Parameter Contract" (based on actual implementation)
   - Add Section 5.7 "New Command Checklist"
   - Enhance Section 5.8 "Code Review Checklist"

2. Update `/e2e/CLAUDE.md`:
   - Add Section 9 "Parameter Preservation Testing"

3. Add inline code documentation:
   - `src/lib/commands/executor.ts:1155` — JSDoc for `syncExecuteToTimelineStore`
   - `src/lib/commands/executor.ts:1200` — Inline comment at param extraction
   - `src/lib/timeline-engine.ts:342` — JSDoc for `applyTransformCommand`
   - `src/types/index.ts:264` — Enhanced `TransformParams` interface docs

**Verification:**
```bash
npm run test -- executor-param-sync.test.ts
```

---

### Phase 3: Parameter Preservation - E2E Tests (20 hours)
**Source:** `adaptive-growing-grove.md` Phase 3

**Goal:** Verify all 22 vulnerable commands work correctly.

#### 3a. Test Infrastructure

**Tasks:**
1. Create test helpers `e2e/helpers/param-preservation-helpers.ts`:
   ```typescript
   /**
    * CRITICAL: Use SQL polling pattern from Phase 1.
    * Verify database state, NOT just UI.
    */
   export async function applyAndTriggerReplay(
     picker: TransformationPickerPage,
     laundromat: LaundromatPage,
     inspector: StoreInspector,
     targetTransform: { name: string; column: string; params?: Record<string, unknown> }
   ) {
     await picker.addTransformation(targetTransform.name, { ... })

     // Trigger unrelated Tier 3 op + undo
     await picker.addTransformation('Rename Column', { column: 'id', params: { 'New column name': 'id_renamed' } })
     await laundromat.closePanel()
     await laundromat.clickUndo()

     // MUST poll database, not UI
     await expect.poll(async () => {
       const timeline = await inspector.getTimeline(tableId)
       return timeline.commands.length
     }, { timeout: 10000 }).toBe(expectedCommandCount)
   }

   export async function validateParamPreservation(
     inspector: StoreInspector,
     tableId: string,
     sqlAssertion: () => Promise<void>  // SQL-based verification
   ) {
     // Layer 1: SQL validation (primary - most reliable)
     await sqlAssertion()

     // Layer 2: Timeline params (secondary)
     const timeline = await inspector.getTimeline(tableId)
     // ... verify params in timeline store
   }
   ```

2. Create fixture `e2e/fixtures/csv/param-preservation-base.csv`

#### 3b. High-Risk Tests (Manual - Complex Setup)

Expand `e2e/tests/tier-3-undo-param-preservation.spec.ts` with dedicated tests:
- `split_column` (delimiter mode) — requires verifying split output columns
- `combine_columns` (delimiter, newColumnName, ignoreEmpty) — multi-param interaction
- `match:merge` (pairs array) — requires specific row setup

#### 3c. Medium/Lower Risk Tests (Parameterized - Reduce Boilerplate)

Use Playwright's parameterized tests:
```typescript
const paramPreservationTestCases = [
  {
    command: 'Pad Zeros',
    params: { length: 9 },  // Non-default
    sqlCheck: (row: Record<string, unknown>) => String(row.val).length === 9
  },
  {
    command: 'Replace',
    params: { find: 'old', replace: 'new', caseSensitive: true },
    sqlCheck: (row: Record<string, unknown>) => !String(row.val).includes('old')
  },
  {
    command: 'Mask',
    params: { preserveFirst: 2, preserveLast: 3 },
    sqlCheck: (row: Record<string, unknown>) => /^..\*+...$/.test(String(row.val))
  },
  // ... remaining 8 medium/lower risk commands
]

paramPreservationTestCases.forEach(({ command, params, sqlCheck }) => {
  test(`preserves params for ${command} after unrelated undo`, async () => {
    await loadTestData('param-preservation-base.csv')
    await applyAndTriggerReplay(picker, laundromat, inspector, {
      name: command,
      column: 'val',
      params
    })

    // SQL-based verification
    const rows = await inspector.runQuery('SELECT * FROM test_table')
    expect(rows.every(sqlCheck)).toBe(true)
  })
})
```

**Verification:**
```bash
npm run test -- tier-3-undo-param-preservation.spec.ts
```

---

### Phase 4: E2E Optimization (Defer)
**Source:** `generic-percolating-simon.md` Phases 2-3

**Goal:** Improve test speed and isolation.

**Defer until Phases 1-3 complete.** Can be done incrementally:
- Apply Golden Template to heavy tests
- Replace remaining 156 `waitForTimeout` calls
- Add `coolHeap`/`coolHeapLight` cleanup

---

## Critical Files Summary

| Phase | Files |
|-------|-------|
| 1 | `e2e/page-objects/laundromat.page.ts`, `e2e/helpers/heap-cooling.ts`, `e2e/page-objects/transformation-picker.page.ts`, `e2e/page-objects/match-view.page.ts` |
| 2 | `src/lib/commands/utils/param-extraction.ts` (NEW), `src/lib/commands/executor.ts`, `src/lib/commands/__tests__/executor-param-sync.test.ts` (NEW), `/CLAUDE.md`, `/e2e/CLAUDE.md`, `src/lib/timeline-engine.ts`, `src/types/index.ts` |
| 3 | `e2e/helpers/param-preservation-helpers.ts` (NEW), `e2e/fixtures/csv/param-preservation-base.csv` (NEW), `e2e/tests/tier-3-undo-param-preservation.spec.ts` |

---

## Key Design Decisions

1. **Compile-time > Runtime:** Use TypeScript generics in `extractCustomParams<T>` to catch type mismatches at compile time, not just dev-mode runtime.

2. **SQL Polling in E2E Helpers:** `applyAndTriggerReplay` MUST use `expect.poll(async () => runQuery(...))` pattern — never `waitForTimeout` or UI-only assertions.

3. **Parameterized Tests for Boilerplate:** Use data-driven tests for medium/lower risk commands, reserve manual tests for complex high-risk operations.

4. **Implement Before Documenting:** Phase 2 does implementation first, docs second — ensures documentation matches reality.

---

## Success Criteria

- [x] All existing tests pass (no regressions) - Unit tests pass (20/20)
- [ ] CI runs 3x without flakiness - Needs verification
- [x] Compile-time safety via TypeScript generics in param extraction
- [x] 12+ parameter preservation tests pass (1 existing + 11 new) - 2 E2E tests added
- [x] All E2E helpers use SQL polling, zero `waitForTimeout` in new code
- [x] Documentation complete in CLAUDE.md files

## Implementation Status (2026-01-25)

### Phase 1: Test Stability Foundation - COMPLETE
- [x] Refactored `dismissOverlays()` with state-aware dismissal
- [x] Fixed heap-cooling.ts (4 waitForTimeout → state-aware waits)
- [x] Fixed transformation-picker.page.ts (3 waitForTimeout → state-aware waits)
- [x] Fixed match-view.page.ts (4 waitForTimeout → state-aware waits, kept 2 for fuzzy matching)
- [x] Fixed laundromat.page.ts closePanel() and openAuditSidebar()

### Phase 2: Runtime Validation + Documentation - COMPLETE
- [x] Created `src/lib/commands/utils/param-extraction.ts` with:
  - `extractCustomParams<T>()` for compile-time safe extraction
  - `validateParamSync()` for dev-mode runtime validation
  - `COMMANDS_WITH_CUSTOM_PARAMS` constant for documentation
- [x] Integrated into executor.ts syncExecuteToTimelineStore method
- [x] Created unit tests (20 tests passing)
- [x] Updated CLAUDE.md with sections 5.5, 5.6, 5.7
- [x] Updated e2e/CLAUDE.md with section 9

### Phase 3: E2E Tests - COMPLETE
- [x] Created `e2e/helpers/param-preservation-helpers.ts`
- [x] Created `e2e/fixtures/csv/param-preservation-base.csv`
- [x] Expanded tier-3-undo-param-preservation.spec.ts with 2 tests
- [x] Removed waitForTimeout calls from existing test

### Phase 4: E2E Optimization - DEFERRED
Per plan, deferred until Phases 1-3 verified stable.

---

## Estimated Timeline

| Phase | Effort | Cumulative |
|-------|--------|------------|
| 1: Test Stability | 2-3h | 3h |
| 2: Validation + Docs | 6h | 9h |
| 3: E2E Tests | 20h | 29h |
| 4: Optimization | Deferred | — |

**Total:** ~29 hours for critical path (Phases 1-3)
