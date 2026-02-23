import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { mkdirSync } from 'node:fs'
import { setInterval } from 'node:timers'

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
mkdirSync(DATA_DIR, { recursive: true })

// Create db directory
const DB_DIR = path.join(DATA_DIR, 'db')
mkdirSync(DB_DIR, { recursive: true })

// Set permissions
try {
  fs.chmodSync(DATA_DIR, 0o777)
  fs.chmodSync(DB_DIR, 0o777)
} catch (err) {
  console.error('Failed to set permissions:', err)
}

const DISK_DB_PATH = path.join(DB_DIR, 'm3u-manager.db')
const SYNC_INTERVAL = process.env.DB_SYNC_INTERVAL || 60000 // 1 minute by default

// Initialize the in-memory database
const memoryDb = new Database(':memory:')
memoryDb.pragma('foreign_keys = ON')

// Create the same schema in memory
memoryDb.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'm3u',
    url         TEXT NOT NULL,
    username    TEXT,
    password    TEXT,
    refresh_cron TEXT DEFAULT '0 */6 * * *',
    last_fetched TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    output_path TEXT,
    schedule    TEXT DEFAULT '0 */6 * * *',
    last_built  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
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
    sort_order    INTEGER DEFAULT 0
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

  CREATE INDEX IF NOT EXISTS idx_source_channels_source_id ON source_channels(source_id);
  CREATE INDEX IF NOT EXISTS idx_source_channels_group ON source_channels(source_id, group_title);

  CREATE TABLE IF NOT EXISTS epg_site_channels (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    site     TEXT NOT NULL,
    name     TEXT NOT NULL,
    site_id  TEXT NOT NULL,
    xmltv_id TEXT NOT NULL,
    lang     TEXT NOT NULL DEFAULT 'en',
    file     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_site     ON epg_site_channels(site);
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_xmltv_id ON epg_site_channels(xmltv_id);
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_name     ON epg_site_channels(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS epg_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
    content     TEXT,
    channel_count INTEGER DEFAULT 0,
    last_fetched  TEXT
  );
`)

// Initialize the disk database
const diskDb = new Database(DISK_DB_PATH)
diskDb.pragma('journal_mode = WAL')
diskDb.pragma('foreign_keys = ON')

// Function to backup in-memory DB to disk
function syncToDisk() {
  try {
    const start = Date.now()

    // Manual backup - get all tables and copy data
    diskDb.exec('PRAGMA foreign_keys = OFF;')
    diskDb.exec('BEGIN TRANSACTION;')

    // Get all tables
    const tables = memoryDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").all()

    // Clear and repopulate each table
    for (const table of tables) {
      // Delete existing data
      try {
        diskDb.exec(`DELETE FROM ${table.name};`)

        // Get data from memory DB
        const rows = memoryDb.prepare(`SELECT * FROM ${table.name}`).all()

        // Insert into disk DB
        if (rows.length > 0) {
          const columns = Object.keys(rows[0]).join(',')
          const placeholders = Object.keys(rows[0]).map(() => '?').join(',')

          const stmt = diskDb.prepare(`INSERT INTO ${table.name} (${columns}) VALUES (${placeholders})`)
          for (const row of rows) {
            stmt.run(Object.values(row))
          }
        }
      } catch (tableErr) {
        console.error(`[DB] Error syncing table ${table.name}:`, tableErr.message)
      }
    }

    diskDb.exec('COMMIT;')
    diskDb.exec('PRAGMA foreign_keys = ON;')

    const elapsed = Date.now() - start
    console.log(`[DB] Memory database synced to disk in ${elapsed}ms`)
  } catch (err) {
    console.error('[DB] Backup error:', err.message)
  }
}

// Load initial data from disk to memory
function loadFromDisk() {
  try {
    const tables = diskDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").all()
    if (tables.length > 0) {
      console.log('[DB] Loading data from disk to memory...')
      const start = Date.now()

      // Manual load - get all tables and copy data
      memoryDb.exec('PRAGMA foreign_keys = OFF;')
      memoryDb.exec('BEGIN TRANSACTION;')

      // Copy each table's data
      for (const table of tables) {
        try {
          // Get schema from disk DB
          const createStmt = diskDb.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table.name).sql

          // Create table in memory if it doesn't exist
          try { memoryDb.exec(`DROP TABLE IF EXISTS ${table.name};`) } catch (e) {}
          memoryDb.exec(createStmt)

          // Get data from disk DB
          const rows = diskDb.prepare(`SELECT * FROM ${table.name}`).all()

          // Insert into memory DB
          if (rows.length > 0) {
            const columns = Object.keys(rows[0]).join(',')
            const placeholders = Object.keys(rows[0]).map(() => '?').join(',')

            const stmt = memoryDb.prepare(`INSERT INTO ${table.name} (${columns}) VALUES (${placeholders})`)
            for (const row of rows) {
              stmt.run(Object.values(row))
            }
          }
        } catch (tableErr) {
          console.error(`[DB] Error loading table ${table.name}:`, tableErr.message)
        }
      }

      memoryDb.exec('COMMIT;')
      memoryDb.exec('PRAGMA foreign_keys = ON;')

      const elapsed = Date.now() - start
      console.log(`[DB] Database loaded into memory in ${elapsed}ms`)
      return true
    }
    return false
  } catch (err) {
    console.error('[DB] Error loading from disk:', err.message)
    return false
  }
}

// Set up periodic sync to disk
setInterval(syncToDisk, SYNC_INTERVAL)

// Handle process termination - ensure final sync
process.on('SIGINT', () => {
  console.log('[DB] Process terminating, syncing database to disk...')
  syncToDisk()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[DB] Process terminating, syncing database to disk...')
  syncToDisk()
  process.exit(0)
})

// Use the memory database as our main db
const db = memoryDb

// Load existing data or initialize new database
const dataLoaded = loadFromDisk()

// Export the sync function so it can be called manually after critical operations
export function forceSyncToDisk() {
  return syncToDisk()
}

// Add a method to the db object to force sync
db.sync = forceSyncToDisk

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'm3u',
    url         TEXT NOT NULL,
    username    TEXT,
    password    TEXT,
    refresh_cron TEXT DEFAULT '0 */6 * * *',
    last_fetched TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    output_path TEXT,
    schedule    TEXT DEFAULT '0 */6 * * *',
    last_built  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
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
    sort_order    INTEGER DEFAULT 0
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

  CREATE INDEX IF NOT EXISTS idx_source_channels_source_id ON source_channels(source_id);
  CREATE INDEX IF NOT EXISTS idx_source_channels_group ON source_channels(source_id, group_title);

  CREATE TABLE IF NOT EXISTS epg_site_channels (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    site     TEXT NOT NULL,
    name     TEXT NOT NULL,
    site_id  TEXT NOT NULL,
    xmltv_id TEXT NOT NULL,
    lang     TEXT NOT NULL DEFAULT 'en',
    file     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_site     ON epg_site_channels(site);
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_xmltv_id ON epg_site_channels(xmltv_id);
  CREATE INDEX IF NOT EXISTS idx_epg_site_channels_name     ON epg_site_channels(name COLLATE NOCASE);

  -- Add category column to sources if not exists (playlist | epg)
  CREATE TABLE IF NOT EXISTS epg_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
    content     TEXT,
    channel_count INTEGER DEFAULT 0,
    last_fetched  TEXT
  );
`)

