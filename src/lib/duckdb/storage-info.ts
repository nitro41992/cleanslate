/**
 * Storage Info API
 * Provides storage backend info and quota monitoring for UI indicators
 */

import { detectBrowserCapabilities, type BrowserCapabilities } from './browser-detection'

export interface StorageQuota {
  usedBytes: number
  quotaBytes: number
  usagePercent: number
  isNearLimit: boolean  // true if >80%
}

export interface StorageInfo {
  backend: 'opfs' | 'memory'
  isPersistent: boolean
  isReadOnly: boolean
  estimatedSizeBytes: number | null
  browserSupport: BrowserCapabilities
  quota: StorageQuota | null
}

/**
 * Get storage information and quota status
 * Returns details about the DuckDB storage backend and browser quota
 */
export async function getStorageInfo(
  isPersistent: boolean,
  isReadOnly: boolean
): Promise<StorageInfo> {
  const browserSupport = await detectBrowserCapabilities()

  let estimatedSizeBytes: number | null = null
  let quota: StorageQuota | null = null

  if (isPersistent) {
    // Try to get OPFS file size
    try {
      const opfsRoot = await navigator.storage.getDirectory()
      const dbFileHandle = await opfsRoot.getFileHandle('cleanslate.db')
      const file = await dbFileHandle.getFile()
      estimatedSizeBytes = file.size
    } catch (err) {
      console.warn('[Storage Info] Could not get OPFS file size:', err)
    }

    // Get storage quota (Safari/Chrome quota management)
    try {
      if (typeof navigator.storage?.estimate === 'function') {
        const estimate = await navigator.storage.estimate()
        const usedBytes = estimate.usage || 0
        const quotaBytes = estimate.quota || 0

        quota = {
          usedBytes,
          quotaBytes,
          usagePercent: quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0,
          isNearLimit: quotaBytes > 0 && (usedBytes / quotaBytes) > 0.8,
        }
      }
    } catch (err) {
      console.warn('[Storage Info] Could not get storage quota:', err)
    }
  }

  return {
    backend: isPersistent ? 'opfs' : 'memory',
    isPersistent,
    isReadOnly,
    estimatedSizeBytes,
    browserSupport,
    quota,
  }
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}
