# UI Fixes Plan - CleanSlate Pro

## Issues Identified

### 1. Duplicate "Add file" Buttons
**Problem**: Two "Add file" buttons visible simultaneously:
- `AppHeader.tsx:91-106` - Button in header toolbar next to table selector
- `App.tsx:259-267` - Button inside the Card header for data preview

**Fix**: Remove the one in `App.tsx` Card header (lines 259-267). The header already provides file upload access.

---

### 2. Audit Log Padding/Cutoff Issues
**Problem**: Audit sidebar content appears cramped and may be cut off.

**Root cause in `AuditSidebar.tsx`**:
- Fixed width `w-72` (288px) may be too narrow
- Text uses `.truncate` which cuts off long content
- No horizontal padding on ScrollArea content wrapper

**Fix**:
- Increase sidebar width from `w-72` to `w-80` (320px)
- Add `px-1` or `px-2` inside ScrollArea for breathing room
- Consider making action/details text wrap instead of truncate

---

### 3. "Persist as Table" Not Implemented ⚠️ CRITICAL
**Problem**: The "Persist as Table" button shows a success toast but **does NOT actually create a new table**.

**Location**: `App.tsx:181-204` - `handleConfirmPersist` is a stub:
```tsx
// In a real implementation, this would:
// 1. Execute all pending operations
// 2. Create a new table with the result
// 3. Clear pending operations
// For now, we just show success  <-- THIS IS THE PROBLEM
```

**Fix**: Implement actual table creation using DuckDB:
1. Run `CREATE TABLE {newName} AS SELECT * FROM {currentTable}`
2. Add new table to `tableStore`
3. Clear pending operations in `previewStore`
4. Add audit log entry
5. Switch to new table as active

---

### 4. shadcn/ui and Automatic Padding
**Clarification**: shadcn/ui does NOT automatically handle all padding:
- **What shadcn provides**: Component internal padding (Card content areas, Dialog padding, Button padding)
- **What you still need**: Container margins, page padding, gap between components

**This is expected behavior** - shadcn is a component library, not a layout system. You still need Tailwind for:
- `p-4` on content areas
- `gap-*` between flex/grid items
- `mx-auto` for centering
- `space-y-*` for vertical spacing

---

## Files to Modify

| File | Change |
|------|--------|
| `src/App.tsx` | Remove duplicate button (lines 259-267), implement `handleConfirmPersist` |
| `src/components/layout/AuditSidebar.tsx` | Increase width, improve padding, fix truncation |
| `src/hooks/useDuckDB.ts` | Add `duplicateTable(sourceName, newName)` function |

---

## Implementation Details

### Fix 1: Remove duplicate button in App.tsx
Delete the "Add file" button from CardTitle (lines 259-267).

### Fix 2: AuditSidebar improvements
```tsx
// Change width from w-72 to w-80
<aside className="w-80 border-l border-border/50 bg-card/30 flex flex-col shrink-0">

// Allow text to wrap instead of truncate
<p className="text-sm font-medium">{entry.action}</p>
<p className="text-xs text-muted-foreground line-clamp-2">{entry.details}</p>
```

### Fix 3: Implement Persist as Table
In `useDuckDB.ts`, add:
```typescript
const duplicateTable = async (sourceName: string, newName: string) => {
  await db.run(`CREATE TABLE "${newName}" AS SELECT * FROM "${sourceName}"`)
  // Return row count and column info for tableStore
}
```

In `App.tsx`, update `handleConfirmPersist`:
```typescript
const handleConfirmPersist = async () => {
  if (!persistTableName.trim() || !activeTable) return

  setIsPersisting(true)
  try {
    // 1. Create new table as copy
    const result = await duplicateTable(activeTable.name, persistTableName)

    // 2. Add to tableStore
    addTable({
      name: persistTableName,
      rowCount: result.rowCount,
      columns: activeTable.columns,
    })

    // 3. Clear pending operations
    clearPendingOperations()

    // 4. Add audit entry
    addAuditEntry(...)

    // 5. Switch to new table
    setActiveTableId(newTableId)

    toast.success(`Created table: ${persistTableName}`)
  } catch (error) {
    toast.error('Failed to persist table')
  } finally {
    setIsPersisting(false)
    setShowPersistDialog(false)
  }
}
```

---

## Verification

1. Load the app at http://localhost:5173
2. Upload a CSV file
3. Verify only ONE "Add file" button is visible (in header)
4. Open audit sidebar, apply a transform, verify entries display properly without cutoff
5. Click "Persist as Table", enter name, verify:
   - New table appears in table selector dropdown
   - New table is now active
   - Pending changes are cleared
6. Use the new table in Combine or Diff panel
