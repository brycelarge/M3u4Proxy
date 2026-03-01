export function up(db) {
  console.log('[Migration 004] Adding unique constraint on source_channels (source_id, url)')
  
  // Create new table with unique constraint
  db.exec(`
    CREATE TABLE source_channels_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      tvg_id          TEXT    DEFAULT '',
      tvg_name        TEXT    NOT NULL,
      tvg_logo        TEXT    DEFAULT '',
      group_title     TEXT    DEFAULT '',
      url             TEXT    NOT NULL,
      raw_extinf      TEXT    DEFAULT '',
      quality         TEXT    DEFAULT '',
      normalized_name TEXT    DEFAULT '',
      meta            TEXT    DEFAULT NULL,
      content_type    TEXT    DEFAULT 'vod',
      UNIQUE(source_id, url)
    );
  `)
  
  // Copy data, keeping only first occurrence of each (source_id, url) pair
  db.exec(`
    INSERT INTO source_channels_new 
    SELECT * FROM source_channels 
    WHERE id IN (
      SELECT MIN(id) FROM source_channels 
      GROUP BY source_id, url
    );
  `)
  
  // Drop old table and rename new one
  db.exec('DROP TABLE source_channels;')
  db.exec('ALTER TABLE source_channels_new RENAME TO source_channels;')
  
  // Recreate indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_source_channels_source ON source_channels(source_id);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_source_channels_url ON source_channels(url);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_source_channels_normalized ON source_channels(normalized_name);')
  
  console.log('[Migration 004] Unique constraint added successfully')
}

export function down(db) {
  console.log('[Migration 004] Removing unique constraint - recreating original table')
  
  db.exec(`
    CREATE TABLE source_channels_old (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      tvg_id          TEXT    DEFAULT '',
      tvg_name        TEXT    NOT NULL,
      tvg_logo        TEXT    DEFAULT '',
      group_title     TEXT    DEFAULT '',
      url             TEXT    NOT NULL,
      raw_extinf      TEXT    DEFAULT '',
      quality         TEXT    DEFAULT '',
      normalized_name TEXT    DEFAULT '',
      meta            TEXT    DEFAULT NULL,
      content_type    TEXT    DEFAULT 'vod'
    );
  `)
  
  db.exec('INSERT INTO source_channels_old SELECT * FROM source_channels;')
  db.exec('DROP TABLE source_channels;')
  db.exec('ALTER TABLE source_channels_old RENAME TO source_channels;')
  
  console.log('[Migration 004] Rollback complete')
}
