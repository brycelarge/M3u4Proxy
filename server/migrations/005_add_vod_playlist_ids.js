export function up(db) {
  console.log('[Migration 005] Adding vod_playlist_ids column for multiple VOD playlists per user')
  
  // Add new column for storing multiple VOD playlist IDs as JSON
  db.exec(`
    ALTER TABLE users ADD COLUMN vod_playlist_ids TEXT DEFAULT '[]';
  `)
  
  // Migrate existing vod_playlist_id values to the new column
  const users = db.prepare('SELECT id, vod_playlist_id FROM users WHERE vod_playlist_id IS NOT NULL').all()
  for (const user of users) {
    const ids = JSON.stringify([user.vod_playlist_id])
    db.prepare('UPDATE users SET vod_playlist_ids = ? WHERE id = ?').run(ids, user.id)
  }
  
  console.log('[Migration 005] Migrated', users.length, 'users to new vod_playlist_ids column')
}

export function down(db) {
  console.log('[Migration 005] Removing vod_playlist_ids column')
  
  // SQLite doesn't support DROP COLUMN directly, so we'd need to recreate the table
  // For now, just log that downgrade is not supported
  console.log('[Migration 005] Downgrade not supported - column will remain')
}
