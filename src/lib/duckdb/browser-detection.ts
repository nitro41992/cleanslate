/**
 * Browser Detection Utility
 * Detects browser capabilities for OPFS support
 */

export interface BrowserCapabilities {
  browser: 'chrome' | 'edge' | 'safari' | 'firefox' | 'unknown'
  hasOPFS: boolean
  supportsAccessHandle: boolean
  version: string
}

/**
 * Detect browser capabilities for OPFS support
 * Chrome/Edge/Safari support OPFS with access handles
 * Firefox has OPFS but no sync access handles (required for DuckDB)
 */
export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  const ua = navigator.userAgent.toLowerCase()

  // Detect browser type
  let browser: BrowserCapabilities['browser'] = 'unknown'
  let version = ''

  if (ua.includes('edg/')) {
    browser = 'edge'
    version = ua.match(/edg\/([\d.]+)/)?.[1] || ''
  } else if (ua.includes('chrome') && !ua.includes('edg/')) {
    browser = 'chrome'
    version = ua.match(/chrome\/([\d.]+)/)?.[1] || ''
  } else if (ua.includes('safari') && !ua.includes('chrome')) {
    browser = 'safari'
    version = ua.match(/version\/([\d.]+)/)?.[1] || ''
  } else if (ua.includes('firefox')) {
    browser = 'firefox'
    version = ua.match(/firefox\/([\d.]+)/)?.[1] || ''
  }

  // Check for OPFS support
  let hasOPFS = false
  let supportsAccessHandle = false

  try {
    // Test if navigator.storage.getDirectory() exists
    if (typeof navigator.storage?.getDirectory === 'function') {
      hasOPFS = true

      // CRITICAL: createSyncAccessHandle is only available in Web Workers, NOT main thread
      // We cannot detect it here, but if crossOriginIsolated is true, it should work in the worker
      // See: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle

      // Check if we're cross-origin isolated (required for sync access handles)
      const isCrossOriginIsolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated

      if (isCrossOriginIsolated) {
        // Cross-origin isolated AND has OPFS = likely supports sync access handles in worker
        supportsAccessHandle = true
        console.log('[Browser Detection] Cross-origin isolated + OPFS available = assuming sync access handle support')
      } else {
        // Not cross-origin isolated = definitely won't work
        supportsAccessHandle = false
        console.log('[Browser Detection] Not cross-origin isolated = no sync access handle support')
      }
    }
  } catch (err) {
    console.warn('[Browser Detection] OPFS check failed:', err)
  }

  return {
    browser,
    hasOPFS,
    supportsAccessHandle,
    version,
  }
}
