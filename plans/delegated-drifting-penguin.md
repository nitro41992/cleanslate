# Panel Redesign Plan: Match Clean Panel Style

## Status: ✅ COMPLETED (2026-01-30)

All phases implemented successfully. Build passes with no TypeScript errors.

### Completed Items
- [x] **Phase 1: Infrastructure**
  - [x] Created `TableCombobox.tsx` with searchable table selection, `excludeIds` support, row counts
  - [x] Updated `FeaturePanel.tsx` width logic for Combine/Scrub panels (880px)

- [x] **Phase 2: Panel Restructures**
  - [x] Redesigned `CombinePanel.tsx` - Two-column layout, searchable selectors, mode-specific empty states, validation clearing on tab switch, table reordering
  - [x] Redesigned `ScrubPanel.tsx` - Two-column master-detail layout, auto-select on add, method examples/hints

- [x] **Phase 3: Config Panel Enhancements**
  - [x] Enhanced `StandardizeConfigPanel.tsx` - Searchable selectors, algorithm info cards with examples, blue bullet hints
  - [x] Enhanced `MatchConfigPanel.tsx` - Searchable selectors, header card, dynamic strategy info with examples, colored left border

### Files Changed
| File | Change Type |
|------|-------------|
| `src/components/ui/table-combobox.tsx` | **Created** |
| `src/components/layout/FeaturePanel.tsx` | Modified |
| `src/components/panels/CombinePanel.tsx` | **Major rewrite** |
| `src/components/panels/ScrubPanel.tsx` | **Major rewrite** |
| `src/features/standardizer/components/StandardizeConfigPanel.tsx` | Modified |
| `src/features/matcher/components/MatchConfigPanel.tsx` | Modified |

---

## Objective
Redesign 4 panels (Combine, Scrub, Standardize, Match) to match the Clean Panel's design language and UX patterns.

## Key Constraints

### 1. Use shadcn Components Everywhere
- **MUST** use existing shadcn/ui components from `src/components/ui/`
- Do NOT create custom styled elements when shadcn equivalents exist
- Components to use: Button, Select, Input, Label, Card, Badge, Separator, ScrollArea, Tabs, RadioGroup, Checkbox, Alert, Dialog, Popover, Command

### 2. Column Dropdowns MUST Be Searchable
- **ALWAYS** use `ColumnCombobox` (`src/components/ui/combobox.tsx`) for column selection
- This provides searchable dropdown with fuzzy matching
- Replaces any `<Select>` used for column selection

### 3. Table Dropdowns Should Also Be Searchable
- Create a new `TableCombobox` component (similar to ColumnCombobox)
- Use Command/Popover pattern for searchable table selection
- Shows table name + row count in dropdown

## Reference Design: CleanPanel.tsx
The Clean Panel (880px side panel) establishes these design patterns:

**Layout:**
- Two-column: Left (340px) for picker/selection, Right for configuration
- `border-r border-border/50` column divider
- `ScrollArea` on left column only

**Visual Grouping:**
- Info cards: `bg-muted/30 rounded-lg p-3 space-y-3`
- Section dividers: `border-t border-border/50 pt-2`
- Example styling: `text-xs font-mono` with `text-red-400/80 → text-green-400/80`
- Hints: Blue bullet `text-blue-400 •` with `text-xs text-muted-foreground`

**Animation & States:**
- Config panel: `animate-in fade-in duration-200`
- Empty state: Centered icon in `w-12 h-12 rounded-full bg-muted/50`

---

## Files to Modify

### 0. TableCombobox.tsx (New Component)
**Path:** `src/components/ui/table-combobox.tsx`

**Purpose:** Searchable table selector (matching ColumnCombobox pattern)

```tsx
interface TableComboboxProps {
  tables: Array<{ id: string; name: string; rowCount: number }>
  value: string | null
  onValueChange: (id: string, name: string) => void
  placeholder?: string
  disabled?: boolean
  excludeIds?: string[] // For filtering out already-selected tables
  autoFocus?: boolean
}

export function TableCombobox({ tables, excludeIds = [], autoFocus, ...props }: TableComboboxProps) {
  const filteredTables = tables.filter(t => !excludeIds.includes(t.id))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between truncate">
          {/* Truncate long table names with ellipsis */}
          <span className="truncate">{selectedTable?.name || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder="Search tables..." autoFocus={autoFocus} />
          <CommandList>
            <CommandEmpty>No table found.</CommandEmpty>
            <CommandGroup>
              {filteredTables.map((table) => (
                <CommandItem key={table.id} value={table.name} onSelect={() => onValueChange(table.id, table.name)}>
                  <Check className={cn('mr-2 h-4 w-4', value === table.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1 truncate">{table.name}</span>
                  {/* Row count on the right in muted style */}
                  <span className="text-xs text-muted-foreground ml-2">
                    {table.rowCount.toLocaleString()} rows
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
```

