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
 * - timeline-engine.ts: Threshold for Parquet snapshots vs in-memory
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
