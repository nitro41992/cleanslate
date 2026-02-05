/**
 * Feature flags for controlling visibility of transforms and features.
 * These flags hide UI elements only - the underlying commands, recipes,
 * and timeline replay still support all transforms.
 */

export const ENABLE_CUSTOM_SQL = false

export const HIDDEN_TRANSFORMS = new Set([
  'custom_sql',
  'remove_accents',
  'remove_non_printable',
  'fill_down',
])
