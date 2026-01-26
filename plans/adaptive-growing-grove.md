# Plan: Prevent Parameter Preservation Bugs in Dual-Timeline Architecture

## Problem Statement

The recent Tier 3 undo parameter preservation bug (commit `ae9f1b7`) exposed a systemic issue: the codebase has **22 commands with custom parameters** that are vulnerable to silent data corruption during undo/replay operations.

**Root Cause:**
- Dual-timeline architecture: Command Pattern (new) uses flat params, Timeline Store (legacy) requires nested params
- Bridge function in `executor.ts` must extract custom params and nest them correctly
- Missing documentation and tests allowed the bug to reach production

**Impact:**
- Silent data corruption (e.g., `pad_zeros` with `length=9` reverts to default `length=5` after unrelated undo)
- No compile-time or runtime detection
- Only 1 of 22 vulnerable commands has parameter preservation test

## Vulnerable Commands (22 Total)

### High Risk - Tier 3 Operations (8 commands)
1. **`split_column`** - Complex params: `splitMode`, `delimiter`/`position`/`length`
2. **`combine_columns`** - Multi-param: `columns[]`, `delimiter`, `newColumnName`, `ignoreEmpty`
3. **`pad_zeros`** - ✅ Bug fixed & tested, needs docs
4. **`standardize_date`** - `format` string critical for correctness
5. **`cast_type`** - `targetType` (wrong type causes data loss)
6. **`match:merge`** - `pairs` array (affects which rows deleted)
7. **`standardize:apply`** - `mappings` array (standardization rules)
8. **`scrub:redact`** - `replacement` text

### Medium Risk - Tier 1 with Complex Params (4 commands)
9. **`replace`** - 4 params: `find`, `replace`, `caseSensitive`, `matchType`
10. **`mask`** - 2 params: `preserveFirst`, `preserveLast`
11. **`replace_empty`** - `replaceWith` value
12. **`hash`** - `secret` (hash differs if lost)

### Lower Risk (10 commands)
- Tier 2 edits and combines (already tested)
- Tier 3 simple transforms with minimal params

## Solution: 4-Layered Defense Strategy

### Layer 1: Documentation (Week 1)
**Prevent bugs through clear guidance**

### Layer 2: Runtime Validation (Week 1-2)
**Catch bugs during development**

### Layer 3: Comprehensive Testing (Week 2-4)
**Verify all 22 commands work correctly**

### Layer 4: Automation (Week 5)
**Prevent regressions through CI/CD**

---

## Implementation Plan

### Phase 1: Foundation & Documentation (Week 1)

#### 1.1 Core Documentation Updates

**File: `/CLAUDE.md`**

Add Section 5.6 "Dual-Timeline Parameter Contract":
```markdown
### 5.6 Dual-Timeline Parameter Contract [CRITICAL]

Command Pattern (new) uses flat params: { tableId, column, length: 9 }
Timeline Store (legacy) expects nested: { type, column, params: { length: 9 } }

Bridge function (executor.ts:1200):
const { tableId, column, ...customParams } = command.params
params: customParams  // ← NESTED! Critical for replay

If incorrect: Command executes correctly, but undo uses DEFAULT values.
Result: Silent data corruption.
```

Add Section 5.7 "New Command Checklist":
- [ ] Define params interface extending `BaseTransformParams`
- [ ] Extract custom params in `syncExecuteToTimelineStore`
- [ ] Add Tier 3 parameter preservation test
- [ ] Use non-default param values in test
- [ ] Assert exact values (identity), not counts

Enhance Section 5.8 "Code Review Checklist":
- [ ] Are custom params extracted: `const { tableId, column, ...customParams } = command.params`?
- [ ] Are they nested: `params: customParams`?
- [ ] Does test verify exact values after undo?

**File: `/e2e/CLAUDE.md`**

