# Product Requirements Document (PRD): CleanSlate
**Version:** 3.3 (System Guardrails Edition)
**Status:** Approved
**Tech Stack:** React (Vite) + DuckDB-WASM + Glide Data Grid + OPFS

---

## 1. Executive Summary
**CleanSlate** is a local-first, "Zero-Trust" data operations suite designed for regulated industries (Healthcare, Legal, Finance). It allows users to clean, reconcile, deduplicate, **join**, and **obfuscate** sensitive datasets entirely within the browser. By bypassing the need for server uploads or software installation, it provides a "Compliance Safety Net" for professionals who need to manipulate data on locked-down corporate machines.



## 2. Technical Architecture

| Component | Technology | Role |
| :--- | :--- | :--- |
| **Frontend Framework** | React (Vite) + TypeScript | Core UI and application logic. |
| **Data Engine** | **DuckDB-WASM** | In-browser SQL engine for querying/transforming data. |
| **Data Grid** | **Glide Data Grid** | Canvas-based grid for high-performance scrolling (100k+ rows). |
| **Persistence** | **OPFS** (Origin Private File System) | Local storage for large files (persistence across reloads). |
| **State Management** | Zustand | Managing UI state (filters, active tabs, undo stack). |
| **Obfuscation** | Web Crypto API (SHA-256) | Secure, consistent hashing using user-provided salts. |
| **Licensing** | JWT (RSA) + Static Key | Hybrid model: "Spotify Style" (30-day offline token) OR "Enterprise Key" (100% air-gapped). |

---

## 3. User Personas & Scenarios

### 3.1 The "Shadow" Paralegal
* **User:** Prepping a witness list for discovery.
* **Pain:** Needs to redact 5,000 phone numbers and names. Cannot install software. Excel is too slow/risky.
* **Workflow:** Loads CleanSlate -> Auto-Masks PII -> Exports "Sanitized_List.csv" + "Audit_Log.pdf".

### 3.2 The Healthcare Ops Analyst
* **User:** Merging patient lists from two different hospital systems.
* **Pain:** Needs to de-identify patients (Safe Harbor) but still link records by MRN.
* **Workflow:** Sets a "Project Secret" -> Hashes MRNs (consistently) -> Merges duplicates -> Exports de-identified file for vendor.

---

## 4. Functional Requirements

### Module A: The Data Laundromat (Ingestion & Cleaning)
* **FR-A1:** Support drag-and-drop for `.csv`, `.xlsx`, `.json`, and `.parquet`.
* **FR-A2:** Stream data directly to OPFS/DuckDB to avoid crashing the main thread JS Heap.
* **FR-A3: Context-Aware Transformation Sidebar:** 🔶 **PARTIAL**
    * UI must display actions relevant to the selected column's data type.
    * **Text Columns (Implemented):**
        * ✅ **Trim Whitespace:** `trim(col)`
        * ✅ **Uppercase/Lowercase:** Case transformations
        * ✅ **Find & Replace:** Case-sensitive/insensitive, exact/contains match
        * ✅ **Remove Duplicates:** Deduplicate entire rows
        * ✅ **Filter Empty:** Remove rows with null/empty values
        * ✅ **Rename Column:** Change column name
        * ✅ **Cast Type:** Convert to Integer, Date
        * ✅ **Custom SQL:** Arbitrary SQL transformations
    * **Text Columns (Pending - TDD tests written):**
        * 🔲 **Collapse Spaces:** `regexp_replace(col, '\s+', ' ', 'g')`
        * 🔲 **Remove Non-Printable:** Remove tabs, newlines, zero-width chars.
        * 🔲 **Remove Accents:** `José` -> `Jose`.
        * 🔲 **Title Case:** "John Smith" (Capitalize first letter of words).
        * 🔲 **Sentence case:** "Patient arrived at..."
        * 🔲 **Split Column:** By delimiter (comma, space) or extract domain (email).
    * **Number Columns (Finance Focus) - Pending:**
        * 🔲 **Unformat Currency:** Remove `$, £, ,` and cast to Decimal.
        * 🔲 **Fix Negatives:** Convert `(500.00)` to `-500.00`.
        * 🔲 **Pad Zeros:** `501` -> `00501` (Crucial for IDs/Zips).
        * 🔲 **Fill Down:** Copy value from row above if null.
    * **Date Columns (Healthcare Focus) - Pending:**
        * 🔲 **Standardize Format:** ISO 8601 (`YYYY-MM-DD`).
        * 🔲 **Calculate Age:** New column diffing `DOB` vs `Today`.
        * 🔲 **Shift Date:** Add/Subtract random N days (Anonymization).
* **FR-A4: Manual Remediation (Cell Editing):** ✅ **IMPLEMENTED**
    * **Double-Click Edit:** Support value-only edits (Text/Number/Boolean). No formulas.
    * **Dirty State:** Visually highlight manually edited cells (e.g., small red triangle or background tint).
    * **Undo Stack:** `Ctrl+Z` support for at least 10 steps.
    * **Audit Integration:** **CRITICAL.** Every manual edit must trigger an entry in the Audit Log with `Previous_Value` and `New_Value`.
