# Product Requirements Document (PRD): CleanSlate
**Version:** 3.0 (Transformation & Operations Edition)
**Status:** Approved
**Tech Stack:** React (Vite) + DuckDB-WASM + Glide Data Grid + OPFS

---

## 1. Executive Summary
**CleanSlate** is a local-first, "Zero-Trust" data operations suite designed for regulated industries (Healthcare, Legal, Finance). It allows users to clean, reconcile, deduplicate, and **obfuscate** sensitive datasets entirely within the browser. By bypassing the need for server uploads or software installation, it provides a "Compliance Safety Net" for professionals who need to manipulate data on locked-down corporate machines.



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
* **FR-A3: Context-Aware Transformation Sidebar:**
    * UI must display actions relevant to the selected column's data type.
    * **Text Columns:**
        * **Trim Whitespace:** `trim(col)`
        * **Collapse Spaces:** `regexp_replace(col, '\s+', ' ', 'g')`
        * **Remove Non-Printable:** Remove tabs, newlines, zero-width chars.
        * **Remove Accents:** `José` -> `Jose`.
        * **Casing:**
            * `UPPERCASE`, `lowercase`.
            * `Title Case`: "John Smith" (Capitalize first letter of words). *Distinct from CamelCase.*
            * `Sentence case`: "Patient arrived at..."
        * **Split Column:** By delimiter (comma, space) or extract domain (email).
    * **Number Columns (Finance Focus):**
        * **Unformat Currency:** Remove `$, £, ,` and cast to Decimal.
        * **Fix Negatives:** Convert `(500.00)` to `-500.00`.
        * **Pad Zeros:** `501` -> `00501` (Crucial for IDs/Zips).
        * **Fill Down:** Copy value from row above if null.
    * **Date Columns (Healthcare Focus):**
        * **Standardize Format:** ISO 8601 (`YYYY-MM-DD`).
        * **Calculate Age:** New column diffing `DOB` vs `Today`.
        * **Shift Date:** Add/Subtract random N days (Anonymization).
* **FR-A4: Manual Remediation (Cell Editing):**
    * **Double-Click Edit:** Value-only edits (No formulas).
    * **Dirty State:** Visually highlight manually edited cells.
    * **Undo Stack:** `Ctrl+Z` support for at least 10 steps.
* **FR-A5: Transformation Audit Log:**
    * Every action (e.g., "Trim Whitespace on Col A") is recorded in a session log.
    * User can export a PDF/Text log certifying the cleaning steps performed.

### Module B: The Visual Diff (Reconciliation)
* **FR-B1:** User selects two loaded tables to compare (e.g., "Old Version" vs "New Version").
* **FR-B2:** System executes a `FULL OUTER JOIN` to determine `ADDED`, `REMOVED`, or `MODIFIED` status.
* **FR-B3:** Render Logic (Glide Data Grid):
    * **Green Background:** Row exists in File B but not A.
    * **Red Background:** Row exists in File A but not B.
    * **Yellow Highlight:** Cell value mismatch.
* **FR-B4: Blind Diff Support:** Allow diffing on *hashed* columns to find overlap without revealing raw data.

### Module C: The Fuzzy Matcher (Deduplication)
* **FR-C1: Blocking Strategy (Crucial):**
    * System must force a "Block" selection (e.g., "First Letter" or "Soundex") before allowing fuzzy matching to prevent $O(N^2)$ browser crash.
* **FR-C2: "Tinder" Review UI:**
    * Modal card stack. Keys: Right (Merge), Left (Keep Separate).
* **FR-C3: Clean-First Workflow:** Ensure deduplication happens *before* obfuscation.



### Module D: The Smart Scrubber (Obfuscation)
* **FR-D1: Project Secret (The Salt):**
    * Input field for a "Secret Phrase." Logic: `SHA256(Column_Value + Secret_Phrase)`.
    * Ensures referential integrity across sessions.
* **FR-D2: Type-Specific Obfuscation Options:**
    * **String:** `Redact` ([REDACTED]), `Mask` (J***n D*e), `Hash` (SHA-256), `Faker` ("Jane Doe").
    * **Number/ID:** `Scramble` (Shuffle digits), `Last 4` (***-**-1234), `Zero` (0000).
    * **Date:** `Year Only` (1980-01-01), `Jitter` (Random +/- days), `Redact`.
* **FR-D3: Key Map Export:**
    * Checkbox on Export: *"Generate Key Map?"* (CSV with `Original, Obfuscated` pairs).

---

## 5. Non-Functional Requirements & Limitations

### 5.1 Performance Limits (Stability Guardrails)
* **Memory Cap:** Monitor `performance.memory`. Warn at 80% usage.
* **Hard Limits:**
    * **Ingestion:** ~2M Rows / 2GB.
    * **Visual Diff:** ~1.5GB Combined (A+B). Disable button if exceeded.
    * **Fuzzy Match:** ~500k Rows (Require strict blocking).
    * **Excel Export:** < 100k Rows (Force CSV streaming for larger files).

### 5.2 Offline & Persistence
* **Service Worker:** Cache assets for 100% offline use.
* **Data Durability:** Warn user: "Clearing Browser Data will delete your saved files."

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **Lost Salt** | User cannot join data later. | **UX Warning:** "Write this secret down. It is not saved." |
| **Liability** | User misuses "Compliance" tools. | **Disclaimer:** "Tool assists with de-identification but does not guarantee legal compliance." |
| **Browser Crash** | Large Excel export freezes UI. | **Auto-Switch:** Force CSV for >100k rows. |
| **UI Freeze** | Heavy SQL queries lock main thread. | **Web Workers:** Run DuckDB strictly in a background worker. |