Add Section 9 "Parameter Preservation Testing":
```markdown
## 9. Parameter Preservation Testing

Pattern:
1. Execute command with NON-DEFAULT params
2. Verify execution (assert exact values)
3. Execute DIFFERENT Tier 3 command
4. Undo unrelated command
5. Verify original params preserved (NOT defaults)

Example:
test('split column params persist after cast undo', async () => {
  await picker.addTransformation('Split Column', {
    params: { delimiter: '|' }  // NOT default ','
  })
  expect(data[0].first).toBe('John')  // Split on '|'

  await picker.addTransformation('Cast Type', ...)
  await laundromat.clickUndo()  // Undo cast, NOT split

  expect(data[0].first).toBe('John')  // Still '|', not ','!
})
```

#### 1.2 Inline Code Documentation

**File: `src/lib/commands/executor.ts`**

Add JSDoc to `syncExecuteToTimelineStore` (line 1155):
```typescript
/**
 * Sync command execution to legacy timelineStore for UI integration.
 *
 * CRITICAL: Parameter Nesting Contract
 * =====================================
 * Command Pattern: { tableId, column, length: 9 }
 * Timeline Store: { type, column, params: { length: 9 } }
 *
 * This function bridges them by extracting custom params and nesting.
 * Missing/incorrect nesting causes silent data corruption on undo.
 *
 * EXAMPLE:
 * Command: { tableId: 'abc', column: 'account', length: 9 }
 * Timeline: { type: 'transform', column: 'account', params: { length: 9 } }
 *
 * @see tier-3-undo-param-preservation.spec.ts for testing pattern
 */
```

Add inline comment at parameter extraction (line 1200):
```typescript
// CRITICAL: Extract custom params (exclude tableId/column) and nest
// Command: { tableId, column, length: 9 } → Timeline: { params: { length: 9 } }
const { tableId: _tableId, column: _column, ...customParams } = command.params
```

**File: `src/lib/timeline-engine.ts`**

Add JSDoc to `applyTransformCommand` (line 342):
```typescript
/**
 * Apply transformation during timeline replay.
 *
 * Receives NESTED params from Timeline Store:
 *   { type: 'transform', transformationType: 'pad_zeros', params: { length: 9 } }
 *
 * Extracts params.params for legacy applyTransformation.
 * If params.params is empty, transformation uses defaults → data corruption!
 */
```

**File: `src/types/index.ts`**

Enhance `TransformParams` interface (line 264):
```typescript
export interface TransformParams {
  type: 'transform'
  transformationType: TransformationType
  column?: string
  /**
   * Custom parameters (NESTED).
   *
   * Examples:
   * - pad_zeros: { length: 9 }
   * - split_column: { delimiter: ',', newColumnNames: ['a', 'b'] }
   *
   * DO NOT store tableId or column here.
   * DO store all command-specific params.
   *
   * @see executor.ts:syncExecuteToTimelineStore for nesting logic
   * @see timeline-engine.ts:applyTransformCommand for consumption
   */
  params?: Record<string, unknown>
}
```

#### 1.3 Architectural Decision Records

**File: `/docs/adr/001-dual-timeline-architecture.md` (NEW)**

```markdown
# ADR-001: Dual-Timeline Architecture

## Status
Accepted (Legacy - Under Migration)

## Context
Two undo systems: Command Pattern (new/flat) + Timeline Store (legacy/nested)

## Decision
Maintain both during migration via bridge function in executor.ts

## Consequences
- Incremental migration possible
- Parameter nesting contract error-prone
- Requires careful documentation and testing

## Migration Path
Q1: Stabilization + docs
Q2: Command Pattern completion
Q3: Timeline unification
Q4: Legacy cleanup
```

**File: `/docs/adr/002-parameter-nesting-requirement.md` (NEW)**

```markdown
# ADR-002: Parameter Nesting Requirement

## Decision
All custom params MUST be nested when syncing to Timeline Store:
```typescript
const { tableId, column, ...customParams } = command.params
params: customParams  // Nested under params property
```

## Enforcement
1. Code review checklist
2. Required Tier 3 undo test for commands with params
3. JSDoc on bridge function
4. Runtime validation (dev mode)
```

---

### Phase 2: Runtime Validation (Week 1-2)

#### 2.1 Parameter Extraction Utilities

**File: `src/lib/commands/utils/param-extraction.ts` (NEW)**

