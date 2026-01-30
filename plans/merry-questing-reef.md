# Plan: Implement Key Map Functionality for Scrub Panel

## Problem

The "Generate Key Map" checkbox is dead code - nothing populates the key map. The scrub commands run SQL expressions that transform data in-place without capturing original→obfuscated mappings.

## Design Decisions

- **Format:** Combined CSV with column identifier (`column,original,obfuscated`)
- **Scope:** All unique values for complete reversibility
- **UX:** Download button appears when checkbox enabled + rules configured; must download before Apply

## Implementation

### 1. Update Store Data Structure

Change `scrubberStore.ts`:
```typescript
// Current (broken)
keyMap: Map<string, string>

// New
keyMap: Map<string, KeyMapEntry[]>  // key = column name, value = array of mappings

interface KeyMapEntry {
  original: string
  obfuscated: string
}
```

### 2. Add Key Map Generation Function

Add to `ScrubPanel.tsx`:
```typescript
const generateKeyMap = async () => {
  // For each rule, query DISTINCT original values and compute obfuscated
  // SELECT DISTINCT "column" AS original, <expression> AS obfuscated FROM table
  // Store in keyMap grouped by column
}
```

### 3. Update UI Layout

```
┌─────────────────────────────────┐
│ ☑ Generate Key Map  [ⓘ]        │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ ⬇ Download Key Map          │ │  ← NEW: Primary action when checked
│ └─────────────────────────────┘ │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ ▶ Apply Scrub Rules         │ │  ← Disabled until key map downloaded
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

- Download button appears when `keyMapEnabled && rules.length > 0`
- "Apply Scrub Rules" is disabled if `keyMapEnabled && !keyMapDownloaded`
- After download, a checkmark shows "Key map downloaded" and Apply enables

### 4. Export Format

```csv
column,original,obfuscated
email,john@test.com,a8f5e2b1c9d3...
email,jane@test.com,c3d4e5f6a7b8...
phone,555-123-4567,5*****7
phone,555-987-6543,5*****3
```

### 5. Wire to Scrub Commands

In `handleApply()`:
- If `keyMapEnabled`, generate key map before applying transforms
- If already generated/downloaded, skip regeneration

## Files to Modify

| File | Changes |
|------|---------|
| `src/stores/scrubberStore.ts` | New data structure, add `keyMapDownloaded` flag |
| `src/components/panels/ScrubPanel.tsx` | Download button, generation logic, conditional Apply |

## Verification

1. Enable "Generate Key Map" checkbox
2. Add 2+ columns with different scrub methods
3. Click "Download Key Map" → CSV downloads with correct format
4. "Apply Scrub Rules" button becomes enabled
5. Apply rules → data is scrubbed
6. Verify CSV contains all unique values with correct obfuscation
