# Plan: Consistent Sidebar UX for Merge & Smart Replace

## Summary

Two changes:
1. **Merge sidebar** — Fix workflow so column must be selected before algorithm cards become interactive
2. **Smart Replace sidebar** — Add collapsible sidebar + replace dropdown with card-based algorithm selection (matching Merge pattern) + same workflow gating

## UX Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Progressive disclosure | Dimmed (`opacity-50 + pointer-events-none`) not hidden | Teaches user the next step; no layout shift |
| Auto-collapse timing | On results found (not analysis start) | Matches Merge pattern; keeps sidebar open if analysis fails |
| Auto-expand on New Analysis | Yes | Matches Merge's `handleNewSearch` behavior |
| Shared component? | No — shared style utility only | Data shapes differ (6 strategies vs 3 algos); arrow semantics differ (`↔` vs `→`) |
| `configCollapsed` state | Local `useState` | Ephemeral UI state, same as Merge; resets on view open |
| Smart Replace algorithm badges | Fingerprint → "Recommended" (default), Metaphone → "Sound-alike" (secondary), Token Phonetic → "Best for names" (secondary) | Guides user without being prescriptive |

## Files to Change

### 1. `src/features/matcher/components/MatchConfigPanel.tsx` — Workflow gating

**~15 lines changed.** Wrap the "Grouping Strategy" section (lines 169-252) in a container that dims when no column is selected:

```tsx
const isColumnSelected = !!matchColumn

<div className={cn(
  'space-y-3 transition-opacity duration-200',
  !isColumnSelected && 'opacity-50 pointer-events-none'
)}>
  <Label>Grouping Strategy</Label>
  {!isColumnSelected && (
    <p className="text-xs text-muted-foreground italic">
      Select a column above to choose a strategy
    </p>
  )}
  <RadioGroup ...>  {/* existing cards unchanged */}
  </RadioGroup>
</div>
```

No changes to `canSearch` logic — already requires `tableId && matchColumn && !isMatching`.

### 2. `src/features/standardizer/components/StandardizeConfigPanel.tsx` — Card redesign

**~100 lines changed.** Three changes:

**a) Merge `ALGORITHM_EXAMPLES` and `ALGORITHM_INFO` into one structure** with badge data added:
- `fingerprint`: badge "Recommended" (variant: `default`)
- `metaphone`: badge "Sound-alike" (variant: `secondary`)
- `token_phonetic`: badge "Best for names" (variant: `secondary`)

**b) Replace `Select` dropdown + static info card** (lines 150-207) with RadioGroup cards:
- Same card pattern as `MatchConfigPanel`: `RadioGroup` → card divs with `RadioGroupItem`, title, badge, description, expanding examples+hints on selection
- Arrow: `→` (unidirectional, since normalization is one-way) vs Merge's `↔`
- `e.g.` prefix on examples (matching Merge)

**c) Add workflow gating** — algorithm section dimmed until `columnName` is set:
```tsx
<div className={cn(
  'space-y-3 transition-opacity duration-200',
  !columnName && 'opacity-50 pointer-events-none'
)}>
```

**Import changes:** Remove `Select, SelectContent, SelectItem, SelectTrigger, SelectValue`. Add `RadioGroup, RadioGroupItem`, `Badge`, `cn`.

### 3. `src/features/standardizer/StandardizeView.tsx` — Collapsible sidebar

**~40 lines changed.**

**a) Add imports:** `ChevronsLeft, ChevronsRight` from lucide-react; `cn` from utils.

**b) Add state:** `const [configCollapsed, setConfigCollapsed] = useState(false)`

**c) Replace static sidebar container** (lines 376-394) with collapsible pattern from MatchView:
```tsx
<div className={cn(
  'border-r border-border bg-card shrink-0 transition-all duration-200',
  configCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-80'
)}>
  {!configCollapsed && (
    <ScrollArea className="h-full">
      <StandardizeConfigPanel ... />
    </ScrollArea>
  )}
</div>

{/* Toggle button */}
<button className="z-10 self-center flex items-center justify-center shrink-0
  w-6 h-12 rounded-r-md border border-l-0 border-border bg-card
  hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
  onClick={() => setConfigCollapsed(c => !c)}
  title={configCollapsed ? 'Show config panel' : 'Hide config panel'}
>
  {configCollapsed ? <ChevronsRight className="w-3.5 h-3.5" /> : <ChevronsLeft className="w-3.5 h-3.5" />}
</button>
```

**d) Auto-collapse when clusters found:**
```tsx
useEffect(() => {
  if (clusters.length > 0 && !isAnalyzing) {
    setConfigCollapsed(true)
  }
}, [clusters.length, isAnalyzing])
```

**e) Auto-expand on New Analysis** — add `setConfigCollapsed(false)` to both `handleNewAnalysis` (clear branch) and `handleConfirmDiscard`.

### 4. `e2e/page-objects/standardize-view.page.ts` — Update `selectAlgorithm`

**~5 lines changed.** Replace Select dropdown interaction with RadioGroup click:

```typescript
async selectAlgorithm(algorithm: 'fingerprint' | 'metaphone' | 'token_phonetic'): Promise<void> {
  const names: Record<string, RegExp> = {
    fingerprint: /Fingerprint/i,
    metaphone: /Metaphone/i,
    token_phonetic: /Token Phonetic/i,
  }
  await this.container.getByRole('radio', { name: names[algorithm] }).click()
}
```

The `newAnalysis()` method already expects `analyzeButton` to be visible — this works because `handleNewAnalysis` auto-expands the sidebar.

## Implementation Order

| Step | File | Depends on |
|------|------|------------|
| 1 | `MatchConfigPanel.tsx` — workflow gating | None |
| 2 | `StandardizeConfigPanel.tsx` — card redesign | None |
| 3 | `StandardizeView.tsx` — collapsible sidebar | None |
| 4 | `standardize-view.page.ts` — E2E page object | Step 2 |

Steps 1-3 are independent and can be done in any order.

## Verification

1. **Manual**: Open Merge → verify algorithm cards are dimmed until column selected → select column → cards activate → Find Duplicates works
2. **Manual**: Open Smart Replace → verify collapsible sidebar → column gating on algorithm cards → analyze → sidebar auto-collapses → New Analysis auto-expands
3. **E2E**: `npx playwright test "value-standardization.spec.ts" --timeout=90000 --retries=0 --reporter=line`
4. **Build**: `npm run build` (TypeScript check)