```typescript
/**
 * Type-safe extraction of custom params from command params.
 * Ensures timeline sync doesn't drop parameters.
 */
export function extractCustomParams<T extends Record<string, unknown>>(
  params: T
): Omit<T, 'tableId' | 'column'> {
  const { tableId, column, ...custom } = params
  return custom as Omit<T, 'tableId' | 'column'>
}

/**
 * Validate timeline params match command params structure.
 * Throws in dev mode if params missing.
 */
export function validateParamStructure<T extends Record<string, unknown>>(
  commandParams: T,
  timelineParams: { params?: Record<string, unknown> }
): void {
  const customKeys = Object.keys(commandParams).filter(
    k => k !== 'tableId' && k !== 'column'
  )

  for (const key of customKeys) {
    if (!(key in (timelineParams.params || {}))) {
      const error = `Timeline param missing: ${key}`
      console.error('[PARAM VALIDATION ERROR]', {
        missing: key,
        expected: commandParams,
        actual: timelineParams.params
      })

      // Throw in dev mode to catch bugs early
      if (import.meta.env.DEV) {
        throw new Error(error)
      }
    }
  }
}
```

#### 2.2 Integrate Validation into Executor

**File: `src/lib/commands/executor.ts`**

After line 1209, add validation:
```typescript
const customParams = extractCustomParams(command.params as Record<string, unknown>)

timelineParams = {
  type: legacyCommandType === 'transform' ? 'transform' : legacyCommandType,
  transformationType: command.type.replace('transform:', ''),
  column,
  params: customParams,
}

// Validate params were extracted correctly (dev mode only)
validateParamStructure(command.params as Record<string, unknown>, timelineParams)
```

#### 2.3 Unit Tests for Validation

**File: `src/lib/commands/__tests__/executor-param-sync.test.ts` (NEW)**

```typescript
import { extractCustomParams, validateParamStructure } from '../utils/param-extraction'

describe('Executor Parameter Sync', () => {
  it('extracts custom params for pad_zeros', () => {
    const params = { tableId: 'abc', column: 'account', length: 9 }
    const custom = extractCustomParams(params)

    expect(custom).toEqual({ length: 9 })
    expect(custom).not.toHaveProperty('tableId')
  })

  it('validates timeline params have all custom params', () => {
    const commandParams = { tableId: 'abc', column: 'account', length: 9 }
    const timelineParams = { params: { length: 9 } }

    // Should not throw
    expect(() =>
      validateParamStructure(commandParams, timelineParams)
    ).not.toThrow()
  })

  it('throws in dev mode if params missing', () => {
    const commandParams = { tableId: 'abc', column: 'account', length: 9 }
    const timelineParams = { params: {} }  // Missing length!

    // Mock dev environment
    vi.stubEnv('DEV', true)

    expect(() =>
      validateParamStructure(commandParams, timelineParams)
    ).toThrow('Timeline param missing: length')
  })
})
```

---

### Phase 3: Comprehensive E2E Testing (Week 2-4)

#### 3.1 Reusable Test Helpers

**File: `e2e/helpers/param-preservation-helpers.ts` (NEW)**

```typescript
import type { StoreInspector } from './store-inspector'
import type { TransformationPickerPage } from '../page-objects/transformation-picker.page'
import type { LaundromatPage } from '../page-objects/laundromat.page'

/**
 * Standard pattern: Apply command → Unrelated Tier 3 op → Undo → Verify params preserved
 */
export async function applyAndTriggerReplay(
  picker: TransformationPickerPage,
  laundromat: LaundromatPage,
  targetTransform: {
    name: string
    column: string
    params?: Record<string, unknown>
    selectParams?: Record<string, string>
  }
) {
  // Apply target transformation
  await picker.addTransformation(targetTransform.name, {
    column: targetTransform.column,
    params: targetTransform.params,
    selectParams: targetTransform.selectParams
  })

  // Apply unrelated Tier 3 operation (triggers snapshot)
  await picker.addTransformation('Rename Column', {
    column: 'id',
    params: { 'New column name': 'id_renamed' }
  })

  // Undo to trigger replay
  await laundromat.closePanel()
  await laundromat.clickUndo()
}

/**
 * 3-layer validation: SQL + Timeline + Grid
 */
export async function validateParamPreservation(
  inspector: StoreInspector,
  tableId: string,
  commandIndex: number,
  expectedParams: Record<string, unknown>,
  sqlAssertion: () => Promise<void>
) {
  // Layer 1: SQL validation (most reliable)
  await sqlAssertion()

  // Layer 2: Timeline params
  const timeline = await inspector.getTimeline(tableId)
  const cmd = timeline.commands[commandIndex]

  for (const [key, value] of Object.entries(expectedParams)) {
    expect(cmd.params.params?.[key]).toBe(value)
  }

  // Layer 3: Grid dataVersion updated
  const tableState = await inspector.getTableState(tableId)
  expect(tableState.dataVersion).toBeGreaterThan(commandIndex)
}
```

