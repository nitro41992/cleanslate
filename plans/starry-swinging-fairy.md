# Keyboard-First Transform Workflow

## Goal
Add keyboard-driven navigation to the Clean tab transformations, mirroring the filter workflow from the last commit.

## User Flow
```
Press 1 → Clean panel opens (existing shortcut)
Start typing → Transform search filters list
  ↓ (arrow keys to navigate, Enter to select)
Step 1: Select Transform
  ↓ Enter
Step 2: Select Column (if requiresColumn)
  ↓ Enter
Step 3+: Fill Parameters (if any)
  ↓ Enter
Apply Transform

Backspace (when input is empty) → Go back one step
Escape → Clear search / close command
```

## Files to Create/Modify

### New File: `src/components/clean/TransformCommand.tsx`
- Multi-step dialog mirroring `FilterCommand.tsx` pattern
- Uses `cmdk` (Command component) for search/keyboard nav
- Steps:
  1. **Transform Selection**: Search across all transforms, grouped by category (emerald=Text, blue=Replace, etc.)
  2. **Column Selection**: Uses existing column data, grouped by type
  3. **Parameters**: One step per required param (or inline if simple)
- Breadcrumb navigation showing current state
- Direction-aware slide animations
- Keyboard hints at bottom

### Modify: `src/components/panels/CleanPanel.tsx`
- Replace `GroupedTransformationPicker` with `TransformCommand` as primary UI
- Left column becomes the command interface (search + selection)
- Right column remains configuration form (shows after transform selected)
- Auto-focus search input when panel opens
- Wire `onApply` to execute transformation

## Implementation Details

### Step Types
```typescript
type Step = 'transform' | 'column' | `param-${string}` | 'apply'
```

### Transform Groups (reuse existing)
```typescript
// From transformations.ts - TRANSFORMATION_GROUPS
// emerald: Text Cleaning (trim, lowercase, etc.)
// blue: Find & Replace
// violet: Structure (rename, remove_duplicates, etc.)
// amber: Numeric
// rose: Dates
// slate: Advanced (custom_sql)
```

### Navigation Logic
```typescript
const goToNextStep = () => {
  if (step === 'transform') {
    if (selectedTransform.requiresColumn) {
      setStep('column')
    } else if (selectedTransform.params?.length) {
      setStep(`param-${selectedTransform.params[0].name}`)
    } else {
      handleApply()
    }
  } else if (step === 'column') {
    if (selectedTransform.params?.length) {
      setStep(`param-${selectedTransform.params[0].name}`)
    } else {
      handleApply()
    }
  } else if (step.startsWith('param-')) {
    const currentIndex = selectedTransform.params.findIndex(p => step === `param-${p.name}`)
    if (currentIndex < selectedTransform.params.length - 1) {
      setStep(`param-${selectedTransform.params[currentIndex + 1].name}`)
    } else {
      handleApply()
    }
  }
}

const goBack = () => {
  // Reverse the above logic
}
```

### Initial State
When Clean panel opens (via "1" shortcut or click), the transform search input should be auto-focused, ready for typing.

```typescript
// TransformCommand auto-focuses search input on mount
useEffect(() => {
  if (open) {
    commandInputRef.current?.focus()
  }
}, [open])
```

### Parameter Input Types
- `select`: Use CommandList with options
- `text`/`number`: Use Input with Enter to advance, Backspace to go back when empty

## Verification
1. Open app with a table loaded
2. Press `1` → Clean panel opens, search input is focused
3. Type "trim" → list filters to show Trim Whitespace
4. Press Enter → moves to Column Selection (Step 2)
5. Type column name → filters columns
6. Press Enter → applies transform (no params for trim)
7. Press Backspace before entering column → goes back to transform search
8. Test transform with params (e.g., "Pad Zeros"):
   - Select Pad Zeros → Column → Length param → Enter applies
   - Backspace at each step goes back

## Edge Cases
- Transforms without column requirement (remove_duplicates, custom_sql) skip column step
- Transforms without params (trim, lowercase) go directly to apply after column
- `split_column` has conditional params based on `splitMode` - show only relevant ones
- Cast type should still show warning dialog when needed (wire through existing flow)
