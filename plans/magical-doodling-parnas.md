# Plan: Type-Specific Column Header Icons with Click Tooltip

## Problem Statement
Currently, clicking anywhere on a column header shows a tooltip with the column type, but it auto-hides after 2 seconds. This is clunky because users can't keep the tooltip open for reference.

## Solution
Add type-specific icons to column headers that:
1. Show the data type at a glance (T for text, # for numbers, etc.)
2. When clicked, display a persistent tooltip explaining what the type means
3. Tooltip stays visible until user clicks elsewhere or presses Escape

## Type Icon Mapping (Using Glide's Built-in Icons)

| DuckDB Type | Glide Icon | Tooltip Text |
|-------------|------------|--------------|
| VARCHAR | `GridColumnIcon.HeaderString` | "Text - Variable length string" |
| INTEGER/BIGINT | `GridColumnIcon.HeaderNumber` | "Integer - Whole number" |
| DOUBLE/DECIMAL | `GridColumnIcon.HeaderNumber` | "Decimal - Number with decimals" |
| DATE | `GridColumnIcon.HeaderDate` | "Date - Calendar date" |
| TIMESTAMP | `GridColumnIcon.HeaderTime` | "Timestamp - Date and time" |
| BOOLEAN | `GridColumnIcon.HeaderBoolean` | "Boolean - True/False value" |
| UUID | `GridColumnIcon.HeaderRowID` | "UUID - Unique identifier" |

## Files to Modify

**`src/components/grid/DataGrid.tsx`**
- Import `GridColumnIcon` from `@glideapps/glide-data-grid`
- Add helper function `getColumnIcon(type: string): GridColumnIcon`
- Update `gridColumns` to include `icon` property based on column type
- Modify `handleHeaderClicked` to show persistent tooltip (remove setTimeout)
- Add click-outside handler to dismiss tooltip
- Add Escape key handler to dismiss tooltip

## Implementation Details

### 1. Import GridColumnIcon
```typescript
import DataGridLib, {
  GridColumn,
  GridColumnIcon,  // ADD THIS
  // ... other imports
} from '@glideapps/glide-data-grid'
```

### 2. Add Icon Mapping Function
```typescript
function getColumnIcon(type: string): GridColumnIcon | undefined {
  const normalizedType = type.toUpperCase()
  if (normalizedType.includes('VARCHAR') || normalizedType.includes('TEXT')) {
    return GridColumnIcon.HeaderString
  }
  if (normalizedType.includes('INT') || normalizedType.includes('BIGINT')) {
    return GridColumnIcon.HeaderNumber
  }
  if (normalizedType.includes('DOUBLE') || normalizedType.includes('DECIMAL') || normalizedType.includes('FLOAT')) {
    return GridColumnIcon.HeaderNumber
  }
  if (normalizedType.includes('DATE') && !normalizedType.includes('TIMESTAMP')) {
    return GridColumnIcon.HeaderDate
  }
  if (normalizedType.includes('TIMESTAMP') || normalizedType.includes('TIME')) {
    return GridColumnIcon.HeaderTime
  }
  if (normalizedType.includes('BOOL')) {
    return GridColumnIcon.HeaderBoolean
  }
  if (normalizedType.includes('UUID')) {
    return GridColumnIcon.HeaderRowID
  }
  return undefined
}
```

### 3. Update gridColumns to Include Icon
```typescript
const gridColumns: GridColumn[] = useMemo(
  () =>
    columns.map((col) => {
      const colType = columnTypeMap.get(col)
      const icon = colType ? getColumnIcon(colType) : undefined
      // ... rest of column config
      return {
        id: col,
        title: col,
        width,
        icon,  // ADD THIS
      }
    }),
  [columns, columnTypeMap, columnPreferences]
)
```

### 4. Make Tooltip Persistent
```typescript
// Remove the setTimeout auto-hide
const handleHeaderClicked = useCallback(
  (col: number, event: { bounds: { x: number; y: number; width: number; height: number } }) => {
    const colName = columns[col]
    const colType = columnTypeMap.get(colName)
    if (colType) {
      const typeDisplay = getTypeDisplayName(colType)
      setHeaderTooltip({
        column: colName,
        type: typeDisplay,
        x: event.bounds.x + event.bounds.width / 2,
        y: event.bounds.y + event.bounds.height,
      })
      // REMOVE: setTimeout(() => setHeaderTooltip(null), 2000)
    }
  },
  [columns, columnTypeMap]
)
```

### 5. Add Dismiss Handlers
```typescript
// Click outside handler
useEffect(() => {
  if (!headerTooltip) return

  const handleClickOutside = (e: MouseEvent) => {
    setHeaderTooltip(null)
  }

  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setHeaderTooltip(null)
    }
  }

  // Delay listener to avoid immediate dismissal from the click that opened it
  const timeoutId = setTimeout(() => {
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
  }, 0)

  return () => {
    clearTimeout(timeoutId)
    document.removeEventListener('click', handleClickOutside)
    document.removeEventListener('keydown', handleEscape)
  }
}, [headerTooltip])
```

### 6. Update Tooltip Content (optional enhancement)
Show more descriptive text explaining what the type means:
```typescript
{headerTooltip && (
  <div className="fixed z-50 px-3 py-2 text-xs bg-zinc-800 ...">
    <div className="font-medium text-zinc-100">{headerTooltip.column}</div>
    <div className="text-zinc-400 mt-0.5">
      Type: <span className="text-amber-400">{headerTooltip.type}</span>
    </div>
    <div className="text-zinc-500 mt-1 text-[10px]">
      {getTypeDescription(headerTooltip.type)}
    </div>
  </div>
)}
```

## Verification
1. Run `npm run dev`
2. Load a table with mixed column types (text, numbers, dates)
3. Verify each column header shows the appropriate type icon
4. Click a header icon → tooltip appears
5. Verify tooltip stays visible (doesn't auto-hide)
6. Click elsewhere → tooltip dismisses
7. Press Escape → tooltip dismisses
8. Run `npm run test` to ensure no regressions
