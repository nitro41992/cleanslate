/**
 * ChunkManager -- Smart Pointer Utility for Shard-Based Data Access
 *
 * Shared utility that all engines (diff, transform, combine) use to access
 * chunk-backed snapshot data without loading full tables into DuckDB.
 *
 * Key behaviors:
 * - Dynamic row-budget LRU (150k row cap, not fixed shard count)
 * - Handles legacy 100k-250k chunks safely (only 1 at a time)
 * - Aggressive yielding between shard load/evict (browser stays responsive)
 * - Registers with memory-manager for pressure-based cleanup
 * - Temp table naming: __chunk_{snapshotId}_{shardIndex}
 */

import { CHUNK_MANAGER_ROW_LIMIT } from '@/lib/constants'
import { readManifest, type SnapshotManifest, type ShardInfo } from './manifest'
import { importSingleShard } from './snapshot-storage'
import { initDuckDB, getConnection } from '@/lib/duckdb'
import { registerMemoryCleanup } from '@/lib/memory-manager'
import { yieldToMain } from '@/lib/utils/yield-to-main'

/**
 * Cached shard entry in the LRU.
 */
interface CachedShard {
  /** DuckDB temp table name */
  tableName: string
  /** Snapshot this shard belongs to */
  snapshotId: string
  /** Shard index within the snapshot */
  shardIndex: number
  /** Number of rows in this shard */
  rowCount: number
  /** Last access timestamp (for LRU eviction) */
  lastAccess: number
}

/**
 * Result from mapChunks() callback.
 */
export interface MapChunkResult<T> {
  results: T[]
  shardsProcessed: number
}

/**
 * Singleton ChunkManager instance.
 */
let instance: ChunkManager | null = null

/**
 * Get the singleton ChunkManager instance.
 * Creates it on first access and registers with memory manager.
 */
export function getChunkManager(): ChunkManager {
  if (!instance) {
    instance = new ChunkManager()
  }
  return instance
}

export class ChunkManager {
  /** LRU cache: key = "snapshotId:shardIndex" -> CachedShard */
  private lru = new Map<string, CachedShard>()
  /** Total rows currently loaded in DuckDB via this manager */
  private currentResidentRows = 0
  /** Maximum rows to keep resident */
  private readonly rowLimit: number
  /** Manifest cache to avoid repeated OPFS reads */
  private manifestCache = new Map<string, SnapshotManifest>()

  constructor(rowLimit?: number) {
    this.rowLimit = rowLimit ?? CHUNK_MANAGER_ROW_LIMIT

    // Register cleanup callback for memory pressure
    registerMemoryCleanup('chunk-manager', async () => {
      console.log(`[ChunkManager] Memory pressure -- evicting all ${this.lru.size} shards`)
      await this.evictAll()
    })
  }

  /**
   * Get a snapshot manifest, with caching to avoid repeated OPFS reads.
   */
  async getManifest(snapshotId: string): Promise<SnapshotManifest> {
    const cached = this.manifestCache.get(snapshotId)
    if (cached) return cached

    const manifest = await readManifest(snapshotId)
    if (!manifest) {
      throw new Error(`[ChunkManager] No manifest found for snapshot: ${snapshotId}`)
    }

    this.manifestCache.set(snapshotId, manifest)
    return manifest
  }

  /**
   * Clear the manifest cache (call when manifests may have changed).
   */
  clearManifestCache(): void {
    this.manifestCache.clear()
  }

  /**
   * Build a cache key for a shard.
   */
  private cacheKey(snapshotId: string, shardIndex: number): string {
    return `${snapshotId}:${shardIndex}`
  }

  /**
   * Build the DuckDB temp table name for a shard.
   */
  private tempTableName(snapshotId: string, shardIndex: number): string {
    // Sanitize snapshotId for SQL identifier safety
    const safe = snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')
    return `__chunk_${safe}_${shardIndex}`
  }

  /**
   * Load a single shard into DuckDB, evicting old shards if over row budget.
   * Returns the DuckDB temp table name containing the shard data.
   *
   * If the shard is already loaded, returns immediately (LRU touch).
   */
  async loadShard(snapshotId: string, shardIndex: number): Promise<string> {
    const key = this.cacheKey(snapshotId, shardIndex)

    // Already loaded -- just update access time
    const existing = this.lru.get(key)
    if (existing) {
      existing.lastAccess = Date.now()
      return existing.tableName
    }

    // Get shard metadata from manifest
    const manifest = await this.getManifest(snapshotId)
    const shardInfo = manifest.shards[shardIndex]
    if (!shardInfo) {
      throw new Error(
        `[ChunkManager] Shard ${shardIndex} not found in manifest for ${snapshotId} (${manifest.shards.length} shards total)`
      )
    }

    // Evict until we have room for this shard
    while (this.currentResidentRows + shardInfo.rowCount > this.rowLimit && this.lru.size > 0) {
      await this.evictOldest()
      await yieldToMain() // Yield between evictions
    }

    // Load shard into DuckDB
    const tableName = this.tempTableName(snapshotId, shardIndex)
    const db = await initDuckDB()
    const conn = await getConnection()

    await importSingleShard(db, conn, snapshotId, shardIndex, tableName)

    // Track in LRU
    this.lru.set(key, {
      tableName,
      snapshotId,
      shardIndex,
      rowCount: shardInfo.rowCount,
      lastAccess: Date.now(),
    })
    this.currentResidentRows += shardInfo.rowCount

    console.log(
      `[ChunkManager] Loaded shard ${snapshotId}:${shardIndex} ` +
      `(${shardInfo.rowCount} rows, resident: ${this.currentResidentRows}/${this.rowLimit})`
    )
    return tableName
  }

