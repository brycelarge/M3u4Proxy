export function up(db) {
  console.log('[Migration 011] Adding force_ts_extension column to sources table')
  
  db.exec(`
    ALTER TABLE sources ADD COLUMN force_ts_extension INTEGER DEFAULT 0;
  `)
  
  console.log('[Migration 011] ✓ Added force_ts_extension column')
}

export function down(db) {
  console.log('[Migration 011] Removing force_ts_extension column from sources table')
  
  // SQLite doesn't support DROP COLUMN directly, would need to recreate table
  // For now, just log that downgrade is not supported
  console.log('[Migration 011] Downgrade not supported for this migration')
}
