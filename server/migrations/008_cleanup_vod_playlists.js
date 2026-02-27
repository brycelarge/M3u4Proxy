export function up(db) {
  // Delete all channels from VOD playlists (preserve Live TV playlists)
  const result = db.prepare(`
    DELETE FROM playlist_channels 
    WHERE playlist_id IN (
      SELECT id FROM playlists WHERE playlist_type = 'vod'
    )
  `).run()
  
  console.log(`[Migration 008] Deleted ${result.changes} channels from VOD playlists (Live TV preserved)`)
}

export function down(db) {
  console.log('[Migration 008] Rollback not possible - VOD playlist data was deleted')
}
