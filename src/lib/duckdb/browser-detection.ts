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

      // Check for FileSystemFileHandle.createSyncAccessHandle
      // This is required for DuckDB-WASM's OPFS backend
      // Chrome/Edge/Safari have it, Firefox does not
      if (typeof FileSystemFileHandle !== 'undefined') {
        supportsAccessHandle = 'createSyncAccessHandle' in FileSystemFileHandle.prototype
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
