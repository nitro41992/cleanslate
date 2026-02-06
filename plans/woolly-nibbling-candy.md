# Phase 0: COI Multi-Threading Investigation

**Goal:** Enable DuckDB-WASM's COI (Cross-Origin Isolated) bundle for 2-5x performance via pthreads + SIMD, while keeping existing Parquet persistence working.

**Source plan:** `plans/glimmering-enchanting-mccarthy.md` (full performance optimization plan)

---

## Why COI First

The COI bundle gives DuckDB-WASM multi-threading (pthreads) and SIMD support. Published benchmarks show **2-5x performance improvement** for analytical queries. If this works, it's a bigger win than all Tier 1 quick-win optimizations combined — and it's essentially free (just HTTP headers + validation).

---

## Current State (Verified)

| Component | Status | Evidence |
|-----------|--------|----------|
| COI bundle imports | Ready | `duckdb/index.ts:3-5` — all 3 bundles imported |
| Auto-detection | Ready | `duckdb/index.ts:141-154` — `crossOriginIsolated` check selects COI bundle |
| Pthread init | Ready | `duckdb/index.ts:162-167` — `db.instantiate(mainModule, pthreadWorker)` |
| OPFS VFS disabled | Forced off | `browser-detection.ts:50` — `supportsAccessHandle = false` (bug #2096 workaround) |
| DuckDB mode | In-memory | `:memory:` because `supportsAccessHandle = false` |
| Thread config | `SET threads = 2` | `duckdb/index.ts:362` — silently fails on EH build |
| COOP/COEP headers | Not set | `vite.config.ts` has no header middleware |
| Production headers | No `vercel.json` etc. | Only referenced in original plan, no file exists |

**Key architecture insight:** CleanSlate uses TWO separate persistence layers:
1. **DuckDB's internal OPFS VFS** (`opfs://cleanslate.db`) — **DISABLED** (bug #2096)
2. **JS File System API** (`navigator.storage.getDirectory()` → `createWritable()`) — **ACTIVE**, used for Parquet snapshots

Bug #2096 only affects layer 1 (DuckDB's VFS + pthreads = `DataCloneError`). Layer 2 (JS API from main thread) should be unaffected by COI headers. Since DuckDB runs in `:memory:` mode, enabling COI should give us pthreads WITHOUT triggering the bug.

---

## Implementation Steps

### Step 1: Add COOP/COEP Headers to Vite Dev Server (~10 min)

**File:** `vite.config.ts`

Add a Vite plugin that sets both required headers for the dev and preview servers:

```typescript
// Cross-Origin Isolation headers plugin
// Required for DuckDB-WASM COI bundle (SharedArrayBuffer + pthreads)
function crossOriginIsolationPlugin() {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        next()
      })
    },
  }
}
```

Add to `plugins` array: `plugins: [crossOriginIsolationPlugin(), react()]`

**Order matters:** COI plugin before react() so headers are set before any response.

### Step 2: Update Thread Configuration (~5 min)

**File:** `src/lib/duckdb/index.ts` (line 362)

Change from hardcoded `threads = 2` to adaptive based on COI availability:

```typescript
try {
  const isCOI = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  const threadCount = isCOI ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1
  await initConn.query(`SET threads = ${threadCount}`)
  console.log(`[DuckDB] Thread count set to ${threadCount} (COI: ${isCOI})`)
} catch (err) {
  // Silently ignore - WASM build doesn't support thread configuration (expected)
}
```

Cap at 4 threads to limit per-thread buffer allocation (~125MB each). On most machines this still gives significant parallelism for joins and sorts.

### Step 3: Add Diagnostic Logging (~5 min)

**File:** `src/lib/duckdb/index.ts` (after line 399)

Add a clear console banner so we can verify COI activation:

```typescript
console.log(
  `[DuckDB] ${bundleType} bundle, ${memoryLimit} limit, compression enabled, ` +
  `${isPersistent ? 'OPFS' : 'in-memory'}, ` +
  `COI: ${typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false}, ` +
  `threads: ${isCOI ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1}`
)
```

### Step 4: Manual Verification Checklist (~2-3 hours)

Run `npm run dev` and test in Chrome:

**4a. COI Activation (5 min)**
- [ ] Open browser console
- [ ] Verify `crossOriginIsolated === true`
- [ ] Verify `typeof SharedArrayBuffer !== 'undefined'`
- [ ] Check DuckDB init log shows "COI bundle"
- [ ] Check thread count log shows correct value (2-4)

**4b. Basic Functionality (30 min)**
- [ ] Upload a CSV (any size)
- [ ] Apply Tier 1 transforms (trim, replace, lowercase)
- [ ] Apply Tier 3 transform (remove_duplicates or cast_type)
- [ ] Undo the Tier 3 transform
- [ ] Verify data integrity after undo

**4c. Parquet Persistence (1 hour) — CRITICAL PATH**
- [ ] Upload a CSV, apply transforms
- [ ] Wait for persistence indicator (amber → green)
- [ ] Page reload — verify data survives
- [ ] Check OPFS files via DevTools → Application → Storage → File System
- [ ] Upload a large CSV (100k+ rows if available) — verify chunked export works
- [ ] Apply transforms to large dataset, reload, verify
- [ ] Test freeze/thaw cycle (close tab, reopen)

**4d. Multi-Panel Operations (30 min)**
- [ ] Test Merge panel (fuzzy matcher)
- [ ] Test Combine panel (stack/join)
- [ ] Test Diff panel
- [ ] Test Standardize panel

**4e. Performance Comparison (30 min)**

To compare EH vs COI, temporarily toggle COI off by commenting out the Vite plugin:

| Operation | EH Time | COI Time | Speedup |
|-----------|---------|----------|---------|
| Trim 100k rows | | | |
| Remove duplicates 100k rows | | | |
| Sort 100k rows | | | |
| Undo Tier 3 (replay) | | | |

**4f. Memory Check (15 min)**
- [ ] Open DevTools → Memory tab
- [ ] Note baseline memory after DuckDB init
- [ ] Note memory after 5 transforms on 100k rows
- [ ] Compare COI vs EH memory usage (COI may be ~200-500MB higher due to thread buffers)

### Step 5: Decision Point

| Outcome | Next Action |
|---------|-------------|
| **COI works + persistence intact** | Keep headers. Proceed to Tier 1 items (skip 1.3 — already handled). |
| **COI works but persistence broken** | Keep DuckDB in `:memory:` + COI bundle, investigate JS OPFS API separately. |
| **COI bundle crashes** | Revert headers. Implement 1.3 as `threads = 1`. Proceed to Tier 1. |
| **COI works but no measurable speedup** | Keep headers (future-proofing), but prioritize Tier 1 algorithmic wins. |

### Step 6: Production Headers (if COI works, ~15 min)

Determine hosting platform and add appropriate configuration. No `vercel.json` or `netlify.toml` exists yet — will need to create one based on the deployment target.

**Vercel** (`vercel.json`):
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**Netlify** (`public/_headers`):
```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bug #2096 triggered | **Low** — DuckDB runs in `:memory:`, not OPFS VFS | High | Easy revert: remove Vite plugin |
| JS OPFS API breaks under COI | **Very Low** — `createWritable()` unaffected by COOP/COEP | High | Revert headers |
| Thread buffers consume too much memory | **Medium** — 4 threads × ~125MB each | Medium | Cap threads at 2 |
| 3rd party resource blocked by COEP | **Very Low** — no CDN scripts, fonts, or iframes | Low | Add `crossorigin` attribute if needed |
| WebWorker lifecycle timing changes | **Low** | Medium | Test DuckDB init thoroughly |

**Overall risk: Low.** The change is 100% reversible by removing 2 HTTP headers.

---

## Files to Modify

| File | Change | Risk |
|------|--------|------|
| `vite.config.ts` | Add COOP/COEP middleware plugin | Low |
| `src/lib/duckdb/index.ts` (line 362) | Adaptive thread count based on COI | Low |

**Files NOT modified** (important):
- `src/lib/duckdb/browser-detection.ts` — `supportsAccessHandle = false` stays. We keep DuckDB in `:memory:` mode. No change to the bug #2096 workaround.
- `src/lib/opfs/snapshot-storage.ts` — Parquet persistence unchanged.

---

## Verification

1. `npm run build` — TypeScript check passes
2. `npm run dev` — App loads, console shows "COI bundle"
3. `crossOriginIsolated === true` in browser console
4. Upload CSV → apply transforms → page reload → data persists
5. `npm run test` — all E2E tests pass (Playwright may need COI headers too — check `playwright.config.ts`)

**E2E tests:** Playwright uses `npm run dev` as its web server (`playwright.config.ts:39`), so it inherits the Vite plugin and will automatically test against the COI bundle. This is ideal — any COI regressions will surface in the existing test suite. No Playwright config changes needed.