// Migrate: drop CHECK(type IN ('m3u','xtream')) constraint by rebuilding the table
try {
  const hasConstraint = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'`).get()
  if (hasConstraint?.sql?.includes("CHECK(type IN")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE sources RENAME TO _sources_old;
      CREATE TABLE sources (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT 'm3u',
        url          TEXT NOT NULL,
        username     TEXT,
        password     TEXT,
        refresh_cron TEXT DEFAULT '0 */6 * * *',
        last_fetched TEXT,
        created_at   TEXT DEFAULT (datetime('now')),
        category     TEXT NOT NULL DEFAULT 'playlist',
        max_streams  INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sources SELECT id, name, type, url, username, password, refresh_cron, last_fetched, created_at,
        COALESCE(category, 'playlist'), COALESCE(max_streams, 0) FROM _sources_old;
      DROP TABLE _sources_old;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
    console.log('[db] Migrated sources table — removed type CHECK constraint')
  }
} catch (e) { console.error('[db] sources migration error:', e.message) }

// Migrate: add category column to sources if it doesn't exist yet
try {
  db.exec(`ALTER TABLE sources ADD COLUMN category TEXT NOT NULL DEFAULT 'playlist'`)
} catch {}  // column already exists — ignore

try {
  db.exec(`ALTER TABLE sources ADD COLUMN max_streams INTEGER NOT NULL DEFAULT 0`)
} catch {}

try {
  db.exec(`ALTER TABLE playlist_channels ADD COLUMN source_id INTEGER`)
} catch {}

try {
  db.exec(`ALTER TABLE playlists ADD COLUMN group_order TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE playlist_channels ADD COLUMN epg_source_id INTEGER`)
} catch {}

try {
  db.exec(`ALTER TABLE playlist_channels ADD COLUMN custom_logo TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE playlists ADD COLUMN playlist_type TEXT NOT NULL DEFAULT 'live'`)
} catch {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN vod_playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL`)
} catch {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_playlist_group        ON playlist_channels(playlist_id, group_title)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_playlist_source       ON playlist_channels(playlist_id, source_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_playlist_group_source ON playlist_channels(playlist_id, source_id, group_title)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_url                   ON source_channels(url)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_url                   ON playlist_channels(url)`)

db.exec(`
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
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_channel ON failed_streams(channel_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_playlist ON failed_streams(playlist_id)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS stream_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    channel_id  INTEGER,
    tvg_name    TEXT,
    group_title TEXT,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    duration_s  INTEGER
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sh_username ON stream_history(username)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sh_started  ON stream_history(started_at)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  )
`)

// HDHomeRun virtual devices table
db.exec(`
  CREATE TABLE IF NOT EXISTS hdhr_devices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL DEFAULT 'M3U Tuner',
    playlist_id  INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    port         INTEGER NOT NULL DEFAULT 5004,
    tuner_count  INTEGER NOT NULL DEFAULT 4,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );
`)

// Users table for client portal
db.exec(`
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
    created_at          TEXT DEFAULT (datetime('now'))
  );
`)
// Migrations for existing installs
try { db.exec(`ALTER TABLE users ADD COLUMN vod_playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL`) } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN last_connected_at TEXT`) } catch {}

// TMDB enrichment cache — keyed by title (show/movie level)
db.exec(`
  CREATE TABLE IF NOT EXISTS tmdb_enrichment (
    title       TEXT PRIMARY KEY,
    tmdb_id     INTEGER,
    media_type  TEXT,
    poster      TEXT,
    description TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_tmdb_title ON tmdb_enrichment(title)`)

// TMDB episode cache — keyed by show title + season + episode number
db.exec(`
  CREATE TABLE IF NOT EXISTS tmdb_episodes (
    show_title  TEXT NOT NULL,
    season      INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    poster      TEXT,
    description TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (show_title, season, episode)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_tmdb_ep_show ON tmdb_episodes(show_title)`)

// Migration: add tmdb_id and media_type to existing installs
try { db.exec(`ALTER TABLE tmdb_enrichment ADD COLUMN tmdb_id INTEGER`) } catch {}
try { db.exec(`ALTER TABLE tmdb_enrichment ADD COLUMN media_type TEXT`) } catch {}

// Update query planner statistics for better index usage
db.exec(`ANALYZE`)

export default db