**Key implementation details:**
- `excludeIds` prop filters out already-selected tables (for Stack/Join modes)
- Row count displayed on right side in muted font (like `CommandShortcut` pattern)
- `truncate` class on table name to handle long names gracefully
- `autoFocus` passed to `CommandInput` so users can type immediately

---

### 1. FeaturePanel.tsx (Infrastructure)
**Path:** `src/components/layout/FeaturePanel.tsx`

**Change:** Expand Combine and Scrub panels to 880px width.

```tsx
// Line 56: Change width logic
// FROM:
className={`${activePanel === 'clean' ? 'w-[880px]...' : 'w-[400px]...'}`}

// TO:
className={`${['clean', 'combine', 'scrub'].includes(activePanel || '') ? 'w-[880px] sm:max-w-[880px]' : 'w-[400px] sm:max-w-[400px]'} p-0 flex flex-col`}
```

**Transition handling:** The SheetContent already has `transition-all` via shadcn.
Ensure width changes smoothly by keeping the transition duration consistent.
If direct panel switching occurs (unlikely but possible), the width should animate smoothly.

---

### 2. CombinePanel.tsx (Major Restructure)
**Path:** `src/components/panels/CombinePanel.tsx`

**Current:** Single scrolling column (400px) with Tabs
**New:** Two-column layout (880px)

**Left Column (340px):**
- Mode tabs (Stack/Join) at top using shadcn `Tabs`
- Table selection using `TableCombobox` (searchable, with `excludeIds` for already-selected)
- Selected tables list with `Badge` components and remove buttons
- **Stack mode:** Allow reordering of selected tables (drag-drop or up/down buttons) since order affects result

**Right Column:**
- Info card explaining selected mode (using `bg-muted/30 rounded-lg p-3`):
  - Stack: "Combine rows vertically (UNION ALL)"
    - Example: `Table A (100 rows) + Table B (50 rows) → 150 rows`
  - Join: "Combine tables horizontally on a key column"
    - Example: `orders.customer_id = customers.id`
- Configuration fields:
  - Key column using `ColumnCombobox` (searchable)
  - Join type using shadcn `RadioGroup`
  - Result name using shadcn `Input`
- Validation status with success styling
- Full-width action buttons

**State Management:**
- **IMPORTANT:** Switching between Stack/Join tabs MUST clear validation state
- If user validates Stack, switches to Join, the success banner should disappear
- Keep `stackTableIds` and join state (`leftTableId`, `rightTableId`) separate

**Empty states (right column) - Mode-specific:**
```tsx
// Stack mode empty state:
<PanelEmptyState
  icon={<Layers className="w-6 h-6 text-muted-foreground" />}
  title="Stack Tables"
  description="Select at least 2 tables to stack"
/>

// Join mode empty state:
<PanelEmptyState
  icon={<Link2 className="w-6 h-6 text-muted-foreground" />}
  title="Join Tables"
  description="Select Left and Right tables to configure join"
/>
```

---

### 3. ScrubPanel.tsx (Major Restructure)
**Path:** `src/components/panels/ScrubPanel.tsx`

**Current:** Single scrolling column (400px)
**New:** Two-column layout (880px)

**Left Column (340px) - "Rule Queue":**
- Table selector using `TableCombobox` (searchable)
- Secret input using shadcn `Input` with warning text
- "Add Column" using `ColumnCombobox` to add columns to the rule queue
- Added columns shown as list items with:
  - Column name
  - `Badge` showing assigned method (or "Not configured")
  - Remove button (X)
- Key map checkbox using shadcn `Checkbox`

