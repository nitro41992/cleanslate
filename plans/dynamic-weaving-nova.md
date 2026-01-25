# Plan: CLAUDE.md Optimization

## Research Summary: Best Practices (2025-2026)

Based on research from [Anthropic's official best practices](https://www.anthropic.com/engineering/claude-code-best-practices), [The Complete Guide to CLAUDE.md](https://www.builder.io/blog/claude-md-guide), and [gradually.ai's template guide](https://www.gradually.ai/en/claude-md/):

### Key Principles
1. **Keep it concise** - No hard limit, but <50KB recommended for optimal performance
2. **Modular sections** - Break into functional modules with clear markdown headers
3. **Living document** - Capture Claude's mistakes and iterate like a prompt
4. **Use emphasis** - "IMPORTANT", "YOU MUST" for critical rules
5. **Hierarchy support** - Nested CLAUDE.md files can provide module-specific context
6. **Essential content**: commands, code style, architecture patterns, testing instructions

### What NOT to include
- Verbose prose that could be condensed
- Duplicate explanations of the same concept
- Static reference material that rarely changes
- Sensitive data

---

## Current CLAUDE.md Analysis

| Metric | Value |
|--------|-------|
| Lines | 449 |
| High-complexity sections | 3 (60% of content) |
| Redundancy issues | 4 identified |

### Identified Problems
1. **Command Pattern explained twice** (architectural + philosophical sections)
2. **Testing guidance fragmented** across 3 separate sections
3. **Architecture overlaps** with Engineering Directive
4. **Missing quick-reference** for critical rules

---

## Your Proposal Assessment

### Strengths
| Aspect | Improvement |
|--------|-------------|
| Structure | Numbered sections (1-7) create clear hierarchy |
| Commands | Adds `npm run test`, `test:ui`, `test:headed` |
| Testing | Consolidates into single "E2E Testing Guidelines" section |
| Deprecation | Clearly marks `transformations.ts` as `[DEPRECATED]` |
| Gotchas | New section captures "load-bearing" context |
| Tables | Module table includes Route + Store mapping |

### Gaps to Address
| Issue | Recommendation |
|-------|----------------|
| Test fixtures catalog missing | Add back as reference subsection |
| Page object helpers missing | Include `StoreInspector` methods table |
| Some formatting broken | Fix markdown rendering (sections 4-7 ran together) |
| Serial group pattern missing | Include as code example |
| Nested CLAUDE.md opportunity | Consider adding `e2e/CLAUDE.md` for test-specific context |

---

## Recommended Final Structure

```
# CLAUDE.md

## 1. Project Overview (5 lines)
   - One-liner + PRD reference only

## 2. Rules & Behavior (Strict) (~10 lines)
   - 4-5 critical behavioral rules
   - Use "MUST" language

## 3. Common Commands (~15 lines)
   - dev, build, lint, test commands
   - Code block format

## 4. Architecture (~60 lines)
   - Tech Stack (list)
   - Directory Map (tree)
   - Core Modules table (Route/Store/Purpose)
   - Data Flow diagram (ASCII)

## 5. Engineering Directives (~50 lines)
   - 5.1 Golden Rule: "If it Mutates, It's a Command"
   - 5.2 Strangler Fig Strategy (DEPRECATED warning)
   - 5.3 State Management Hygiene
   - 5.4 Dependency Hierarchy table

## 6. Testing Standards (~80 lines)
   - 6.1 State Isolation ("Clean Slate" Rule)
   - 6.2 Async & Timing ("No Sleep" Rule)
   - 6.3 Robust Selectors & Assertions
   - 6.4 Infrastructure (timeouts, cleanup)
   - 6.5 Test Helpers Quick Reference (table)
   - 6.6 Fixtures Catalog

## 7. Gotchas & Context (~15 lines)
   - DuckDB async behavior
   - Mobile blocker
   - Vite config warning
   - Route navigation
```

**Estimated total: ~235 lines** (47% reduction from 449)

---

## Implementation Plan: Incremental Merge

**Decisions Made:**
- Single CLAUDE.md file (no nested e2e/CLAUDE.md)
- Fixtures: Reference only ("see `e2e/fixtures/csv/`")
- Approach: Incremental section-by-section improvements

---

### Step 1: Restructure Top Sections (Lines 1-25)
**Current:** Project Overview (9 lines) + Commands (8 lines) + Rules (6 lines)
**Target:** Condensed to ~25 lines total

Changes:
- Combine into numbered sections 1-3
- Add test commands (`npm run test`, `test:ui`, `test:headed`)
- Strengthen rules with "MUST" language

---

### Step 2: Consolidate Architecture (Lines 27-143)
**Current:** 116 lines with redundant Command Pattern explanations
**Target:** ~60 lines

Changes:
- Keep Tech Stack as bullet list
- Add Route/Store columns to Core Modules table
- Remove "Key Patterns" subsection (duplicates Engineering Directive)
- Condense Command Pattern to essentials (tiers table + usage example)
- Remove verbose directory tree (keep simplified version)

---

### Step 3: Streamline Engineering Directive (Lines 145-226)
**Current:** 81 lines with philosophical prose
**Target:** ~50 lines

Changes:
- Keep Golden Rule, Strangler Fig, Dependency Hierarchy
- Mark `transformations.ts` as `[DEPRECATED]` explicitly
- Remove repetitive "Violation" examples
- Condense Code Review Checklist to 4 essential items

---

### Step 4: Unify Testing Sections (Lines 228-441)
**Current:** 3 fragmented sections totaling 213 lines
**Target:** Single "E2E Testing Guidelines" section (~80 lines)

Structure:
```
## 6. E2E Testing Guidelines
### 6.1 State Isolation ("Clean Slate" Rule)
### 6.2 Async & Timing ("No Sleep" Rule)
### 6.3 Selectors & Assertions
### 6.4 Infrastructure
### 6.5 Test Helpers (table)
### 6.6 Fixtures (reference only)
```

Key additions from your proposal:
- Heavy tests: `beforeEach` + `browser.newPage()` for WASM memory
- Forbidden: `await page.waitForTimeout(N)`
- Re-instantiation rule for Page Objects

---

### Step 5: Add Gotchas Section (New)
**Target:** ~15 lines

Content:
- DuckDB async behavior
- Mobile Blocker warning
- Vite optimization exclusion
- Route navigation (/ vs /matcher)

---

### Step 6: Final Cleanup
- Remove "Important Notes" section (absorbed into Gotchas)
- Verify all markdown renders correctly
- Check total line count (~235 target)

---

## Files to Modify

| File | Action |
|------|--------|
| `CLAUDE.md` | Edit in place, section by section |

---

## Verification Plan

1. After each step: Visual review of markdown rendering
2. After completion: Run `npm run lint && npm run build`
3. Start fresh Claude Code session
4. Test: Ask "How should I add a new transformation?"
   - Verify Claude mentions Command Pattern, not transformations.ts
5. Test: Ask "How do I write an E2E test?"
   - Verify Claude mentions "No Sleep" rule and State Isolation
