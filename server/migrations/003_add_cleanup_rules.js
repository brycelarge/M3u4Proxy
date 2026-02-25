export function up(db) {
  // Check if cleanup_rules column exists
  const columns = db.prepare("PRAGMA table_info(sources)").all()
  const hasCleanupRules = columns.some(col => col.name === 'cleanup_rules')
  
  if (!hasCleanupRules) {
    db.prepare('ALTER TABLE sources ADD COLUMN cleanup_rules TEXT').run()
    console.log('[Migration 003] Added cleanup_rules column to sources')
  } else {
    console.log('[Migration 003] cleanup_rules column already exists, skipping')
  }
}

export function down(db) {
  // SQLite doesn't support DROP COLUMN easily, so we skip rollback
  console.log('[Migration 003] Rollback not implemented for cleanup_rules')
}