**Right Column - "Rule Editor":**
- Info card using shadcn pattern (`bg-muted/30 rounded-lg p-3`)
- Method selector using shadcn `Select`
- Method-specific config using shadcn `Input` (e.g., preserve chars for Mask)
- Examples in mono font:
  - Hash: `john@email.com → a8f5e2b1...`
  - Mask: `555-123-4567 → ***-***-4567`
  - Redact: `John Smith → [REDACTED]`
- Hints with blue bullets
- Preview + Apply buttons

**Interaction Model (Master-Detail Pattern):**
- **Auto-select on add:** When user adds a column via ColumnCombobox, automatically select it and populate the Right Column for immediate configuration (no double-click required)
- **Draft vs Committed:** Unlike CleanPanel (immediate apply), ScrubPanel builds a "recipe":
  - Left Column shows "Rules to be applied" (Draft state)
  - Right Column is the "Editor" for the selected rule
  - Bottom "Apply All Rules" button commits all at once
- **Visual distinction:** Draft rules should have subtle styling (e.g., `opacity-80`) until applied

**Empty state (right column):**
```tsx
<PanelEmptyState
  icon={<Shield className="w-6 h-6 text-muted-foreground" />}
  title="Configure Obfuscation"
  description="Select a column from the left to configure its scrub method"
/>
```

---

### 4. StandardizeView.tsx (Styling Enhancement)
**Path:** `src/features/standardizer/StandardizeView.tsx`
**Also:** `src/features/standardizer/components/StandardizeConfigPanel.tsx`

**Keep:** Full-screen overlay layout

**Enhance StandardizeConfigPanel:**

1. Replace table `Select` with `TableCombobox` (searchable)
2. Replace column `Select` with `ColumnCombobox` (searchable)
3. Wrap form sections in info cards:
```tsx
<div className="bg-muted/30 rounded-lg p-3 space-y-3">
  <Label>Clustering Algorithm</Label>
  <Select>...</Select>  {/* Keep Select for algorithm - not a column */}

  {/* Algorithm explanation based on selection */}
  <div className="border-t border-border/50 pt-2">
    <p className="text-xs font-medium text-muted-foreground mb-1.5">Examples</p>
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className="text-red-400/80">JOHN SMITH</span>
        <span className="text-muted-foreground">→</span>
        <span className="text-green-400/80">john smith</span>
      </div>
    </div>
  </div>
</div>
```

2. Add algorithm-specific examples:
   - Fingerprint: `"John  Smith" → "john smith"` (normalization)
   - Metaphone: `"Smith" / "Smyth"` (sounds alike)
   - Token Phonetic: `"John Smith" / "Smith, John"` (name reordering)

3. Convert "How it works" section to hints with blue bullets

---

### 5. MatchView.tsx (Styling Enhancement)
**Path:** `src/features/matcher/MatchView.tsx`
**Also:** `src/features/matcher/components/MatchConfigPanel.tsx`

**Keep:** Full-screen overlay layout

**Enhance MatchConfigPanel:**

1. Replace table `Select` with `TableCombobox` (searchable)
2. Replace match column `Select` with `ColumnCombobox` (searchable)
3. Add header card:
```tsx
<div className="bg-muted/30 rounded-lg p-3">
  <h2 className="font-medium">Find Duplicates</h2>
  <p className="text-sm text-muted-foreground mt-1">
    Detect and merge duplicate records based on similarity
  </p>
</div>
```

4. **Dynamic strategy info cards** - Update description based on selected strategy:
```tsx
const strategyInfo: Record<BlockingStrategy, { title: string; description: string; examples: Array<{ before: string; after: string }>; badge?: string }> = {
  first_letter: {
    title: 'First Letter (Fastest)',
    description: 'High precision, lower recall. Only compares records starting with same letter.',
    examples: [{ before: 'Smith', after: 'Smythe' }],
  },
  double_metaphone: {
    title: 'Phonetic - Double Metaphone',
    description: 'Matches records that sound similar. Best for name variations.',
    examples: [{ before: 'Smith', after: 'Smyth' }, { before: 'John', after: 'Jon' }],
    badge: 'Recommended',
  },
  ngram: {
    title: 'Character Similarity (N-Gram)',
    description: 'Matches records sharing character sequences. Best for typos.',
    examples: [{ before: 'Jhon', after: 'John' }],
  },
  none: {
    title: 'Compare All (Slowest)',
    description: 'Compares every record pair. Use for small datasets under 1,000 rows.',
    examples: [],
    badge: 'May be slow',
  },
}
```

