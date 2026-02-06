# Plan: Redesign TableSelector Dropdown

## Context

The table selector dropdown in the header is too cramped. Table names like `fuzzy_duplicate_claims_dataset` get truncated to `fuzzy_duplicate_clai...` because the trigger caps the name at 140px and the dropdown panel is only 280px wide. There's also no visual indicator for the active table.

## Changes (single file: `src/components/common/TableSelector.tsx`)

### 1. Widen the trigger button
- **Current**: `min-w-[200px]`, name truncated at `max-w-[140px]`
- **New**: `min-w-[240px] max-w-[320px]`, name truncated at `max-w-[240px]`
- Add native `title` attribute on the name span so hovering shows the full name

### 2. Widen the dropdown panel
- **Current**: `w-[280px]`
- **New**: `w-[380px]` — fits ~36 characters before truncation, enough for most table names

### 3. Add active table indicator
- Check mark icon (opacity toggle) + subtle `bg-accent/50` highlight on the active row
- Follows existing pattern from `table-combobox.tsx`

### 4. Add ScrollArea for long table lists
- Wrap the table list in `<ScrollArea className="max-h-[320px]">` (fits ~6-7 items before scrolling)
- Prevents dropdown from overflowing viewport when many tables are loaded

### 5. New imports needed
- `Check` from `lucide-react`
- `cn` from `@/lib/utils` (already imports `formatNumber` from there)
- `ScrollArea` from `@/components/ui/scroll-area`

## What stays the same
- DropdownMenu (not switching to Popover — preserves keyboard nav, ARIA roles, existing test selectors)
- All existing functionality: table switching, frozen/checkpoint tables, delete flow, context switching
- No changes to AppHeader, shared UI primitives, or any other files

## Verification
1. `npm run dev` — visually confirm dropdown with a long table name
2. Run relevant E2E tests:
   ```bash
   npx playwright test "table-delete-persistence.spec.ts" "column-ordering.spec.ts" --timeout=90000 --retries=0 --reporter=line
   ```
3. Verify the Check icon doesn't break delete button targeting in tests (it's an SVG, not a button, so `getByRole('button')` queries should be unaffected)
