export function up(db) {
  console.log('[Migration 015] Adding user_favorites table for MAG Portal favorites')
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('itv', 'vod', 'series')),
      channel_ids TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, content_type),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
  
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_favorites_user_type 
    ON user_favorites(user_id, content_type);
  `)
  
  console.log('[Migration 015] ✓ Added user_favorites table')
}

export function down(db) {
  console.log('[Migration 015] Removing user_favorites table')
  db.exec('DROP TABLE IF EXISTS user_favorites')
  db.exec('DROP INDEX IF EXISTS idx_user_favorites_user_type')
}
