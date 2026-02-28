export function up(db) {
  // Add group_selections column to store which groups are selected for this playlist
  db.exec(`
    ALTER TABLE playlists ADD COLUMN group_selections TEXT;
  `)
  console.log('[migration] Added group_selections column to playlists table')
}

export function down(db) {
  // SQLite doesn't support DROP COLUMN, so we'd need to recreate the table
  // For now, just leave the column
  console.log('[migration] Rollback not implemented for group_selections')
}
