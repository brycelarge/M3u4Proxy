export function up(db) {
  db.exec(`
    ALTER TABLE source_channels ADD COLUMN meta TEXT;
  `)
  console.log('[Migration 007] Added meta JSON column to source_channels')
}

export function down(db) {
  // SQLite doesn't support DROP COLUMN directly, would need to recreate table
  console.log('[Migration 007] Rollback not implemented for meta column')
}
