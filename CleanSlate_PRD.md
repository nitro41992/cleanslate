# Product Requirements Document (PRD): CleanSlate
**Version:** 2.0 (Shadow IT Edition)
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
| **State Management** | Zustand | Managing UI state (filters, active tabs, diff modes). |
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
* **FR-A3:** **Transformation Audit Log (The Shield):**
    * *Requirement:* Every action (e.g., "Trim Whitespace on Col A") must be recorded in a session log.
    * *Export:* User can download a text/PDF log certifying: *"File X processed on [Date]. 3 columns redacted. 500 rows removed."*

### Module B: The Visual Diff (Reconciliation)
* **FR-B1:** User selects two loaded tables to compare (e.g., "Old Version" vs "New Version").
* **FR-B2:** System executes a `FULL OUTER JOIN` to determine `ADDED`, `REMOVED`, or `MODIFIED` status.
* **FR-B3:** Render Logic (Glide Data Grid):
    * **Green Background:** Row exists in File B but not A.
    * **Red Background:** Row exists in File A but not B.
    * **Yellow Highlight:** Cell value mismatch.
* **FR-B4:** **Blind Diff Support:** Allow diffing on *hashed* columns (e.g., compare two lists of hashed emails to find overlap without revealing emails).

### Module C: The Fuzzy Matcher (Deduplication)
* **FR-C1:** **Blocking Strategy (Crucial):**
    * System must force a "Block" selection (e.g., "First Letter" or "Soundex") before allowing fuzzy matching to prevent $O(N^2)$ browser crash.
* **FR-C2:** "Tinder" Review UI.
    * A dedicated modal card stack. Keyboard shortcuts: Right (Merge), Left (Keep Separate).
* **FR-C3:** **Clean-First Workflow:** Ensure deduplication happens *before* obfuscation (so "John Doe" and "John Doe " are merged before being hashed).

### Module D: The Smart Scrubber (Obfuscation)
* **FR-D1:** **Project Secret (The Salt):**
    * Input field for a "Secret Phrase."
    * Logic: `SHA256(Column_Value + Secret_Phrase)`.
    * *Why:* Ensures `Patient_123` always hashes to the same string across different sessions/files, preserving referential integrity.
* **FR-D2:** **Type-Specific Obfuscation Options:**
    * **String (Names/Emails):** `Redact` ([REDACTED]), `Mask` (J***n D*e), `Hash` (SHA-256), `Faker` (Replace with "Jane Doe").
    * **Number/ID (SSN/CC/MRN):** `Scramble` (Shuffle digits), `Last 4` (***-**-1234), `Zero` (0000).
    * **Date (DOB/DOS):** `Year Only` (1980-01-01), `Jitter` (+/- random N days), `Redact`.
* **FR-D3:** **Key Map Export:**
    * Checkbox on Export: *"Generate Key Map?"*
    * Output: A separate CSV containing `Original_Value, Obfuscated_Value` for reversibility (if legally needed).

---

## 5. Non-Functional Requirements & Limitations

### 5.1 Performance Limits
* **Memory Cap:** The app is bound by the browser's WASM memory limit (~4GB). Show "Memory Usage" bar.
* **Mobile Support:** Explicitly disabled (< 768px shows blocker).

### 5.2 Offline & Persistence
* **Service Worker:** Must cache all assets (WASM blob, HTML, JS) for 100% offline use.
* **Data Durability:** Warn user: "Clearing Browser Data will delete your saved files."

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **Lost Salt** | If a user forgets their "Project Secret," they cannot generate matching hashes again. | **UX Warning:** "Write this secret down. Without it, you cannot join this data with future files." |
| **Liability** | User claims "HIPAA Compliant" but uses the tool wrong. | **Disclaimer:** "This tool assists with de-identification but does not guarantee compliance. User is responsible for final review." |
| **Reversibility** | Hashed data might be brute-forced (Rainbow Table attack). | **Salt Enforcement:** Do not allow hashing without a complex salt string. |
| **UI Freeze** | Heavy SQL queries lock the browser. | **Web Workers:** Run DuckDB strictly in a background worker. |