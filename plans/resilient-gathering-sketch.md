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

**2. Hide "Clear highlights" header button** (lines 317-331):
- Wrap with `{ENABLE_AUDIT_HIGHLIGHT && highlightedCommandId && ...}`

**3. Hide "View details" text link** (lines 485-490):
- Wrap with `{ENABLE_AUDIT_HIGHLIGHT && entry.hasRowDetails && ...}`
- Note: Clicking the entry still opens the detail modal (line 429)

**4. Hide "Highlight" button** (lines 491-510):
- Wrap with `{ENABLE_AUDIT_HIGHLIGHT && shouldShowHighlight(entry) && ...}`

**5. Conditional highlight clear on close** (line 374):
- Only call `clearHighlight()` when `ENABLE_AUDIT_HIGHLIGHT` is true

**6. Suppress unused import warning** (line 2):
- Add ESLint disable comment for `Eye` and `Crosshair` imports

## Explicitly Preserved (No Changes)

| Element | Lines | Description |
|---------|-------|-------------|
| **Recipe eligibility indicator** | 462-473 | Emerald BookOpen icon showing "Can be added to recipe" |
| **Transform info (entry.details)** | 449-451 | Details text showing transformation parameters |
| **Action name** | 441 | Transform name (e.g., "Trim whitespace") |
| **Type badge** | 456-461 | "Transform" or "Edit" badge |
| **Rows affected** | 475-478 | Row count display |
| **Timestamp** | 480-482 | Relative time (e.g., "5m ago") |
| **Undone badge** | 443-447 | Shows on undone entries |
| **Current State separator** | 410-417 | Visual divider for undo position |
| **Detail Modal** | 521-526 | Opens when clicking entry |
| **Export as Recipe button** | 332-353 | Header button with count |
| **Export audit log button** | 354-368 | Download button in header |

## What Gets Hidden

| Element | Lines | Reason |
|---------|-------|--------|
| "Clear highlights" button | 317-331 | No highlight feature → no clear button |
| "View details" link | 485-490 | Redundant - clicking entry opens modal |
| "Highlight" button | 491-510 | Main feature being hidden |

## Verification

1. Open audit sidebar - no Highlight buttons or "View details" links visible
2. Click an entry - detail modal still opens
3. Verify transformation info displays correctly (action name, details text)
4. Verify recipe eligibility indicator (emerald BookOpen) shows on compatible entries
5. Export as Recipe - still works
6. Verify rows affected and timestamps display correctly
