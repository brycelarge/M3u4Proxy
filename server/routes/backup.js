import express from 'express'
import path from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import db from '../db.js'
import { runMigrations } from '../migrate.js'

const router = express.Router()

const BACKUP_TABLES = [
  'sources',
  'playlists',
  'playlist_channels',
  'epg_mappings',
  'settings',
  'epg_site_channels',
  'users',
  'stream_history',
  'admin_sessions',
  'failed_streams',
  'source_channels',
  'epg_cache',
  'hdhr_devices',
  'composite_streams',
  'composite_stream_sources',
]

// GET /api/backup — download a gzipped JSON bundle of all data
router.get('/backup', (req, res) => {
  const bundle = {
    version: 2,
    exportedAt: new Date().toISOString(),
    schemaVersion: null,
    tables: {},
    schema: {},
    files: {},
  }

  try {
    const migrationVersion = db.prepare('SELECT MAX(id) as version FROM migrations').get()
    bundle.schemaVersion = migrationVersion?.version || 0
  } catch {
    bundle.schemaVersion = 0
  }

  for (const table of BACKUP_TABLES) {
    try {
      bundle.tables[table] = db.prepare(`SELECT * FROM ${table}`).all()
      const schema = db.prepare(`PRAGMA table_info(${table})`).all()
      bundle.schema[table] = schema.map(col => ({
        name: col.name,
        type: col.type,
        notnull: col.notnull,
        dflt_value: col.dflt_value,
        pk: col.pk,
      }))
    } catch {
      bundle.tables[table] = []
      bundle.schema[table] = []
    }
  }

  const dataDir = process.env.DATA_DIR || '/data'
  const epgDir = path.join(dataDir, 'epg')
  const channelsXmlPath = path.join(epgDir, 'channels.xml')
  const guideXmlPath = path.join(epgDir, 'guide.xml')

  if (existsSync(channelsXmlPath)) bundle.files['channels.xml'] = readFileSync(channelsXmlPath, 'base64')
  if (existsSync(guideXmlPath)) bundle.files['guide.xml'] = readFileSync(guideXmlPath, 'base64')

  const envPath = path.join(process.cwd(), '.env')
  if (existsSync(envPath)) bundle.files['.env'] = readFileSync(envPath, 'base64')

  const date = new Date().toISOString().slice(0, 10)
  const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)))

  res.setHeader('Content-Type', 'application/gzip')
  res.setHeader('Content-Disposition', `attachment; filename="m3u-manager-backup-${date}.json.gz"`)
  res.setHeader('Content-Length', compressed.length)
  res.end(compressed)
})

// POST /api/restore — upload a gzipped JSON bundle and restore all data
router.post('/restore', express.raw({ type: 'application/gzip', limit: '500mb' }), async (req, res) => {
  try {
    const bundle = JSON.parse(gunzipSync(req.body).toString('utf8'))

    if (!bundle.version || !bundle.tables) {
      return res.status(400).json({ error: 'Invalid backup file' })
    }

    const order = [
      'sources',
      'epg_mappings',
      'settings',
      'playlists',
      'playlist_channels',
      'epg_site_channels',
      'users',
      'stream_history',
      'admin_sessions',
      'failed_streams',
      'source_channels',
      'epg_cache',
      'hdhr_devices',
      'composite_streams',
      'composite_stream_sources',
    ]

    db.exec('PRAGMA foreign_keys = OFF')
    const restore = db.transaction(() => {
      for (const table of order) {
        const rows = bundle.tables[table]
        if (!rows?.length) continue

        try {
          db.prepare(`DELETE FROM ${table}`).run()

          const currentSchema = db.prepare(`PRAGMA table_info(${table})`).all()
          const currentColumns = new Set(currentSchema.map(col => col.name))

          const backupColumns = Object.keys(rows[0])
          const validColumns = backupColumns.filter(col => currentColumns.has(col))
          if (validColumns.length === 0) continue

          const stmt = db.prepare(
            `INSERT OR REPLACE INTO ${table} (${validColumns.join(',')}) VALUES (${validColumns.map(() => '?').join(',')})`
          )

          for (const row of rows) {
            stmt.run(validColumns.map(c => row[c]))
          }
        } catch (e) {
          console.error(`[restore] Error restoring table ${table}:`, e.message)
        }
      }
    })

    restore()
    db.exec('PRAGMA foreign_keys = ON')

    if (bundle.schemaVersion !== undefined) {
      const currentVersion = db.prepare('SELECT MAX(id) as version FROM migrations').get()?.version || 0
      if (bundle.schemaVersion < currentVersion) {
        await runMigrations(db)
      }
    }

    const dataDir = process.env.DATA_DIR || '/data'
    const epgDir = path.join(dataDir, 'epg')
    mkdirSync(epgDir, { recursive: true })

    if (bundle.files?.['channels.xml']) {
      writeFileSync(path.join(epgDir, 'channels.xml'), Buffer.from(bundle.files['channels.xml'], 'base64'))
    }
    if (bundle.files?.['guide.xml']) {
      writeFileSync(path.join(epgDir, 'guide.xml'), Buffer.from(bundle.files['guide.xml'], 'base64'))
    }

    if (bundle.files?.['.env']) {
      const envPath = path.join(process.cwd(), '.env')
      const restored = Buffer.from(bundle.files['.env'], 'base64').toString('utf8')
      const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
      const existingKeys = new Set(existing.split('\n').map(l => l.split('=')[0].trim()).filter(Boolean))
      const newLines = restored.split('\n').filter(l => {
        const key = l.split('=')[0].trim()
        return key && !existingKeys.has(key)
      })
      if (newLines.length) {
        writeFileSync(envPath, existing.trimEnd() + '\n' + newLines.join('\n') + '\n', 'utf8')
      }
    }

    const counts = Object.fromEntries(order.map(t => [t, bundle.tables[t]?.length || 0]))
    res.json({ ok: true, restored: counts })
  } catch (e) {
    console.error('[restore] Error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
