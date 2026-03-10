import express from 'express'
import db from '../db.js'
import { startContentUpdateScheduler, startEpgGrabCron, startEnrichCron } from '../services/scheduler.js'

const router = express.Router()
const FALLBACK_GENRES = ['Action', 'Comedy', 'Drama', 'Documentary', 'Horror', 'Romance', 'Sci-Fi', 'Thriller']

// ── VOD Settings Helpers ───────────────────────────────────────────────────────
export function getVodSettings() {
  const settings = db.prepare('SELECT * FROM settings WHERE key LIKE ?').all('vod_%')
  const result = {}
  for (const row of settings) {
    try {
      result[row.key] = JSON.parse(row.value)
    } catch {
      result[row.key] = row.value
    }
  }
  // Ensure defaults
  return {
    vod_detected_languages: result.vod_detected_languages || ['eng'],
    vod_allowed_languages: result.vod_allowed_languages || ['eng'],
    vod_language_filter_mode: result.vod_language_filter_mode || 'disabled',
    vod_detected_genres: result.vod_detected_genres || FALLBACK_GENRES,
    vod_allowed_genres: result.vod_allowed_genres || [],
    vod_genre_filter_mode: result.vod_genre_filter_mode || 'disabled',
    vod_blocked_titles: result.vod_blocked_titles || []
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all()
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])))
})

router.put('/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  const save = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) upsert.run(k, String(v))
  })
  save(req.body)

  // Restart cron jobs if schedules changed
  if ('epg_grab_schedule' in req.body) {
    console.log('[settings] EPG grab schedule updated, restarting cron...')
    startEpgGrabCron()
  }
  if ('epg_enrich_schedule' in req.body) {
    console.log('[settings] TMDB enrichment schedule updated, restarting cron...')
    startEnrichCron()
  }
  if ('live_refresh_schedule' in req.body || 'movie_refresh_schedule' in req.body || 'series_refresh_schedule' in req.body) {
    console.log('[settings] Content update schedules changed, restarting scheduler...')
    startContentUpdateScheduler()
  }

  res.json({ ok: true })
})

// ── VOD Settings ──────────────────────────────────────────────────────────────
// GET /api/vod/settings - Get VOD-specific settings
router.get('/vod/settings', (req, res) => {
  res.json(getVodSettings())
})

// GET /api/vod/languages - Get languages for VOD settings UI (NFO + always eng)
router.get('/vod/languages', async (req, res) => {
  try {
    // Fetch from STRM scanner
    const response = await fetch(`http://localhost:${process.env.PORT || 3005}/api/strm/languages`)
    const data = await response.json()

    // Get current settings
    const vodSettings = getVodSettings()

    res.json({
      languages: data.languages || ['eng'],
      totalChannels: data.totalChannels || 0,
      withLanguageData: data.withLanguageData || 0,
      currentSettings: vodSettings
    })
  } catch (e) {
    // Return default with just eng if scanner fails
    res.json({
      languages: ['eng'],
      totalChannels: 0,
      withLanguageData: 0,
      currentSettings: getVodSettings()
    })
  }
})

// GET /api/vod/genres - Get genres for VOD settings UI (NFO + generic fallback)
router.get('/vod/genres', async (req, res) => {
  const vodSettings = getVodSettings()
  res.json({
    genres: vodSettings.vod_detected_genres || FALLBACK_GENRES,
    totalChannels: 0,
    withGenreData: 0,
    currentSettings: vodSettings
  })
})

