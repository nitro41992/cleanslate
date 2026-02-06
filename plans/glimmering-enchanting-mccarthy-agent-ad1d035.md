# Competitive Landscape: Browser-Based & Local-First Data Tools (2025-2026)

## Research Summary

Market research on row/performance limits across competing tools, their claims, and evidence of actual large-dataset handling in-browser.

---

## 1. Tool-by-Tool Analysis

### Quadratic (WASM + WebGL Spreadsheet)
- **Claimed limit:** "Millions of rows of data in seconds"
- **Architecture:** Rust + WASM + WebGL, canvas rendered like a tile map (Google Maps style)
- **Performance claim:** 60 FPS smooth navigation, "even large data sets and computations run in milliseconds"
- **Actual hard number:** None published. No specific benchmarks or row ceilings disclosed.
- **Positioning language:** "The first WASM + WebGL spreadsheet," "snappy, secure, and scalable"
- **Reality check:** They deliberately avoid committing to a number. "It may never make sense to bring a billion rows into a spreadsheet, but the case can be made for bringing in a million."

### Observable / D3
- **Claimed limit:** Not a data processing tool per se -- it's visualization
- **SVG rendering:** ~1,000 datapoints
- **Canvas rendering:** ~10,000 datapoints at 60fps
- **Their strategy:** Aggregate server-side, send small payloads to browser. Example: 8M order prices reduced to 1,000 histogram bins via DuckDB SQL before rendering
- **DuckDB integration:** Observable now has built-in DuckDB support; one demo shows 5.2M rows of college degree data queried in-browser
- **Positioning:** They explicitly DON'T claim to render millions of rows -- they claim to *query* them and render aggregations

### Perspective (FINOS)
- **Claimed limit:** "Ludicrous size datasets" (their actual words), "Desktop-like performance in the Browser"
- **Architecture:** C++ compiled to WASM, Apache Arrow columnar format, streaming query engine
- **Benchmark data:** Test dataset of 864K rows (10 days of per-second data) used in their benchmarks
- **Actual hard number:** None published. No specific row ceiling claimed.
- **v3.0 improvement:** "Overall CPU time improvement on every method we benchmark"
- **Positioning:** "Especially well-suited for large and/or streaming datasets" -- they never say how large

### Tad (DuckDB Desktop Viewer)
- **Claimed limit:** No explicit row limit claimed
- **Architecture:** Desktop Electron app, DuckDB engine (not browser WASM)
- **Performance:** Opens Parquet files "mind-blowingly fast" because DuckDB operates on Parquet in-place without import
- **Reality:** Being a desktop app with native DuckDB, it inherits DuckDB's native performance (billions of rows, out-of-core processing). Not browser-constrained.
- **Positioning:** "Fast viewer for CSV and Parquet files" -- focused on viewing, not transformation

### Evidence.dev (DuckDB-Based BI)
- **Claimed limit:** No explicit row limit
- **Architecture:** DuckDB-WASM in browser querying Parquet cache files built at compile time
- **Strategy:** Pre-renders at build time, then runs live queries against Parquet cache in-browser via DuckDB-WASM
- **Positioning:** "Consumer web app" performance applied to BI -- "response times measured in milliseconds"
- **Reality:** They aggregate at build time. The browser never processes raw millions of rows; it queries pre-built Parquet caches.

### Rill Data
- **Claimed limit:** "Less than 100GB of data" for single-node (covers "vast majority of real-world use cases")
- **Architecture:** Desktop CLI + DuckDB embedded (not browser-based)
- **Performance:** DuckDB outperforms SQLite 3-30x on analytics queries; 10x vs single-node Spark
- **Positioning:** "Conversation-fast data profiling" -- focuses on sub-second latency for interactive dashboards
- **Reality:** Not browser-based. Local desktop tool. Can handle hundreds of millions of rows on a laptop with Parquet.

