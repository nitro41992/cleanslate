# Fix Sluggish Modal Animations

## Problem
Modals feel sluggish and have an unpleasant diagonal slide animation (bottom-right to center).

## Root Cause
Three compounding issues:
1. **Diagonal slide classes**: `slide-in-from-left-1/2` + `slide-in-from-top-[48%]` in `dialog.tsx:39` and `alert-dialog.tsx:37`
2. **Animation stacking**: IngestionWizard applies BOTH base Dialog animations AND its own inline `scaleIn`
3. **Missing animation library**: Classes like `zoom-in-95`, `fade-in-0` require `tailwindcss-animate` plugin

## Solution (Based on 2025/26 Best Practices)
- Simple **fade + scale (0.95 to 1.0)** - no directional slide
- **280ms enter, 200ms exit** (faster exit feels snappier)
- **`prefers-reduced-motion`** accessibility support

---

## Files to Modify

### 1. `tailwind.config.js`
Add `tailwindcss-animate` plugin:
```js
plugins: [require("tailwindcss-animate")],
```

### 2. `src/components/ui/dialog.tsx` (line 37-42)
Replace DialogContent className with:
```
// Base positioning
'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border/50 bg-card p-6 shadow-xl rounded-xl',
// Enter: fade + scale (280ms)
'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-[280ms]',
// Exit: fade + scale (200ms)
'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-200',
// Accessibility
'motion-reduce:animate-none',
```

**Key removals**: `slide-in-from-left-1/2`, `slide-in-from-top-[48%]`, `slide-out-to-*`

### 3. `src/components/ui/alert-dialog.tsx` (line 34-40)
Same pattern as dialog.tsx - remove slide classes, keep fade+zoom.

### 4. `src/components/common/IngestionWizard.tsx` (lines 171-173)
Remove the inline `style` prop:
```tsx
// REMOVE THIS:
style={{
  animation: 'scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
}}
```

### 5. `src/index.css` (end of @layer utilities)
Add reduced motion support:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Components That Inherit Fix
- IngestionWizard (import modal)
- AuditDetailModal
- ConfirmDiscardDialog
- MemoryIndicator (compact memory dialog)
- App.tsx (Persist as Table dialog)
- MatchView (discard confirmation)

---

## Verification
1. `npm run dev` - Open any modal, verify smooth fade+scale (no diagonal)
2. Enable "Reduce Motion" in macOS settings - verify instant appearance
3. `npm run test` - E2E tests should pass unchanged
4. DevTools Performance - no dropped frames during animation