// POST /api/vod/genres/refresh - rebuild detected genres from current VOD source data
router.post('/vod/genres/refresh', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT group_title, meta, content_type
      FROM source_channels
      WHERE content_type IN ('movie', 'series')
    `).all()

    const normalizeGenre = (value) => {
      if (!value) return null
      const genre = String(value)
        .replace(/^(Movie|Series):\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
      return genre || null
    }

    const parseGenres = (value) => String(value)
      .split(/[\/,]/)
      .map(v => normalizeGenre(v))
      .filter(Boolean)

    const extractGenre = (row) => {
      const groupTitle = String(row.group_title || '')
      if (!/^Movie:\s*|^Series:\s*/i.test(groupTitle)) {
        return []
      }

      let meta = null
      if (row.meta) {
        try {
          meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta
        } catch {
          meta = null
        }
      }

      const metaGenre = meta?.genre || meta?.genres || meta?.category_name || meta?.category

      if (Array.isArray(metaGenre)) {
        for (const item of metaGenre) {
          const parsed = parseGenres(item)
          if (parsed.length > 0) return parsed
        }
      }

      if (typeof metaGenre === 'string') {
        const parsed = parseGenres(metaGenre)
        if (parsed.length > 0) return parsed
      }

      return parseGenres(groupTitle)
    }

    const detectedGenres = new Map(FALLBACK_GENRES.map(genre => [genre.toLowerCase(), genre]))
    let withGenreData = 0
    let processedRows = 0

    for (const row of rows) {
      const genres = extractGenre(row)
      if (!Array.isArray(genres) || genres.length === 0) continue
      processedRows++
      for (const genre of genres) {
        detectedGenres.set(genre.toLowerCase(), genre)
      }
      withGenreData++
    }

    const genres = Array.from(detectedGenres.values()).sort((a, b) => a.localeCompare(b))

    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('vod_detected_genres', JSON.stringify(genres))

    res.json({
      success: true,
      message: `Refreshed ${genres.length} detected genres from ${processedRows} VOD rows`,
      genres,
      totalChannels: processedRows,
      withGenreData
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── STRM Export ───────────────────────────────────────────────────────────────
router.get('/strm/stats', async (req, res) => {
  const { getStrmExportStats } = await import('../strm-exporter.js')
  res.json(getStrmExportStats())
})

router.post('/strm/export/:playlistId', async (req, res) => {
  const playlistId = req.params.playlistId
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId)

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' })
  }

  if (playlist.playlist_type !== 'vod') {
    return res.status(400).json({ error: 'Only VOD playlists can be exported to STRM' })
  }

  // Use HOST_IP env var for STRM URLs so they're accessible from outside container
  const hostIp = process.env.HOST_IP || req.get('host')
  const baseUrl = `http://${hostIp}:3005`

  // Get or create jellyfin user for STRM authentication
  let jellyfinUser = db.prepare('SELECT * FROM users WHERE username = ?').get('jellyfin')
  let jellyfinPassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('jellyfin_strm_password')?.value

  if (!jellyfinUser) {
    console.log('[strm] Creating default "jellyfin" user for STRM authentication')
    // Generate random secure password
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*'
    jellyfinPassword = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')

    const { hashPassword } = await import('../auth.js')
    const hashed = await hashPassword(jellyfinPassword)
    db.prepare(
      `INSERT INTO users (username, password, max_connections, active, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run('jellyfin', hashed, 0, 1, 'Auto-created for Jellyfin STRM files')

    // Store password in settings for retrieval
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jellyfin_strm_password', jellyfinPassword)

    jellyfinUser = db.prepare('SELECT * FROM users WHERE username = ?').get('jellyfin')
    console.log('[strm] Created jellyfin user with random password (stored in settings)')
  }

  if (!jellyfinPassword) {
    jellyfinPassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('jellyfin_strm_password')?.value || 'jellyfin'
  }

  try {
    const { exportVodToStrm } = await import('../strm-exporter.js')
    const stats = await exportVodToStrm(playlistId, baseUrl, jellyfinUser.username, jellyfinPassword)

    db.prepare("UPDATE playlists SET last_built = datetime('now') WHERE id = ?").run(playlistId)

    res.json({
      success: true,
      stats,
      message: `Exported ${stats.created + stats.updated} STRM files`
    })
  } catch (e) {
    console.error('[strm] Export failed:', e)
    res.status(500).json({ error: e.message })
  }
})

router.post('/strm/export-all', async (req, res) => {
  const vodPlaylists = db.prepare('SELECT * FROM playlists WHERE playlist_type = ?').all('vod')

  if (vodPlaylists.length === 0) {
    return res.json({
      success: true,
      playlists: [],
      message: 'No VOD playlists found'
    })
  }

  // Use HOST_IP env var for STRM URLs so they're accessible from outside container
  const hostIp = process.env.HOST_IP || req.get('host')
  const baseUrl = `http://${hostIp}:3005`
  const results = []
  let totalCreated = 0
  let totalUpdated = 0
  let totalDeleted = 0
  let totalErrors = 0

  // Get or create jellyfin user for STRM authentication
  let jellyfinUser = db.prepare('SELECT * FROM users WHERE username = ?').get('jellyfin')
  let jellyfinPassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('jellyfin_strm_password')?.value

  if (!jellyfinUser) {
    console.log('[strm] Creating default "jellyfin" user for STRM authentication')
    // Generate random secure password
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*'
    jellyfinPassword = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')

    const { hashPassword } = await import('../auth.js')
    const hashed = await hashPassword(jellyfinPassword)
    db.prepare(
      `INSERT INTO users (username, password, max_connections, active, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run('jellyfin', hashed, 0, 1, 'Auto-created for Jellyfin STRM files')

    // Store password in settings for retrieval
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jellyfin_strm_password', jellyfinPassword)

    jellyfinUser = db.prepare('SELECT * FROM users WHERE username = ?').get('jellyfin')
    console.log('[strm] Created jellyfin user with random password (stored in settings)')
  }

  if (!jellyfinPassword) {
    jellyfinPassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('jellyfin_strm_password')?.value || 'jellyfin'
  }

  for (const playlist of vodPlaylists) {
    try {
      const { exportVodToStrm } = await import('../strm-exporter.js')
      const stats = await exportVodToStrm(playlist.id, baseUrl, jellyfinUser.username, jellyfinPassword)

      db.prepare("UPDATE playlists SET last_built = datetime('now') WHERE id = ?").run(playlist.id)

      totalCreated += stats.created
      totalUpdated += stats.updated
      totalDeleted += stats.deleted
      totalErrors += stats.errors

      results.push({
        playlistId: playlist.id,
        playlistName: playlist.name,
        success: true,
        stats,
        directory: stats.directory
      })

      console.log(`[strm] Exported playlist "${playlist.name}": ${stats.created} created, ${stats.updated} updated`)
    } catch (e) {
      console.error(`[strm] Export failed for "${playlist.name}":`, e.message)
      results.push({
        playlistId: playlist.id,
        playlistName: playlist.name,
        success: false,
        error: e.message
      })
      totalErrors++
    }
  }

  res.json({
    success: true,
    playlists: results,
    summary: {
      totalPlaylists: vodPlaylists.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      totalCreated,
      totalUpdated,
      totalDeleted,
      totalErrors
    },
    message: `Exported ${results.filter(r => r.success).length}/${vodPlaylists.length} VOD playlists`
  })
})

export default router