### Datasette / Datasette Lite
- **Claimed limit:** Returns max 1,000 rows per query result (configurable)
- **Architecture:** SQLite + Pyodide (full Python interpreter in WASM)
- **Browser story:** Datasette Lite runs entirely in browser via WebAssembly
- **Performance principle:** "Never scan more than 10,000 rows without user explicitly requesting it"
- **Reality:** The browser version downloads the full Python interpreter + dependencies + SQLite DB. Practical limit is constrained by browser memory. Focused on exploration, not transformation.
- **Positioning:** "Multi-tool for exploring and publishing data"

### Excel Online / Google Sheets
- **Google Sheets:** 10 million cell limit (not row limit). Practically unusable above ~100K rows.
  - With 26 columns: ~384K rows max
  - With 1 column: theoretically 10M rows
  - **Real-world:** Struggles above 100K rows with noticeable lag
- **Excel Desktop:** 1,048,576 rows x 16,384 columns per worksheet (hard limit since Excel 2007)
- **Excel Online:** Same row limit as desktop but significantly slower; practical performance ceiling is lower
- **Positioning:** Neither claims to be a "big data" tool

### Airtable
- **Hard row limits by plan:**
  - Free: 1,000 records per base (was recently 1,200)
  - Team ($20/user/mo): 50,000 records
  - Business ($45/user/mo): 125,000 records
  - Enterprise Scale: 500,000+ records (with HyperDB)
- **Enforcement:** Hard limits. Exceed and you're forced to upgrade immediately. No overages.
- **Positioning:** Not a big data tool. Database for teams. They don't market on row count -- they market on collaboration and workflow.

### Flatfile
- **Architecture:** Browser + server-side processing hybrid
- **Default preload:** 1,000 rows
- **Performance claims:** "Massive files with hundreds of thousands of rows moving through with ease"
- **Strategy:** Workers dynamically scale as files increase; parallel processing for large files
- **Positioning:** Data onboarding platform, not a data processing tool. Focused on import UX, not analysis.

---

## 2. Adjacent Competitors Worth Noting

### Row Zero
- **Claimed limit:** 1 billion rows on Enterprise plans (1000x Excel)
- **Architecture:** Cloud-based -- each workbook gets a dedicated EC2 instance
- **Performance:** "~30ms latency" from browser
- **Reality:** NOT client-side. Server does all processing. Browser is a thin client.
- **Positioning:** "World's fastest and most powerful spreadsheet"

### OneSchema (Flatfile competitor)
- **Claimed limit:** "Performantly handle files up to 10M rows"
- **Performance:** "Validate and transform files of up to 4GB in under 1 second"
- **Architecture:** In-memory architecture (server-side)
- **Tested at:** 1K, 10K, 100K, 1M, 10M rows with 11 columns

### Dromo (Flatfile competitor)
- **Architecture:** WebAssembly-powered engine in embedded importer
- **Claim:** "Handle multi-million row files without choking"
- **Reality:** After 200 rows, significant client-side resource demands with earlier versions

### Gigasheet
- **Claimed limit:** 1 billion rows, 250GB+ files
- **Architecture:** Cloud-based, not client-side
- **Performance:** "Millions of rows in not more than ten seconds; SUM operation ~8 seconds"
- **Positioning:** "Big data cloud spreadsheet"

### Glide Data Grid (CleanSlate's grid library)
- **Claimed limit:** "Scrolling 100 million rows without dropping frames"
- **Architecture:** HTML Canvas rendering, lazy cell loading
- **Performance:** 100-1000x faster than DOM-based grids
- **Reality:** This is the rendering layer only. It doesn't process data -- it renders what you feed it via callbacks. The 100M claim is about scroll rendering, not data processing.

---

## 3. The Hard Truth: Browser Memory Ceiling

### WebAssembly Memory Limits
- **Chrome:** 4GB per tab (WASM memory limit)
- **WASM spec v3.0 (Dec 2025):** Max 16GB via JavaScript API, but browser engines haven't fully optimized 64-bit pointers
- **DuckDB WASM:** Single-threaded (historical SharedArrayBuffer limitation), experimental multi-thread support
- **Practical ceiling:** ~3-5M rows depending on column count and data types