#### 3.2 Test Fixtures

**File: `e2e/fixtures/csv/param-preservation-base.csv` (NEW)**

```csv
id,text,number,date,email
1,hello world,123,2024-01-01,john@example.com
2,test data,456,2024-02-15,jane@example.com
3,sample text,789,2024-03-30,bob@example.com
```

This 3-row fixture enables deterministic identity assertions.

#### 3.3 Priority 1 Tests (High-Risk Tier 3)

**File: `e2e/tests/tier-3-undo-param-preservation.spec.ts`**

Expand existing file with 7 new tests:

```typescript
test('split column params (delimiter mode) persist after unrelated undo', async () => {
  await loadTestData('param-preservation-base.csv')

  // Apply split with custom delimiter (NOT default ',')
  await picker.addTransformation('Split Column', {
    column: 'text',
    params: { splitMode: 'delimiter', delimiter: ' ' }
  })

  // Verify split used ' ' delimiter
  const data = await inspector.runQuery('SELECT * FROM test_table ORDER BY id')
  expect(data[0].text_1).toBe('hello')
  expect(data[0].text_2).toBe('world')

  // Trigger replay
  await applyAndTriggerReplay(picker, laundromat, { ... })

  // CRITICAL: Verify still using ' ' delimiter (not default ',')
  const dataAfterUndo = await inspector.runQuery('SELECT * FROM test_table ORDER BY id')
  expect(dataAfterUndo[0].text_1).toBe('hello')
  expect(dataAfterUndo[0].text_2).toBe('world')
})

test('combine columns params persist after unrelated undo', async () => {
  // Test delimiter='|', newColumnName='combined', ignoreEmpty=false
  // Verify exact values after replay
})

test('standardize date format params persist after unrelated undo', async () => {
  // Test format='MM/DD/YYYY' (NOT default 'YYYY-MM-DD')
  // Verify dates formatted correctly after replay
})

test('cast type params persist after unrelated undo', async () => {
  // Test targetType='DOUBLE' (NOT default 'VARCHAR')
  // Verify numeric values after replay
})

test('match merge pairs params persist after unrelated undo', async () => {
  // Test pairs array with specific row IDs
  // Verify correct rows merged after replay
})

test('standardize apply mappings params persist after unrelated undo', async () => {
  // Test custom mappings array
  // Verify standardization rules applied after replay
})

test('scrub redact replacement params persist after unrelated undo', async () => {
  // Test replacement='***' (NOT default '[REDACTED]')
  // Verify custom replacement used after replay
})
```

Each test follows the pattern:
1. Load test data
2. Apply command with NON-DEFAULT params
3. Verify execution (assert exact values)
4. Apply unrelated Tier 3 operation
5. Undo unrelated operation
6. Verify original params preserved (assert exact values again)

#### 3.4 Priority 2 Tests (Tier 1 Complex Params)

Add 4 tests for `replace`, `mask`, `replace_empty`, `hash` following same pattern.

---

### Phase 4: Automation & CI/CD (Week 5)

#### 4.1 Pre-Commit Hooks

**File: `.husky/pre-commit`**

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

echo "Running parameter preservation tests..."
npm run test:param-preservation

if [ $? -ne 0 ]; then
  echo "❌ Parameter preservation tests failed!"
  echo "Fix bugs before committing."
  exit 1