* **FR-A5: Granular Transformation Audit Log:** ✅ **IMPLEMENTED**
    * **Requirement:** The system must maintain a linear, immutable history of all changes.
    * **Granularity Level:**
        * **Type A (Bulk Ops):** Logs the Action, Target Column, and **Count** of rows modified.
            * *Example:* `[14:05:00] Applied 'Trim Whitespace' to Col 'Email'. Impact: 450 rows.`
            * **Row-Level Details:** Click audit entry to view modal with affected rows (before/after values).
            * **Supported Transformations:** Trim, Uppercase, Lowercase, Replace, Title Case, Remove Accents, Remove Non-Printable, Unformat Currency, Fix Negatives, Pad Zeros, Standardize Date, Calculate Age, Fill Down, Cast Type, Filter Empty (shows deleted rows).
            * **Performance:** Uses native `INSERT INTO SELECT` for ~10x faster audit capture on large datasets (100k+ rows).
        * **Type B (Manual Edits):** Logs the Action, Target Row (ID), and **Value Change**.
            * *Example:* `[14:06:22] Manual Edit on Row #104, Col 'Status'. Value: 'Pennding' -> 'Pending'.`
    * **Export:** User can download this log as a timestamped PDF or Text file. Row details exportable as CSV.
* **FR-A6: The Ingestion Wizard (Crucial for Legacy Data):** ✅ **IMPLEMENTED**
    * **Trigger:** On drag-and-drop of any file.
    * **UI:** Modal showing first 50 lines of raw text.
    * **Controls:**
        * "Header Row": User selects which row contains column names (Default: Row 1).
        * "Encoding": Auto-detect (UTF-8 vs Latin-1) but allow manual override.
        * "Delimiter": Auto-detect but allow override (Comma, Tab, Pipe).
    * **Why:** Prevents "Garbage In" from older reporting systems.

* **FR-A7: Data Health Sidebar (The "Sanity Check"):** 🔲 **NOT IMPLEMENTED**
    * **Trigger:** Selecting any column header.
    * **Display:** DuckDB `SUMMARIZE` stats for that column.
    * **Metrics:**
        * *All Types:* Null Count, Unique Count (% Distinct).
        * *Numeric:* Min, Max, Average, Distribution Histogram (Small SVG).
        * *Text:* Min Length, Max Length, Top 5 Most Common Values.
    * **Why:** Guides the user on *what* to clean.
    * **Test Coverage:** None (no tests written).

### Module B: The Visual Diff (Reconciliation) ✅ **IMPLEMENTED**
* **FR-B1:** User selects two loaded tables to compare (e.g., "Old Version" vs "New Version"). ✅
* **FR-B2:** System executes a `FULL OUTER JOIN` to determine `ADDED`, `REMOVED`, or `MODIFIED` status. ✅
    * ✅ **Compare Two Tables mode:** Select any two tables for comparison.
    * ✅ **Compare with Preview mode:** Compare current table state vs. original state.
    * ✅ **Optimized for 2M+ rows:** Temp table + virtualized grid (Glide Data Grid).
    * ✅ **Streaming export:** Chunked export for large datasets.
* **FR-B3:** Render Logic (Glide Data Grid): ✅
    * **Green Background:** Row exists in File B but not A.
    * **Red Background:** Row exists in File A but not B.
    * **Yellow Highlight:** Cell value mismatch.
* **FR-B4: Blind Diff Support:** 🔲 **NOT IMPLEMENTED** (no tests written)
    * Allow diffing on *hashed* columns to find overlap without revealing raw data.

### Module C: The Fuzzy Matcher (Deduplication) ✅ **IMPLEMENTED**
* **FR-C1: Blocking Strategy (Crucial):** ✅ **IMPLEMENTED**
    * ✅ Blocking strategies: First Letter, Double Metaphone, N-gram.
    * ✅ Chunked multi-pass matching for scalability (handles 100K+ rows).
    * ✅ Similarity scoring with field-level breakdown.
    * ✅ Row selection UI with merge/keep separate actions.
    * ✅ Audit log drill-down for merge operations.
* **FR-C2: "Tinder" Review UI:** 🔶 **PARTIAL**
    * Card-based UI exists for reviewing matches.
    * 🔲 Keyboard shortcuts (Left/Right) not implemented.
* **FR-C3: Clean-First Workflow:** 🔲 **NOT IMPLEMENTED** (no tests written)
    * Ensure deduplication happens *before* obfuscation.



### Module D: The Smart Scrubber (Obfuscation) 🔶 **UI SHELL ONLY**
* **FR-D1: Project Secret (The Salt):** 🔲 **NOT IMPLEMENTED** (no tests written)
    * Input field for a "Secret Phrase." Logic: `SHA256(Column_Value + Secret_Phrase)`.
    * Ensures referential integrity across sessions.
