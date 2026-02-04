import React from 'react'
import ReactDOM from 'react-dom/client'
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

  import('./stores/matcherStore').then(({ useMatcherStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.matcherStore = useMatcherStore
  })

  import('./stores/timelineStore').then(({ useTimelineStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.timelineStore = useTimelineStore
  })

  import('./stores/diffStore').then(({ useDiffStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.diffStore = useDiffStore
  })

  import('./stores/standardizerStore').then(({ useStandardizerStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.standardizerStore = useStandardizerStore
  })

  import('./stores/uiStore').then(({ useUIStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.uiStore = useUIStore
  })

  import('./stores/editBatchStore').then(({ useEditBatchStore, setBatchWindow, isBatchingEnabled }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.editBatchStore = useEditBatchStore
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.setBatchWindow = setBatchWindow
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.isBatchingEnabled = isBatchingEnabled
  })

  import('./stores/recipeStore').then(({ useRecipeStore }) => {
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ =
      (window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__ || {}
    ;(window as Window & { __CLEANSLATE_STORES__?: Record<string, unknown> }).__CLEANSLATE_STORES__!.recipeStore = useRecipeStore
  })

  // Expose fuzzy matcher for E2E testing
  import('./lib/fuzzy-matcher').then((fuzzyMatcher) => {
    ;(window as Window & { __CLEANSLATE_FUZZY_MATCHER__?: typeof fuzzyMatcher }).__CLEANSLATE_FUZZY_MATCHER__ = fuzzyMatcher
  })

  import('./lib/duckdb').then(({ query, initDuckDB, resetConnection, checkConnectionHealth, flushDuckDB }) => {
    ;(window as Window & { __CLEANSLATE_DUCKDB__?: { query: typeof query; isReady: boolean; resetConnection: typeof resetConnection; checkConnectionHealth: typeof checkConnectionHealth; flushDuckDB: typeof flushDuckDB } }).__CLEANSLATE_DUCKDB__ = {
      query,
      resetConnection,
      checkConnectionHealth,
      flushDuckDB,
      isReady: false,
    }
    initDuckDB().then(() => {
      ;(window as Window & { __CLEANSLATE_DUCKDB__?: { query: typeof query; isReady: boolean; resetConnection: typeof resetConnection; checkConnectionHealth: typeof checkConnectionHealth; flushDuckDB: typeof flushDuckDB } }).__CLEANSLATE_DUCKDB__!.isReady = true
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
