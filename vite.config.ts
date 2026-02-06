import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Cross-Origin Isolation (COI) is now ENABLED.
// Snapshot persistence migrated from Parquet to Arrow IPC, removing the Parquet extension
// dependency that previously blocked the COI bundle (LinkError: SharedArrayBuffer memory mismatch).
// The COI bundle provides pthreads + SIMD for 2-5x query performance via multi-threading.
//
// PRODUCTION DEPLOYMENT: These COOP/COEP headers must also be set at the server/CDN level
// (e.g., Cloudflare Workers, Netlify _headers, Vercel vercel.json) since the Vite plugin
// only applies to dev and preview servers.

/**
 * Vite plugin that sets Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.
 * Required for `crossOriginIsolated === true` which enables SharedArrayBuffer for pthreads.
 */
function crossOriginIsolationPlugin(): PluginOption {
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

export default defineConfig({
  plugins: [
    crossOriginIsolationPlugin(),
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