fi
```

**File: `package.json`**

Add script:
```json
{
  "scripts": {
    "test:param-preservation": "playwright test --grep='param.*preserved|Tier 3.*parameter preservation'"
  }
}
```

#### 4.2 CI Pipeline

**File: `.github/workflows/ci.yml`**

Add job:
```yaml
jobs:
  param-preservation-tests:
    name: Parameter Preservation Tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test:param-preservation

  param-unit-tests:
    name: Param Extraction Unit Tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run test -- executor-param-sync.test.ts
```

---

## Verification Strategy

### Unit Tests
```bash
npm run test -- executor-param-sync.test.ts
```
Expected: All param extraction tests pass

### E2E Tests
```bash
npm run test:param-preservation
```
Expected: All 12 parameter preservation tests pass (1 existing + 11 new)

### Manual Verification

For each high-risk command:
1. Apply transformation with custom params
2. Check data reflects custom params
3. Apply unrelated Tier 3 operation
4. Undo unrelated operation
5. Verify data still reflects custom params (NOT defaults)

### Regression Check
```bash
npm run test
```
Expected: All existing tests still pass (no regressions)

---

## Critical Files

### Documentation (Phase 1)
- `/CLAUDE.md` - Sections 5.6, 5.7, 5.8
- `/e2e/CLAUDE.md` - Section 9
- `/docs/adr/001-dual-timeline-architecture.md` (NEW)
- `/docs/adr/002-parameter-nesting-requirement.md` (NEW)
- `src/lib/commands/executor.ts:1155` - JSDoc
- `src/lib/timeline-engine.ts:342` - JSDoc
- `src/types/index.ts:264` - Interface docs

### Runtime Validation (Phase 2)
- `src/lib/commands/utils/param-extraction.ts` (NEW)
- `src/lib/commands/executor.ts:1209` - Add validation call
- `src/lib/commands/__tests__/executor-param-sync.test.ts` (NEW)

### E2E Testing (Phase 3)
- `e2e/helpers/param-preservation-helpers.ts` (NEW)
- `e2e/fixtures/csv/param-preservation-base.csv` (NEW)
- `e2e/tests/tier-3-undo-param-preservation.spec.ts` - Expand

### Automation (Phase 4)
- `.husky/pre-commit` - Add test gate
- `package.json` - Add test script
- `.github/workflows/ci.yml` - Add CI jobs

---

## Success Criteria

✅ **Documentation Complete**
- CLAUDE.md has parameter contract section
- All critical functions have JSDoc
- ADRs document architectural decisions

✅ **Validation Working**
- Runtime validation catches missing params in dev mode
- Unit tests verify param extraction logic
- No false positives

✅ **Test Coverage Complete**
- All 8 high-risk commands have parameter preservation tests
- All tests follow 3-layer validation pattern
- Tests use non-default param values

✅ **Automation Deployed**
- Pre-commit hooks block bad commits
- CI pipeline catches regressions
- Test suite runs in <15 minutes

✅ **Zero Regressions**
- All existing tests still pass
- No performance degradation
- Undo/redo still works for all commands

---

## Timeline

- **Week 1:** Documentation + Runtime Validation (Phase 1-2)
- **Week 2:** High-risk E2E tests (split, combine, standardize, cast)
- **Week 3:** High-risk E2E tests (merge, apply, redact) + Tier 1 tests
- **Week 4:** Test polish + edge cases
- **Week 5:** Automation + CI/CD integration

**Total Duration:** 5 weeks

**Effort:** ~40 hours
- Documentation: 8 hours
- Runtime validation: 6 hours
- E2E tests (12 tests): 20 hours
- Automation: 4 hours
- Review & polish: 2 hours

---

## Risk Mitigation

**Risk:** Tests become brittle and flaky
**Mitigation:** Use `expect.poll()`, query actual IDs, avoid hardcoded values

**Risk:** Runtime validation has false positives
**Mitigation:** Only validate structure (key presence), not values. Dev mode only.

**Risk:** Pre-commit hooks slow down workflow
**Mitigation:** Run only param preservation tests (~30s), not full suite

**Risk:** Missing edge cases in E2E tests
**Mitigation:** Test with non-default values, verify exact identity, 3-layer validation

**Risk:** Documentation becomes stale
**Mitigation:** Link docs to code (JSDoc), version ADRs, review quarterly
