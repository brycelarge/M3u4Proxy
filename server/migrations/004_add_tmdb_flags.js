/**
 * Migration: Add manual_override and blocked columns to tmdb_enrichment
 */

export function up(db) {
  console.log('[migration] Adding manual_override and blocked columns to tmdb_enrichment...')
  
  // Add manual_override column
  try {
    db.prepare('ALTER TABLE tmdb_enrichment ADD COLUMN manual_override INTEGER DEFAULT 0').run()
    console.log('[migration] Added manual_override column')
  } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e
    console.log('[migration] manual_override column already exists')
  }
  
  // Add blocked column
  try {
    db.prepare('ALTER TABLE tmdb_enrichment ADD COLUMN blocked INTEGER DEFAULT 0').run()
    console.log('[migration] Added blocked column')
  } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e
    console.log('[migration] blocked column already exists')
  }
  
  console.log('[migration] ✓ TMDB flags migration complete')
}

export function down(db) {
  // SQLite doesn't support DROP COLUMN easily, so we skip rollback
  console.log('[migration] Rollback not supported for column additions in SQLite')
}
