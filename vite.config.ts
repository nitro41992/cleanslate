import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// NOTE: OPFS persistence is currently disabled due to DuckDB-WASM bug #2096
// https://github.com/duckdb/duckdb-wasm/issues/2096
// The COI bundle crashes with DataCloneError when using OPFS.
// The EH bundle only supports read-only OPFS without COI headers.
// Using in-memory mode until upstream fixes the issue.
//
// COI bundle (pthreads + SIMD) was tested but cannot be used because:
// Dynamic extension loading (Parquet) fails in pthread workers due to
// SharedArrayBuffer memory mismatch (LinkError: declared=0, imported=1).
// Parquet is required for CleanSlate's snapshot persistence layer.
// Revisit when DuckDB-WASM ships statically-linked Parquet in the COI bundle.

export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: {
    format: 'es',
  },
})
