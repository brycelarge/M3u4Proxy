export function up(db) {
  console.log('[Migration 006] Adding playlist_ids column for multiple live playlists per user')
  
  // Add new column for storing multiple playlist IDs as JSON
  db.exec(`
    ALTER TABLE users ADD COLUMN playlist_ids TEXT DEFAULT '[]';
  `)
  
  // Migrate existing playlist_id values to the new column
  const users = db.prepare('SELECT id, playlist_id FROM users WHERE playlist_id IS NOT NULL').all()
  for (const user of users) {
    const ids = JSON.stringify([user.playlist_id])
    db.prepare('UPDATE users SET playlist_ids = ? WHERE id = ?').run(ids, user.id)
  }
  
  console.log('[Migration 006] Migrated', users.length, 'users to new playlist_ids column')
}

export function down(db) {
  console.log('[Migration 006] Removing playlist_ids column')
  console.log('[Migration 006] Downgrade not supported - column will remain')
}
