export function up(db) {
  console.log('[Migration 018] Adding stream_stats_daily table for daily data transfer tracking')

  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_stats_daily (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL,
      channel_id  INTEGER NOT NULL,
      bytes_in    INTEGER NOT NULL DEFAULT 0,
      bytes_out   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ssd_date    ON stream_stats_daily(date);
    CREATE INDEX IF NOT EXISTS idx_ssd_channel ON stream_stats_daily(channel_id);
  `)

  console.log('[Migration 018] ✓ Created stream_stats_daily table and indexes')
}

export function down(db) {
  console.log('[Migration 018] Removing stream_stats_daily table')
  db.exec('DROP TABLE IF EXISTS stream_stats_daily')
}