### What 4GB Actually Means
- DuckDB WASM binary: 3.5MB
- 1M rows x 10 columns x 50 bytes avg = ~500MB raw
- Query intermediate results, indexes, WASM overhead eat another 1-2GB
- Practical safe zone: **1-3M rows for transforms, 3-5M for read-only queries**

### DuckDB WASM Benchmark Numbers (1M rows, Bandcamp dataset)
| Operation | DuckDB WASM | SQLite WASM | Arquero |
|-----------|------------|-------------|---------|
| Aggregate (count, mean, total) | 0.014ms | 0.103ms | 0.067ms |
| Group by day | 0.163ms | 0.005ms (indexed) | 1.05ms |
| Window function (top 5) | 0.114ms | 0.165ms | N/A |
| Insert 1000 rows | 1.397ms | 0.041ms | N/A |
| Delete 1000 rows | 2.376ms | 0.035ms | N/A |

**Key insight:** DuckDB dominates analytical queries. SQLite dominates transactional (insert/delete) operations. This matters for CleanSlate, which does both.

---

## 4. Market Positioning Summary

### Tier 1: "We handle millions" (but server-side)
| Tool | Claimed Rows | Actually Client-Side? |
|------|-------------|----------------------|
| Row Zero | 1 billion | No (EC2 backend) |
| Gigasheet | 1 billion | No (cloud) |
| OneSchema | 10M | No (server) |
| Rill Data | 100M+ | No (desktop DuckDB) |

### Tier 2: "We handle millions" (client-side, with caveats)
| Tool | Claimed Rows | Evidence? |
|------|-------------|-----------|
| Quadratic | "Millions" | No benchmarks published |
| DuckDB WASM (raw) | 3M+ demonstrated | Yes (academic paper + community benchmarks) |
| Perspective | "Ludicrous" | 864K in benchmarks |
| Observable + DuckDB | 5.2M queried | Yes (but read-only, aggregated for display) |

### Tier 3: Hard limits well below 1M
| Tool | Hard Limit |
|------|-----------|
| Google Sheets | 10M cells (~100K rows practical) |
| Excel | 1,048,576 rows |
| Airtable | 500K max (Enterprise) |
| Flatfile | Hundreds of thousands |
| Datasette Lite | Memory-limited, 1K rows per result |

---

## 5. Implications for CleanSlate Pro

### Where CleanSlate sits
CleanSlate uses DuckDB-WASM + Glide Data Grid. Based on this research:

1. **The 1M row claim is defensible.** DuckDB WASM has been benchmarked at 1M+ rows with sub-second query performance. Glide Data Grid claims 100M row scroll rendering.

2. **Nobody else does client-side data TRANSFORMATION at scale.** Every tool that claims millions of rows either (a) does it server-side, (b) does read-only analytics, or (c) doesn't actually benchmark it. CleanSlate's combination of local-first + transforms + undo/redo at this scale is genuinely differentiated.

3. **The practical ceiling is ~1-3M rows for transformations** due to the 4GB WASM memory constraint. Read-only queries can go higher.

4. **The competitive gap is real.** Airtable caps at 500K. Google Sheets struggles at 100K. Excel caps at ~1M but is desktop-only. No browser-based tool does what CleanSlate does at this scale.

### Honest positioning language
- **Safe claim:** "Handle datasets with 100K+ rows entirely in your browser -- no server, no cloud, no data leaves your machine"
- **Aggressive claim:** "Process million-row datasets locally in your browser with sub-second transforms"
- **Differentiated claim:** "The only local-first data cleaning tool that handles 1M+ rows with full undo/redo -- while your data never leaves the browser"

### Risk factors
- 4GB Chrome WASM memory limit is the hard ceiling; 16GB WASM spec exists but isn't practical yet
- DuckDB WASM is single-threaded (performance won't scale linearly)
- Tier 3 undo (snapshot restore) gets expensive at >500K rows
- Parquet persistence via OPFS adds I/O overhead at scale
