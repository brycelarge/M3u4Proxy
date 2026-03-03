export function up(db) {
  console.log('[Migration 013] Adding content-type-specific fetch tracking to sources table')
  
  db.exec(`
    ALTER TABLE sources ADD COLUMN last_live_fetch TEXT;
    ALTER TABLE sources ADD COLUMN last_movie_fetch TEXT;
    ALTER TABLE sources ADD COLUMN last_series_fetch TEXT;
  `)
  
  // Migrate existing last_fetched to last_live_fetch for all sources
  db.exec(`
    UPDATE sources SET last_live_fetch = last_fetched WHERE last_fetched IS NOT NULL;
  `)
  
  console.log('[Migration 013] ✓ Added content-type fetch tracking columns')
}

export function down(db) {
  console.log('[Migration 013] Downgrade not supported for this migration')
}