  /**
   * Evict a specific shard from DuckDB.
   */
  async evictShard(snapshotId: string, shardIndex: number): Promise<void> {
    const key = this.cacheKey(snapshotId, shardIndex)
    const cached = this.lru.get(key)
    if (!cached) return

    try {
      const conn = await getConnection()
      await conn.query(`DROP TABLE IF EXISTS "${cached.tableName}"`)
    } catch (err) {
      console.warn(`[ChunkManager] Failed to drop ${cached.tableName}:`, err)
    }

    this.currentResidentRows -= cached.rowCount
    this.lru.delete(key)
  }

  /**
   * Evict the oldest (least recently accessed) shard.
   */
  private async evictOldest(): Promise<void> {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.lru) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess
        oldestKey = key
      }
    }

    if (oldestKey) {
      const entry = this.lru.get(oldestKey)!
      await this.evictShard(entry.snapshotId, entry.shardIndex)
    }
  }

  /**
   * Evict ALL loaded shards. Call when an operation completes to free memory.
   */
  async evictAll(): Promise<void> {
    const conn = await getConnection()

    for (const [, entry] of this.lru) {
      try {
        await conn.query(`DROP TABLE IF EXISTS "${entry.tableName}"`)
      } catch (err) {
        console.warn(`[ChunkManager] Failed to drop ${entry.tableName}:`, err)
      }
    }

    const evictedCount = this.lru.size
    this.lru.clear()
    this.currentResidentRows = 0

    if (evictedCount > 0) {
      console.log(`[ChunkManager] Evicted all ${evictedCount} shard(s)`)
    }
  }

  /**
   * Process all shards of a snapshot sequentially, calling a callback for each.
   *
   * This is the main API for engines that need to iterate over all data shard-by-shard.
   * After each shard callback, the shard is evicted and we yield to the browser.
   *
   * @param snapshotId - Snapshot to iterate
   * @param callback - Called for each shard with (tempTableName, shardInfo, index)
   * @returns Results from all callbacks plus shard count
   */
  async mapChunks<T>(
    snapshotId: string,
    callback: (tempTable: string, shard: ShardInfo, index: number) => Promise<T>
  ): Promise<MapChunkResult<T>> {
    const manifest = await this.getManifest(snapshotId)
    const results: T[] = []

    for (let i = 0; i < manifest.shards.length; i++) {
      const shard = manifest.shards[i]

      // Load shard
      const tempTable = await this.loadShard(snapshotId, i)

      try {
        // Execute callback
        const result = await callback(tempTable, shard, i)
        results.push(result)
      } finally {
        // Evict shard after processing (don't hold memory across iterations)
        await this.evictShard(snapshotId, i)
      }

      // Yield to browser between shards
      await yieldToMain()
    }

    return {
      results,
      shardsProcessed: manifest.shards.length,
    }
  }

  /**
   * Get the shard index and local offset for a given global row range.
   * Used for row-range lookups (e.g., grid pagination).
   *
   * @param snapshotId - Snapshot to look up
   * @param startRow - Global row index (0-based)
   * @param endRow - Global row index (exclusive)
   * @returns Info about which shard(s) to load and local offsets
   */
  async getRowRange(
    snapshotId: string,
    startRow: number,
    endRow: number
  ): Promise<Array<{ shardIndex: number; localOffset: number; localLimit: number }>> {
    const manifest = await this.getManifest(snapshotId)
    const ranges: Array<{ shardIndex: number; localOffset: number; localLimit: number }> = []

    let cumulativeRows = 0
    for (const shard of manifest.shards) {
      const shardStart = cumulativeRows
      const shardEnd = cumulativeRows + shard.rowCount

      if (startRow < shardEnd && endRow > shardStart) {
        // This shard overlaps with the requested range
        const localOffset = Math.max(0, startRow - shardStart)
        const localEnd = Math.min(shard.rowCount, endRow - shardStart)
        ranges.push({
          shardIndex: shard.index,
          localOffset,
          localLimit: localEnd - localOffset,
        })
      }

      cumulativeRows += shard.rowCount
      if (cumulativeRows >= endRow) break
    }

    return ranges
  }

  /**
   * Get current resident rows count (for diagnostics).
   */
  get residentRows(): number {
    return this.currentResidentRows
  }

  /**
   * Get current number of cached shards (for diagnostics).
   */
  get cachedShardCount(): number {
    return this.lru.size
  }
}
