/**
 * Shared Constants
 *
 * Constants used across multiple modules to ensure consistent behavior.
 */

/**
 * Row count threshold for "large dataset" handling.
 *
 * Used by:
 * - batch-executor.ts: Default batch size for LIMIT/OFFSET pagination
 * - timeline-engine.ts: Threshold for OPFS snapshots vs in-memory
 *
 * Rationale for 50,000:
 * - Large enough to minimize batch overhead
 * - Small enough to avoid memory pressure during transforms
 * - Aligns batch processing with snapshot strategy
 */
export const LARGE_DATASET_THRESHOLD = 50_000

/**
 * Maximum number of undo snapshots to keep per table.
 * Older snapshots are pruned to manage storage.
 */
export const MAX_SNAPSHOTS_PER_TABLE = 10

/**
 * Rows per shard in the micro-shard storage standard.
 *
 * Aligned with LARGE_DATASET_THRESHOLD. Each shard is ~25-50 MB in Arrow IPC,
 * small enough to load individually without memory pressure.
 *
 * Used by:
 * - snapshot-storage.ts: Shard size during export
 * - chunk-manager.ts: Row budget calculations
 */
export const SHARD_SIZE = 50_000

/**
 * Maximum total rows to keep resident in DuckDB via ChunkManager.
 *
 * For 50k-row shards: holds ~3 shards (150k rows).
 * For legacy 100k-250k chunks: holds 1 at a time.
 * This dynamic budget prevents OOM regardless of shard size.
 *
 * Used by:
 * - chunk-manager.ts: LRU eviction threshold
 */
export const CHUNK_MANAGER_ROW_LIMIT = 150_000
