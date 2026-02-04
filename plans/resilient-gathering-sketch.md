# Plan: Simplify Audit Sidebar by Hiding Highlight/Drill-Down Features

## Overview

Hide the audit log's highlight and drill-down UI elements since this functionality is available via the Diff feature. The underlying logic is preserved for potential re-enablement.

## Changes

### File: `src/components/layout/AuditSidebar.tsx`

**1. Add feature flag constant** (after imports, ~line 33):
```typescript
/**
 * Feature flag: Audit entry highlight functionality
 *
 * Disabled because:
 * 1. The Diff feature provides similar functionality with more detail
 * 2. Reduces UI complexity in the audit sidebar
 *
 * To re-enable: Set to `true`
 */
const ENABLE_AUDIT_HIGHLIGHT = false
```

**2. Hide "Clear highlights" header button** (lines 315-328):
- Wrap with `{ENABLE_AUDIT_HIGHLIGHT && highlightedCommandId && ...}`

**3. Hide "View details" text link** (lines 483-488):
- Wrap with `{ENABLE_AUDIT_HIGHLIGHT && entry.hasRowDetails && ...}`
- Clicking the entry still opens the detail modal

**4. Hide "Highlight" button** (lines 489-508):
- Wrap with `{ENABLE_AUDIT_HIGHLIGHT && shouldShowHighlight(entry) && ...}`

**5. Conditional highlight clear on close** (line 371-374):
- Only call `clearHighlight()` when `ENABLE_AUDIT_HIGHLIGHT` is true

**6. Suppress unused import warning** (line 2):
- Add ESLint disable comment for `Eye` and `Crosshair` imports

## What Remains Visible

- Entry count badge
- Timeline position indicator (e.g., "5/10")
- Export as Recipe button
- Export audit log button
- Recipe eligibility indicator (emerald BookOpen icon)
- Entry list with: action name, type badge, rows affected, timestamp
- "Undone" badge and "Current State" separator
- Detail Modal (clicking entry still opens it)

## Verification

1. Open audit sidebar - no Highlight buttons or "View details" links visible
2. Click an entry - detail modal still opens
3. Export as Recipe - still works (uses `findTimelineCommand`)
4. Recipe eligibility indicator - still shows on compatible entries