5. Render examples in strategy cards:
```tsx
{info.examples.length > 0 && (
  <div className="mt-2 pt-2 border-t border-border/50">
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className="text-muted-foreground">e.g.</span>
      <span className="text-red-400/80">{info.examples[0].before}</span>
      <span className="text-muted-foreground">↔</span>
      <span className="text-green-400/80">{info.examples[0].after}</span>
    </div>
  </div>
)}
```

6. Add colored left border to selected strategy:
```tsx
className={`... ${strategy === blockingStrategy ? 'border-l-2 border-l-primary' : ''}`}
```

---

## Implementation Order

**Phase 1: Infrastructure**
1. **TableCombobox.tsx** - Create new searchable table selector component
2. **FeaturePanel.tsx** - Update width logic (smooth transition handling for panel switches)

**Phase 2: Panel Restructures (Easier First)**
3. **CombinePanel.tsx** - Full restructure to two-column layout
   - This is the "easiest" of the complex panels - clear separation between Stack/Join modes
   - Validate state clearing on mode switch

4. **ScrubPanel.tsx** - Full restructure to two-column layout
   - Harder due to Master-Detail state management (selected column, draft rules)
   - Test auto-select behavior thoroughly

**Phase 3: Config Panel Enhancements (Isolated Changes)**
5. **StandardizeConfigPanel.tsx** - Add searchable selectors + styling enhancement
6. **MatchConfigPanel.tsx** - Add searchable selectors + dynamic strategy info

---

## Testing Plan

**Manual Testing:**
1. Open each panel and verify two-column layout renders correctly
2. Test all workflows (Stack, Join, Scrub methods, Standardize, Match)
3. Verify keyboard navigation works in new layouts
4. Check empty states display correctly

**Existing E2E Tests:**
```bash
# Run after each panel change to catch regressions
npx playwright test "combine" --timeout=60000 --retries=0 --reporter=line
npx playwright test "scrubber" --timeout=60000 --retries=0 --reporter=line
npx playwright test "standardize" --timeout=60000 --retries=0 --reporter=line
npx playwright test "matcher" --timeout=60000 --retries=0 --reporter=line
```

**Visual Verification:**
- Compare panel layouts side-by-side with Clean panel
- Verify info card styling matches exactly
- Check animation timing feels consistent

---

## Design Tokens Reference

| Element | Tailwind Classes |
|---------|------------------|
| Info card | `bg-muted/30 rounded-lg p-3 space-y-3` |
| Section divider | `border-t border-border/50 pt-2` |
| Column divider | `border-r border-border/50` |
| Example before | `text-xs font-mono text-red-400/80` |
| Example after | `text-xs font-mono text-green-400/80` |
| Example arrow | `text-muted-foreground` + `→` |
| Hint bullet | `text-blue-400` + `•` |
| Hint text | `text-xs text-muted-foreground` |
| Empty state icon | `w-12 h-12 rounded-full bg-muted/50` |
| Config animation | `animate-in fade-in duration-200` |
| Active border | `border-l-2 border-l-primary` |

---

## shadcn Components to Use

| Use Case | Component | Location |
|----------|-----------|----------|
| Table selection | `TableCombobox` (new) | `src/components/ui/table-combobox.tsx` |
| Column selection | `ColumnCombobox` | `src/components/ui/combobox.tsx` |
| Multi-column select | `MultiColumnCombobox` | `src/components/ui/multi-column-combobox.tsx` |
| Mode tabs | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `src/components/ui/tabs.tsx` |
| Radio options | `RadioGroup`, `RadioGroupItem` | `src/components/ui/radio-group.tsx` |
| Text input | `Input` | `src/components/ui/input.tsx` |
| Labels | `Label` | `src/components/ui/label.tsx` |
| Buttons | `Button` | `src/components/ui/button.tsx` |
| Status badges | `Badge` | `src/components/ui/badge.tsx` |
| Checkboxes | `Checkbox` | `src/components/ui/checkbox.tsx` |
| Scrollable areas | `ScrollArea` | `src/components/ui/scroll-area.tsx` |
| Dividers | `Separator` | `src/components/ui/separator.tsx` |
| Alerts | `Alert`, `AlertDescription` | `src/components/ui/alert.tsx` |
| Progress | `Progress` | `src/components/ui/progress.tsx` |
