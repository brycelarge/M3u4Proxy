export function up(db) {
  console.log('[Migration 017] Adding epg_programmes table for fast XMLTV generation')

  db.exec(`
    CREATE TABLE IF NOT EXISTS epg_programmes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      channel_id  TEXT NOT NULL,
      start       TEXT NOT NULL,
      stop        TEXT NOT NULL,
      title       TEXT,
      desc        TEXT,
      icon        TEXT,
      episode_num TEXT,
      raw         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ep_source_channel ON epg_programmes(source_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_ep_channel        ON epg_programmes(channel_id);
  `)
  
  console.log('[Migration 017] ✓ Added epg_programmes table and indexes')
}

export function down(db) {
  console.log('[Migration 017] Removing epg_programmes table')
  db.exec('DROP TABLE IF EXISTS epg_programmes')
}
