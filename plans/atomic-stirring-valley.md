# Transformation Picker UX: Master-Detail Split View

## Problem Statement

After clicking a transformation, users don't realize they need to scroll down to see parameter fields. The 400px side panel creates a "hidden below the fold" problem.

## Solution

Widen the panel to 640px and use a two-column master-detail layout where picker (left) and config (right) are always visible simultaneously.

```
┌────────────────────────────────────────────────────────┐
│ Transform Data                                    [X]  │
├──────────────────────┬─────────────────────────────────┤
│ 📝 Text Cleanup      │                                 │
│ ├─ ✂️ Trim          │  ✂️ Trim Whitespace             │
│ ├─ [a] Lowercase    │  ─────────────────────────       │
│ └─ [A] Uppercase    │  Remove leading/trailing spaces │
│                      │                                 │
│ 🔢 Numeric          │  Column: [email ▼]              │
│ ├─ 00 Pad Zeros     │                                 │
│ └─ 📊 Round         │  ┌──────────────────────────┐   │
│                      │  │ ✨ Apply Transformation  │   │
│ ...                  │  └──────────────────────────┘   │
└──────────────────────┴─────────────────────────────────┘
     280px (scrollable)       360px (fixed)
```

## Files to Modify

1. `src/components/layout/FeaturePanel.tsx`
2. `src/components/panels/CleanPanel.tsx`

---

## Implementation

### Step 1: Widen FeaturePanel for Clean Panel

In `src/components/layout/FeaturePanel.tsx`, make the panel width conditional based on which panel is open. The Clean panel needs 640px, others keep 400px.

```tsx
// Current:
className="w-[400px] sm:max-w-[400px]"

// Change to conditional width based on activePanel:
className={cn(
  activePanel === 'clean' ? 'w-[640px] sm:max-w-[640px]' : 'w-[400px] sm:max-w-[400px]'
)}
```

### Step 2: Refactor CleanPanel to Two-Column Layout

In `src/components/panels/CleanPanel.tsx`, restructure the layout from vertical stack to horizontal split.

**Current structure:**
```tsx
<ScrollArea>
  <div className="p-4 space-y-4">
    <GroupedTransformationPicker ... />

    {selectedTransform && (
      <div>
        {/* Transform Info */}
        {/* Column Selector */}
        {/* Parameters */}
        {/* Apply Button */}
      </div>
    )}
  </div>
</ScrollArea>
```

**New structure:**
```tsx
<div className="flex h-full">
  {/* Left Column: Picker (scrollable) */}
  <div className="w-[280px] border-r border-border/50 flex flex-col">
    <ScrollArea className="flex-1">
      <div className="p-4">
        <GroupedTransformationPicker ... />
      </div>
    </ScrollArea>
  </div>

  {/* Right Column: Configuration (scrollable if needed) */}
  <div className="flex-1 flex flex-col">
    <ScrollArea className="flex-1">
      <div className="p-4 space-y-4">
        {selectedTransform ? (
          <>
            {/* Transform Info */}
            {/* Column Selector */}
            {/* Parameters */}
            {/* Apply Button */}
          </>
        ) : (
          <EmptyState />
        )}
      </div>
    </ScrollArea>
  </div>
</div>
```

### Step 3: Add Empty State for Right Column

When no transform is selected, show a helpful empty state in the right column:

```tsx
// New component or inline JSX in CleanPanel
<div className="flex flex-col items-center justify-center h-full text-center p-6">
  <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
    <Sparkles className="w-6 h-6 text-muted-foreground" />
  </div>
  <p className="text-sm text-muted-foreground">
    Select a transformation from the left to configure it
  </p>
</div>
```

### Step 4: Extract Configuration Form (Optional Cleanup)

For cleaner code, extract the configuration section into a separate component:

```tsx
// src/components/clean/TransformConfigForm.tsx
interface TransformConfigFormProps {
  transform: TransformationDefinition
  columns: string[]
  selectedColumn: string | null
  params: Record<string, string>
  onColumnChange: (column: string) => void
  onParamChange: (name: string, value: string) => void
  onApply: () => void
  onCancel: () => void
  isApplying: boolean
  executionProgress: { percent: number } | null
}

export function TransformConfigForm({ ... }: TransformConfigFormProps) {
  // Move all the config JSX here
}
```

---

## Visual Polish

### Column Widths
- Left (picker): 280px - enough for the redesigned list items
- Right (config): 360px (flex-1) - enough for form inputs

### Borders & Separation
- Vertical divider: `border-r border-border/50` on left column
- Each column has independent scrolling

### Animations
- Keep existing `animate-in slide-in-from-top-2` for transform info section
- Consider `animate-in fade-in` for the empty state

---

## Verification

