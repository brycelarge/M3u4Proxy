/**
 * Migration: Add priority column to sources table
 * Date: 2026-02-25
 */

export const up = (db) => {
  console.log('[Migration 002] Adding priority column to sources')
  
  // Check if column already exists
  const columns = db.prepare("PRAGMA table_info(sources)").all()
  const hasPriority = columns.some(col => col.name === 'priority')
  
  if (!hasPriority) {
    db.prepare('ALTER TABLE sources ADD COLUMN priority INTEGER DEFAULT 999').run()
    console.log('[Migration 002] Added priority column (default: 999)')
  } else {
    console.log('[Migration 002] Priority column already exists, skipping')
  }
}

export const down = (db) => {
  console.log('[Migration 002] Removing priority column from sources')
  // SQLite doesn't support DROP COLUMN easily, would need to recreate table
  console.log('[Migration 002] Skipping down migration (SQLite limitation)')
}
