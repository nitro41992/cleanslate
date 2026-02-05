# Plan: Dark/Light Mode Toggle

## Summary

Add a theme toggle to switch between dark and light mode. The infrastructure is already 90% there — CSS variables for both modes exist, Tailwind is configured for class-based dark mode, and GDG CSS variable mappings cover all grid colors. The main work is wiring up the toggle and removing hardcoded hex overrides.

## Approach

**Theme storage:** `localStorage` (synchronous read for anti-FOUC, no OPFS schema changes needed).

**Anti-FOUC:** Tiny inline `<script>` in `index.html` reads localStorage before React mounts — prevents flash of wrong theme.

**Grid theming:** Remove hardcoded hex colors from JS `theme` props. The existing `.gdg-container` CSS variables in `index.css` already map every GDG property to shadcn tokens — they'll take over automatically.

## Files to Modify

### 1. `index.html` — Dynamic theme class
- Remove hardcoded `class="dark"` from `<html>`
- Add inline `<script>` that reads `localStorage.getItem('cleanslate-theme')` and applies `dark` class if needed (default: dark)

### 2. `src/index.css` — Add missing light-mode diff variables
- Add `-bg`, `-text`, `-border`, `-unchanged-*` diff variables to `:root` (currently only in `.dark`)
- Update the `:root` comment to remove "(unused, keeping dark)"

### 3. `src/stores/uiStore.ts` — Theme state + actions
- Add `themeMode: 'light' | 'dark'` to UIState (init from `localStorage`, default `'dark'`)
- Add `setThemeMode(mode)` action that:
  - Updates state
  - Toggles `document.documentElement.classList` (`dark` class)
  - Writes to `localStorage`

### 4. `src/components/layout/AppHeader.tsx` — Theme toggle button
- Import `Sun`/`Moon` from lucide-react
- Add toggle button in the right section, **outside** the `{activeTable && ...}` block so it's always visible
- Read `themeMode` + `setThemeMode` from `useUIStore`
- Sun icon when dark (click to go light), Moon icon when light (click to go dark)

### 5. `src/components/grid/DataGrid.tsx` — Remove hardcoded colors
- Strip color hex values from the `gridTheme` useMemo (lines 1072-1091)
- Keep only: `fontFamily`, `baseFontStyle`, `headerFontStyle`, `editorFontSize`
- CSS variables in `.gdg-container` handle all colors automatically

### 6. `src/components/diff/VirtualizedDiffGrid.tsx` — Remove hardcoded colors
- Strip color hex values from inline `theme={{...}}` (lines 910-929)
- Keep only: `fontFamily`, `baseFontStyle`, `headerFontStyle`, `editorFontSize`

## Verification

1. `npm run build` — TypeScript check passes
2. `npm run dev` — Visual check:
   - Toggle button visible in header (always, even without a table loaded)
   - Click toggles between light/dark
   - Refresh preserves preference (localStorage)
   - Grid colors switch correctly (no stale hex values)
   - Diff view colors work in both modes
3. `npm run lint` — No lint errors
