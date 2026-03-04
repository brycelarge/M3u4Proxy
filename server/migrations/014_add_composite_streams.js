export function up(db) {
  console.log('[Migration 014] Creating composite streams tables')
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS composite_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      layout_config TEXT NOT NULL,
      audio_config TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS composite_stream_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      composite_stream_id INTEGER NOT NULL,
      source_channel_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      position_x INTEGER,
      position_y INTEGER,
      width INTEGER,
      height INTEGER,
      FOREIGN KEY (composite_stream_id) REFERENCES composite_streams(id) ON DELETE CASCADE,
      FOREIGN KEY (source_channel_id) REFERENCES playlist_channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_composite_stream_sources_composite_id 
      ON composite_stream_sources(composite_stream_id);
    CREATE INDEX IF NOT EXISTS idx_composite_stream_sources_channel_id 
      ON composite_stream_sources(source_channel_id);
  `)
  
  console.log('[Migration 014] ✓ Created composite_streams and composite_stream_sources tables')
}

export function down(db) {
  console.log('[Migration 014] Dropping composite streams tables')
  db.exec(`
    DROP TABLE IF EXISTS composite_stream_sources;
    DROP TABLE IF EXISTS composite_streams;
  `)
}