* **FR-D2: Type-Specific Obfuscation Options:** 🔲 **NOT IMPLEMENTED** (TDD tests written)
    * **String:** `Redact` ([REDACTED]), `Mask` (J***n D*e), `Hash` (SHA-256), `Faker` ("Jane Doe").
    * **Number/ID:** `Scramble` (Shuffle digits), `Last 4` (***-**-1234), `Zero` (0000).
    * **Date:** `Year Only` (1980-01-01), `Jitter` (Random +/- days), `Redact`.
* **FR-D3: Key Map Export:** 🔲 **NOT IMPLEMENTED** (no tests written)
    * Checkbox on Export: *"Generate Key Map?"* (CSV with `Original, Obfuscated` pairs).

### Module E: The Combiner (Joins & Unions) ✅ **IMPLEMENTED**
* **FR-E1: Stack Files (Union All):** ✅
    * **User Action:** Select 2+ files -> Click "Stack".
    * **Logic:** System aligns columns by header name.
    * **Validation:** Warn if headers don't match (e.g., "File A has 'Email', File B has 'E-mail'").
* **FR-E2: Merge Files (VLOOKUP / Joins):** ✅
    * **UI:** "Left Side" (Base Table) vs. "Right Side" (Lookup Table).
    * **Key Selection:** User selects the common column (e.g., `Patient_ID`).
    * **Join Types (User Facing Names):**
        * "Lookup" (Left Join) - *Default*. ✅
        * "Keep Only Matches" (Inner Join). ✅
        * "Keep Everything" (Full Outer Join). 🔲 (not tested)
* **FR-E3: The "Clean-First" Guardrail:** 🔲 **NOT IMPLEMENTED** (no tests written)
    * **Constraint:** System must warn user if they try to join without cleaning key columns first.
    * **Feature:** "Auto-Clean Keys" button in the Join modal (Trims whitespace & casts types on both sides automatically before joining).

### Module F: Value Standardization (Clustering) ✅ **IMPLEMENTED**
* **FR-F1: Clustering Algorithms:** ✅
    * ✅ **Fingerprint:** Normalize case, whitespace, punctuation for grouping.
    * ✅ **Metaphone:** Phonetic clustering for similar-sounding values.
* **FR-F2: Cluster Management UI:** ✅
    * ✅ Cluster list with value counts and selection checkboxes.
    * ✅ Bulk Select All / Deselect All controls.
    * ✅ Master value auto-suggestion (most frequent value).
    * ✅ Manual master value override.
* **FR-F3: Apply Standardization:** ✅
    * ✅ Update selected values to master value in-place.
    * ✅ Audit log integration with row counts.

---

## 5. Non-Functional Requirements & Limitations

### 5.1 Performance Limits (Stability Guardrails)
**Requirement:** The system must actively poll resource usage and check file sizes before expensive operations.
* **Memory Watchdog:** Poll `performance.memory` every 5 seconds. If usage > 80%, trigger global warning banner: *"High Memory Usage - Please Save & Reload."*

**The Guardrail Table (Hard Enforcement):**

| Feature | Safe Row Limit | Safe Size Limit | Logic/Reason | UI Action When Exceeded |
| :--- | :--- | :--- | :--- | :--- |
| **Ingestion** | **2,000,000 Rows** | ~2.0 GB | 2M rows is the 60fps scrolling limit. | **Warn:** *"File is large. Performance may be slower."* (Allow proceed). |
| **Visual Diff** | **2,000,000 Rows** | ~2.0 GB (A+B) | Optimized with temp table + virtualized grid. Only loads 500 rows at a time. | **Allow proceed.** Performance tested at 100K+ rows. |
| **Fuzzy Match** | **500,000 Rows** | ~500 MB | Chunked multi-pass matching with blocking strategies. | **Force Strict Blocking.** Disable "Loose" matching options; require blocking strategy. |
| **Excel Export** | **100,000 Rows** | ~50 MB | Generating `.xlsx` XML tree crashes the browser. | **Force CSV.** Hide `.xlsx` option. Msg: *"Datasets >100k rows must export as CSV."* |
| **Audit Log** | **Unlimited** | N/A | Text logs are negligible in size. | **No Action.** Always allow export. |

### 5.2 Offline & Persistence
* **Service Worker:** Cache assets for 100% offline use.
* **Data Durability:** Warn user: "Clearing Browser Data will delete your saved files."

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **Lost Salt** | User cannot join data later. | **UX Warning:** "Write this secret down. It is not saved." |
| **Liability** | User misuses "Compliance" tools. | **Disclaimer:** "Tool assists with de-identification but does not guarantee legal compliance." |
| **Browser Crash** | Large Excel export freezes UI. | **Auto-Switch:** Force CSV for >100k rows (See Guardrails). |
| **UI Freeze** | Heavy SQL queries lock main thread. | **Web Workers:** Run DuckDB strictly in a background worker. |