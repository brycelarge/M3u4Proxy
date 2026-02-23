import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { mkdirSync } from 'node:fs'

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
mkdirSync(DATA_DIR, { recursive: true })

// Create db directory
const DB_DIR = path.join(DATA_DIR, 'db')
mkdirSync(DB_DIR, { recursive: true })

// Define database path
const DISK_DB_PATH = path.join(DB_DIR, 'm3u-manager.db')

// Ensure database directory has proper permissions
try {
  // Make sure the DB directory is writable
  fs.chmodSync(DB_DIR, 0o777)

  // If the database file exists, make sure it's writable
  if (fs.existsSync(DISK_DB_PATH)) {
    fs.chmodSync(DISK_DB_PATH, 0o666)
    console.log('[DB] Set permissions on existing database file')
  }
} catch (err) {
  console.log('[DB] Permission warning:', err.message)
  console.log('[DB] Continuing anyway - this might cause issues if the DB is read-only')
}

// Initialize the database directly on disk
const db = new Database(DISK_DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Create tables first, then create indexes
// This avoids errors with indexes referencing tables that don't exist yet
db.exec(`
  -- First create all tables
  CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'm3u',
    url         TEXT NOT NULL,
    username    TEXT,
    password    TEXT,
    refresh_cron TEXT DEFAULT '0 */6 * * *',
    last_fetched TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    category    TEXT DEFAULT 'playlist',
    max_streams INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    output_path TEXT,
    schedule    TEXT DEFAULT '0 */6 * * *',
    last_built  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    group_order TEXT,
    playlist_type TEXT DEFAULT 'live',
    channel_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS playlist_channels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id   INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    tvg_id        TEXT,
    tvg_name      TEXT NOT NULL,
    tvg_logo      TEXT,
    group_title   TEXT,
    url           TEXT NOT NULL,
    raw_extinf    TEXT,
    custom_tvg_id TEXT,
    sort_order    INTEGER DEFAULT 0,
    source_id     INTEGER,
    epg_source_id INTEGER,
    custom_logo   TEXT
  );

  CREATE TABLE IF NOT EXISTS epg_mappings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_tvg_id  TEXT NOT NULL UNIQUE,
    target_tvg_id  TEXT NOT NULL,
    note           TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS source_channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    tvg_id      TEXT    DEFAULT '',
    tvg_name    TEXT    NOT NULL,
    tvg_logo    TEXT    DEFAULT '',
    group_title TEXT    DEFAULT '',
    url         TEXT    NOT NULL,
    raw_extinf  TEXT    DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS epg_site_channels (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    site     TEXT NOT NULL,
    name     TEXT NOT NULL,
    site_id  TEXT NOT NULL,
    xmltv_id TEXT NOT NULL,
    lang     TEXT NOT NULL DEFAULT 'en',
    file     TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS epg_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
    content     TEXT,
    channel_count INTEGER DEFAULT 0,
    last_fetched  TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hdhr_devices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL DEFAULT 'M3U Tuner',
    playlist_id  INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    port         INTEGER NOT NULL DEFAULT 5004,
    tuner_count  INTEGER NOT NULL DEFAULT 4,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS failed_streams (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id     INTEGER NOT NULL,
    playlist_id    INTEGER,
    tvg_name       TEXT,
    group_title    TEXT,
    url            TEXT,
    error          TEXT,
    http_status    INTEGER,
    fail_count     INTEGER NOT NULL DEFAULT 1,
    first_failed   TEXT NOT NULL DEFAULT (datetime('now')),
    last_failed    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stream_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    channel_id  INTEGER,
    tvg_name    TEXT,
    group_title TEXT,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    duration_s  INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    username            TEXT NOT NULL UNIQUE,
    password            TEXT NOT NULL,
    playlist_id         INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    vod_playlist_id     INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    max_connections     INTEGER NOT NULL DEFAULT 1,
    expires_at          TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    notes               TEXT,
    last_connected_at   TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    role                TEXT DEFAULT 'user'
  );

  CREATE TABLE IF NOT EXISTS tmdb_enrichment (
    title       TEXT PRIMARY KEY,
    tmdb_id     INTEGER,
    media_type  TEXT,
    poster      TEXT,
    description TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tmdb_episodes (
    show_title  TEXT NOT NULL,
    season      INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    poster      TEXT,
    description TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (show_title, season, episode)
  );
`);

// Create all indexes in a separate statement
db.exec(`
  -- Now create all indexes after tables exist
  CREATE INDEX IF NOT EXISTS idx_source_channels_source_id ON source_channels(source_id);
  CREATE INDEX IF NOT EXISTS idx_source_channels_group ON source_channels(source_id, group_title);
  CREATE INDEX IF NOT EXISTS idx_sc_url ON source_channels(url);

  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_site ON epg_site_channels(site);
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_xmltv_id ON epg_site_channels(xmltv_id);
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_name ON epg_site_channels(name COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_failed_channel ON failed_streams(channel_id);
  CREATE INDEX IF NOT EXISTS idx_failed_playlist ON failed_streams(playlist_id);

  CREATE INDEX IF NOT EXISTS idx_sh_username ON stream_history(username);
  CREATE INDEX IF NOT EXISTS idx_sh_started ON stream_history(started_at);

  CREATE INDEX IF NOT EXISTS idx_tmdb_title ON tmdb_enrichment(title);
  CREATE INDEX IF NOT EXISTS idx_tmdb_ep_show ON tmdb_episodes(show_title);

  CREATE INDEX IF NOT EXISTS idx_pc_playlist_group ON playlist_channels(playlist_id, group_title);
  CREATE INDEX IF NOT EXISTS idx_pc_playlist_source ON playlist_channels(playlist_id, source_id);
  CREATE INDEX IF NOT EXISTS idx_pc_playlist_group_source ON playlist_channels(playlist_id, source_id, group_title);
  CREATE INDEX IF NOT EXISTS idx_pc_url ON playlist_channels(url);
`)

// Add a dummy sync method for compatibility with existing code
db.sync = () => {
  // No-op since we're using disk directly
  console.log('[DB] Using disk database directly - no sync needed')
}

// Update query planner statistics for better index usage
db.exec(`ANALYZE`)

export default db
