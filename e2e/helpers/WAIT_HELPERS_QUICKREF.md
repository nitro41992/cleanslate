# Wait Helpers - Quick Reference Card

## 🚫 Don't Use
```typescript
await page.waitForTimeout(N)  // FORBIDDEN
```

## ✅ Use Instead

### Transform Operations
```typescript
await picker.addTransformation(...)
await inspector.waitForTransformComplete()
```

### Panel Animations
```typescript
await laundromat.openCleanPanel()
await inspector.waitForPanelAnimation('panel-clean')
```

### Merge/Dedupe
```typescript
await matchView.applyMerges()
await inspector.waitForMergeComplete()
```

### Grid Ready
```typescript
await wizard.import()
await inspector.waitForTableLoaded('table_name', rowCount)
await inspector.waitForGridReady()
```

## 📋 Method Signatures

```typescript
inspector.waitForTransformComplete(tableId?: string, timeout?: number)
inspector.waitForPanelAnimation(panelId: string, timeout?: number)
inspector.waitForMergeComplete(timeout?: number)
inspector.waitForGridReady(timeout?: number)
```

## 🔧 Common Panel IDs

- `panel-clean` - Clean/Transform panel
- `panel-match` - Match panel
- `panel-combine` - Combine panel
- `panel-scrub` - Scrub panel
- `match-view` - Match view overlay

## ⏱️ Default Timeouts

| Method | Default | Use Case |
|--------|---------|----------|
| `waitForTransformComplete` | 30s | Heavy transforms |
| `waitForPanelAnimation` | 10s | UI animations |
| `waitForMergeComplete` | 30s | Dedupe/merge ops |
| `waitForGridReady` | 15s | Grid initialization |

## 🎯 Quick Decision Tree

```
What are you waiting for?
│
├─ Transform to complete? → waitForTransformComplete()
├─ Panel to open? → waitForPanelAnimation(panelId)
├─ Merge to finish? → waitForMergeComplete()
├─ Grid to load? → waitForGridReady()
├─ Data to load? → waitForTableLoaded()
├─ DuckDB ready? → waitForDuckDBReady()
└─ Something else? → Use expect.poll() or expect(locator).toBeVisible()
```

## 📚 Full Docs

- Usage Guide: `WAIT_HELPERS.md`
- Examples: `WAIT_HELPERS_EXAMPLES.md`
- Implementation: `WAIT_HELPERS_SUMMARY.md`
