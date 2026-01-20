import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { registerServiceWorker } from './lib/register-sw'

// Register service worker for offline support
if (import.meta.env.PROD) {
  registerServiceWorker().then((status) => {
    if (status.active) {
      console.log('[App] Offline support enabled')
    }
  })
}

// Expose stores and DuckDB for E2E testing (only in development)
if (import.meta.env.DEV) {
  import('./stores/tableStore').then(({ useTableStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.tableStore = useTableStore
  })

  import('./stores/auditStore').then(({ useAuditStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.auditStore = useAuditStore
  })

  import('./stores/editStore').then(({ useEditStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.editStore = useEditStore
  })

  import('./lib/duckdb').then(({ query, initDuckDB }) => {
    ;(window as Window & { __CLEANSLATE_DUCKDB__?: { query: typeof query; isReady: boolean } }).__CLEANSLATE_DUCKDB__ = {
      query,
      isReady: false,
    }
    initDuckDB().then(() => {
      ;(window as Window & { __CLEANSLATE_DUCKDB__?: { query: typeof query; isReady: boolean } }).__CLEANSLATE_DUCKDB__!.isReady = true
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