1. Run `npm run dev`, open the Clean panel
2. Verify panel is 640px wide (vs old 400px)
3. Verify two-column layout: picker on left, empty state on right
4. Click a transform: verify config appears instantly in right column
5. Scroll the picker (left column): verify right column stays fixed
6. Test transforms with many params (custom_sql, split_column)
7. Apply a transform: verify the flow works end-to-end
8. Verify other panels (Match, Combine, Scrub) still use 400px width

---

# Phase 2: UX Refinements

## Problems to Address

1. **Config form not vertically centered** - When a transform is selected, the form starts at the top instead of being centered in the available space
2. **Dropdown jitter on open** - The Select component jitters/shifts when opened
3. **No column search** - Tables with many columns require scrolling through the entire list

---

## Fix 1: Vertically Center Config Form

**File:** `src/components/panels/CleanPanel.tsx`

**Current structure (lines 307-312):**
```tsx
<div className="flex-1 flex flex-col">
  <ScrollArea className="flex-1">
    <div className="p-4 space-y-4">
      {selectedTransform ? (
        <div className="space-y-4 animate-in fade-in duration-200">
```

**New structure:** Remove ScrollArea wrapper and use flex centering directly. The config form is short enough that scrolling is rarely needed:

```tsx
<div className="flex-1 flex flex-col overflow-y-auto">
  <div className="flex-1 flex flex-col justify-center p-4">
    {selectedTransform ? (
      <div className="space-y-4 animate-in fade-in duration-200">
```

This centers the form vertically while allowing overflow scroll if content exceeds height.

---

## Fix 2: Dropdown Jitter

**File:** `src/components/ui/select.tsx`

**Root cause:** The `SelectContent` component lacks `sideOffset` prop, causing the dropdown to touch the trigger and recalculate position on open.

**Current (line 72):**
```tsx
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
```

**Fix:** Add `sideOffset = 4` to destructuring and pass it to Content:

```tsx
>(({ className, children, position = 'popper', sideOffset = 4, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
```

---

## Fix 3: Searchable Column Selector (Combobox)

**Approach:** Use shadcn's [Combobox pattern](https://ui.shadcn.com/docs/components/combobox) - a composition of `<Popover />` + `<Command />` (cmdk). This is the 2025 best practice for searchable selects in React.

**Dependencies to add:**
```bash
npm install cmdk
```

**New file:** `src/components/ui/combobox.tsx`

Create a reusable `ColumnCombobox` component:

```tsx
import * as React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface ColumnComboboxProps {
  columns: string[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

export function ColumnCombobox({
  columns,
  value,
  onValueChange,
  placeholder = 'Select column...',
  disabled = false,
}: ColumnComboboxProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
          data-testid="column-selector"
        >
          {value || placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder="Search columns..." />
          <CommandList>
            <CommandEmpty>No column found.</CommandEmpty>
            <CommandGroup>
              {columns.map((col) => (
                <CommandItem
                  key={col}
                  value={col}
                  onSelect={() => {
                    onValueChange(col)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === col ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {col}
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

**Check if Command component exists:** Need to verify `src/components/ui/command.tsx` exists, or add it via shadcn CLI.

**Update CleanPanel.tsx:** Replace the column `<Select>` with `<ColumnCombobox>`:

```tsx
// Before:
<Select value={selectedColumn} onValueChange={setSelectedColumn}>
  <SelectTrigger data-testid="column-selector">
    <SelectValue placeholder="Select column..." />
  </SelectTrigger>
  <SelectContent>
    {columns.map((col) => (
      <SelectItem key={col} value={col}>{col}</SelectItem>
    ))}
  </SelectContent>
</Select>

// After:
<ColumnCombobox
  columns={columns}
  value={selectedColumn}
  onValueChange={setSelectedColumn}
  disabled={isApplying}
/>
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/panels/CleanPanel.tsx` | Vertical centering + replace Select with ColumnCombobox |
| `src/components/ui/select.tsx` | Add `sideOffset={4}` to fix jitter |
| `src/components/ui/combobox.tsx` | **New file** - ColumnCombobox component |
| `src/components/ui/command.tsx` | **New file** (if missing) - shadcn Command component |
| `package.json` | Add `cmdk` dependency |

---

## Verification (Phase 2)

1. **Vertical centering:** Open Clean panel, select a simple transform (Trim) - form should be vertically centered
2. **No jitter:** Open any dropdown in the app - no layout shift on open
3. **Column search:** Select a transform, click column dropdown, type to filter columns
4. **Keyboard nav:** Use arrow keys and Enter in the combobox
5. **Empty state:** Type a non-existent column name - shows "No column found."

---

## Sources

- [shadcn/ui Combobox](https://ui.shadcn.com/docs/components/combobox) - Official pattern using Popover + Command
- [Radix Select docs](https://www.radix-ui.com/primitives/docs/components/select) - sideOffset prop
- [cmdk](https://cmdk.paco.me/) - Command palette library used by shadcn
