/**
 * Migration: Add quality and normalized_name columns to source_channels
 * Date: 2026-02-24
 */

export const up = (db) => {
  console.log('[Migration 001] Adding quality and normalized_name columns to source_channels')
  
  // Check if columns already exist
  const columns = db.prepare("PRAGMA table_info(source_channels)").all()
  const hasQuality = columns.some(c => c.name === 'quality')
  const hasNormalized = columns.some(c => c.name === 'normalized_name')
  
  if (!hasQuality) {
    db.exec("ALTER TABLE source_channels ADD COLUMN quality TEXT DEFAULT ''")
    console.log('[Migration 001] Added quality column')
  }
  
  if (!hasNormalized) {
    db.exec("ALTER TABLE source_channels ADD COLUMN normalized_name TEXT DEFAULT ''")
    console.log('[Migration 001] Added normalized_name column')
  }
  
  console.log('[Migration 001] Complete')
}

export const down = (db) => {
  // SQLite doesn't support DROP COLUMN easily, so we skip rollback
  console.log('[Migration 001] Rollback not supported for ALTER TABLE ADD COLUMN in SQLite')
}
