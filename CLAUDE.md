# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CleanSlate Pro is a browser-based, local-first data operations suite for regulated industries. It enables data cleaning, reconciliation, deduplication, and obfuscation entirely within the browser using DuckDB-WASM. Zero server uploads - all processing happens client-side.

**Requirements:** See `CleanSlate_PRD.md` for full product requirements, functional specs (FR-A through FR-E), and performance guardrails.

## Common Commands

```bash
npm run dev       # Start Vite dev server
npm run build     # TypeScript check + production build
npm run lint      # ESLint static analysis
npm run preview   # Preview production build locally
```

## Architecture

### Tech Stack
- **React 18 + TypeScript + Vite** - Frontend framework
- **DuckDB-WASM** - In-browser SQL engine (runs in Web Worker)
- **Glide Data Grid** - Canvas-based grid for 100k+ rows
- **Zustand** - State management (7 stores)
- **Radix UI + Tailwind CSS** - UI components with dark mode
- **OPFS** - Origin Private File System for local persistence

### Core Modules (4 tabs)
| Module | Route | Purpose |
|--------|-------|---------|
| Data Laundromat | `/laundromat` | File ingestion, transformations, manual editing, audit log |
| Visual Diff | `/diff` | Compare tables with FULL OUTER JOIN reconciliation |
| Fuzzy Matcher | `/matcher` | Duplicate detection with blocking strategies |
| Smart Scrubber | `/scrubber` | Data obfuscation (hash, mask, redact, faker) |

### Directory Structure
```
src/
├── components/          # Reusable UI (common/, grid/, layout/, ui/)
├── features/            # Feature modules (laundromat/, diff/, matcher/, scrubber/)
├── lib/                 # Core business logic
│   ├── duckdb/          # DuckDB initialization & queries
│   ├── opfs/            # OPFS storage utilities
│   ├── transformations.ts
│   ├── diff-engine.ts
│   ├── fuzzy-matcher.ts
│   ├── obfuscation.ts
│   └── fileUtils.ts     # CSV parsing, encoding/delimiter detection
├── hooks/               # useDuckDB, usePersistence, useToast
├── stores/              # Zustand stores (table, audit, diff, matcher, scrubber, ui, edit)
└── types/               # TypeScript interfaces
```

### Data Flow
```
File Upload → useDuckDB hook → DuckDB-WASM (Worker) → tableStore → DataGrid
                                    ↓
                            Transform/Diff/Match/Scrub
                                    ↓
                            auditStore (log changes) → Export CSV/OPFS persistence
```

### Key Patterns
- **Local-first**: All data processing happens in-browser via DuckDB SQL
- **Store-driven UI**: Zustand stores are single source of truth
- **Composable transforms**: Recipe builder chains SQL operations
- **Immutable audit trail**: Every action logged with timestamp and impact metrics
- **Web Crypto API**: SHA-256 hashing for obfuscation (no third-party crypto)

## TypeScript Configuration

- Strict mode enabled
- Path alias: `@/*` maps to `./src/*`
- Target: ES2020

## Implemented Features

### FR-A4: Manual Cell Editing
- Double-click any cell to edit (Text/Number/Boolean)
- Red triangle indicator on edited cells (dirty state)
- Undo/Redo with Ctrl+Z / Ctrl+Y (10-step stack)
- Type B audit log entries with previous/new values

### FR-A6: Ingestion Wizard
- Modal triggered on CSV file drop
- Raw text preview (first 50 lines)
- Header row selection (rows 1-10)
- Encoding detection (UTF-8/Latin-1) with override
- Delimiter detection (Comma/Tab/Pipe/Semicolon) with override

## Important Notes

- Desktop-only application (MobileBlocker prevents mobile access)
- Dark mode enabled by default (`<html class="dark">`)
- DuckDB-WASM excluded from Vite optimization (see vite.config.ts)
- Service worker provides offline support in production
