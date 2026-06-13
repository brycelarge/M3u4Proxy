export function up(db) {
  console.log('[Migration 019] Adding playlist_id and sort_order to composite_streams')

  db.exec(`
    ALTER TABLE composite_streams ADD COLUMN playlist_id INTEGER;
    ALTER TABLE composite_streams ADD COLUMN sort_order INTEGER DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_composite_streams_playlist_id ON composite_streams(playlist_id);
  `)

  console.log('[Migration 019] ✓ Added playlist_id and sort_order to composite_streams')
}

export function down(db) {
  // SQLite does not support DROP COLUMN; manual rebuild would be required
  console.log('[Migration 019] Downgrade not supported for ALTER TABLE ADD COLUMN')
}
