export function up(db) {
  console.log('[Migration 010] Adding content_type column to source_channels and playlist_channels...')
  
  // Add content_type column to source_channels
  db.prepare(`ALTER TABLE source_channels ADD COLUMN content_type TEXT`).run()
  
  // Add content_type column to playlist_channels
  db.prepare(`ALTER TABLE playlist_channels ADD COLUMN content_type TEXT`).run()
  
  // Populate content_type based on group_title prefix
  const sourceResult = db.prepare(`
    UPDATE source_channels 
    SET content_type = CASE 
      WHEN group_title LIKE 'Movie:%' THEN 'movie'
      WHEN group_title LIKE 'Series:%' THEN 'series'
      ELSE 'live'
    END
  `).run()
  
  const playlistResult = db.prepare(`
    UPDATE playlist_channels 
    SET content_type = CASE 
      WHEN group_title LIKE 'Movie:%' THEN 'movie'
      WHEN group_title LIKE 'Series:%' THEN 'series'
      ELSE 'live'
    END
  `).run()
  
  // Create indexes for fast filtering
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_source_channels_content_type ON source_channels(content_type)`).run()
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_playlist_channels_content_type ON playlist_channels(content_type)`).run()
  
  console.log(`[Migration 010] Updated ${sourceResult.changes} source_channels rows`)
  console.log(`[Migration 010] Updated ${playlistResult.changes} playlist_channels rows`)
  console.log('[Migration 010] Created indexes on content_type columns')
}

export function down(db) {
  console.log('[Migration 010] Rollback not implemented - cannot remove columns in SQLite')
}
