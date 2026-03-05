import db from '../db.js'
import cron from 'node-cron'
import { refreshSourceCache } from './sourceManager.js'
import { buildM3U, writeM3U } from '../m3uBuilder.js'
import { exportVodToStrm } from '../strm-exporter.js'
import { hashPassword } from '../auth.js'
import { runGrab, grabState } from '../epgGrab.js'
import { enrichGuide } from '../epgEnrich.js'

let liveRefreshCronJob = null
let movieRefreshCronJob = null
let seriesRefreshCronJob = null
let epgGrabCronJob = null
let enrichCronJob = null

export function startEpgGrabCron() {
  if (epgGrabCronJob) epgGrabCronJob.stop()
  const schedule = db.prepare('SELECT value FROM settings WHERE key = ?').get('epg_grab_schedule')?.value || '0 23 * * *'
  if (!schedule) {
    console.log('[startup] EPG grab schedule disabled')
    return
  }
  console.log(`[startup] Configuring EPG grab cron with schedule: ${schedule}`)
  if (cron.validate(schedule)) {
    epgGrabCronJob = cron.schedule(schedule, () => {
      console.log(`[cron] Running daily EPG grab at ${new Date().toISOString()}…`)
      runGrab({ onProgress: (msg) => console.log(`[cron-epg] ${msg}`) })
        .then(async () => {
          console.log(`[cron] EPG grab completed successfully at ${new Date().toISOString()}`)
          const epgSources = db.prepare("SELECT * FROM sources WHERE category = 'epg'").all()
          // Refresh all EPG sources sequentially
          for (const s of epgSources) {
            try {
              console.log(`[cron] Refreshing EPG source "${s.name}"...`)
              await refreshSourceCache(s.id)
              console.log(`[cron] Successfully refreshed EPG source "${s.name}"`)
            } catch (err) {
              console.error(`[cron] Error refreshing EPG source "${s.name}":`, err.message)
            }
          }
        })
        .catch(e => console.error('[cron] EPG grab error:', e.message))
    }, {
      scheduled: true,
      timezone: "Africa/Johannesburg"
    })
  } else {
    console.error(`[startup] Invalid EPG grab cron schedule: ${schedule}`)
  }
}

export function startEnrichCron() {
  if (enrichCronJob) enrichCronJob.stop()
  const schedule = db.prepare('SELECT value FROM settings WHERE key = ?').get('epg_enrich_schedule')?.value || '0 2 * * *'
  if (!schedule) {
    console.log('[startup] TMDB enrichment schedule disabled')
    return
  }
  console.log(`[startup] Configuring TMDB enrichment cron with schedule: ${schedule}`)
  if (cron.validate(schedule)) {
    enrichCronJob = cron.schedule(schedule, () => {
      console.log(`[cron] Running TMDB enrichment at ${new Date().toISOString()}…`)
      enrichGuide(null)
        .then(() => {
          console.log(`[cron] TMDB enrichment completed at ${new Date().toISOString()}`)
        })
        .catch(e => console.error('[cron] Enrichment error:', e.message))
    }, {
      scheduled: true,
      timezone: "Africa/Johannesburg"
    })
  } else {
    console.error(`[startup] Invalid enrichment cron schedule: ${schedule}`)
  }
}

export function startContentUpdateScheduler() {
  // Stop existing jobs
  if (liveRefreshCronJob) liveRefreshCronJob.stop()
  if (movieRefreshCronJob) movieRefreshCronJob.stop()
  if (seriesRefreshCronJob) seriesRefreshCronJob.stop()

  const getLiveSchedule = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('live_refresh_schedule')?.value || '0 */6 * * *'
  const getMovieSchedule = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('movie_refresh_schedule')?.value || '0 4 * * 0'
  const getSeriesSchedule = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('series_refresh_schedule')?.value || '0 4 * * *'
  const getAutoExportStrm = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_export_strm')?.value === '1'

  // Live TV refresh schedule (applies to all sources)
  const liveSchedule = getLiveSchedule()
  if (cron.validate(liveSchedule)) {
    liveRefreshCronJob = cron.schedule(liveSchedule, async () => {
      console.log(`[cron] Running Live TV refresh at ${new Date().toISOString()}`)

      // Refresh all sources (Xtream: Live only, M3U: all content)
      const sources = db.prepare('SELECT * FROM sources WHERE category = ?').all('playlist')
      for (const source of sources) {
        try {
          console.log(`[cron] Refreshing Live TV for "${source.name}"`)

          if (source.type === 'xtream') {
            // For Xtream: Only refresh Live TV
            await refreshSourceWithContentTypes(source.id, { refreshLive: true, refreshMovies: false, refreshSeries: false })
          } else {
            // For M3U: Refresh all content (treated as Live TV)
            await refreshSourceCache(source.id)
          }
        } catch (e) {
          console.error(`[cron] Failed to refresh Live TV for "${source.name}":`, e.message)
        }
      }

      // Build M3U files for Live playlists with output_path
      const livePlaylists = db.prepare('SELECT * FROM playlists WHERE playlist_type = ? AND output_path IS NOT NULL').all('live')
      for (const p of livePlaylists) {
        try {
          const channels = db.prepare('SELECT * FROM playlist_channels WHERE playlist_id = ? ORDER BY sort_order, id').all(p.id)
          const epgRows = db.prepare('SELECT * FROM epg_mappings').all()
          const epgMap = new Map(epgRows.map(r => [r.source_tvg_id, r.target_tvg_id]))
          const content = buildM3U(channels, epgMap)
          writeM3U(p.output_path, content)
          db.prepare("UPDATE playlists SET last_built = datetime('now') WHERE id = ?").run(p.id)
          console.log(`[cron] Built Live M3U "${p.name}" -> ${p.output_path}`)
        } catch (e) {
          console.error(`[cron] Failed to build M3U for "${p.name}":`, e.message)
        }
      }
    }, { scheduled: true, timezone: "Africa/Johannesburg" })
    console.log(`[startup] Scheduled Live TV refresh: ${liveSchedule}`)
  }

  // Movies refresh schedule (Xtream sources only)
  const movieSchedule = getMovieSchedule()
  if (cron.validate(movieSchedule)) {
    movieRefreshCronJob = cron.schedule(movieSchedule, async () => {
      console.log(`[cron] Running Movies refresh at ${new Date().toISOString()}`)

      const xtreamSources = db.prepare('SELECT * FROM sources WHERE type = ? AND category = ?').all('xtream', 'playlist')
      for (const source of xtreamSources) {
        try {
          console.log(`[cron] Refreshing Movies for "${source.name}"`)
          await refreshSourceWithContentTypes(source.id, { refreshLive: false, refreshMovies: true, refreshSeries: false })
        } catch (e) {
          console.error(`[cron] Failed to refresh Movies for "${source.name}":`, e.message)
        }
      }

      // Auto-export STRM files if enabled
      if (getAutoExportStrm()) {
        await exportVodStrmFiles('movie')
      }
    }, { scheduled: true, timezone: "Africa/Johannesburg" })
    console.log(`[startup] Scheduled Movies refresh: ${movieSchedule}`)
  }

  // Series refresh schedule (Xtream sources only)
  const seriesSchedule = getSeriesSchedule()
  if (cron.validate(seriesSchedule)) {
    seriesRefreshCronJob = cron.schedule(seriesSchedule, async () => {
      console.log(`[cron] Running Series refresh at ${new Date().toISOString()}`)

      const xtreamSources = db.prepare('SELECT * FROM sources WHERE type = ? AND category = ?').all('xtream', 'playlist')
      for (const source of xtreamSources) {
        try {
          console.log(`[cron] Refreshing Series for "${source.name}"`)
          await refreshSourceWithContentTypes(source.id, { refreshLive: false, refreshMovies: false, refreshSeries: true })
        } catch (e) {
          console.error(`[cron] Failed to refresh Series for "${source.name}":`, e.message)
        }
      }

      // Auto-export STRM files if enabled
      if (getAutoExportStrm()) {
        await exportVodStrmFiles('series')
      }
    }, { scheduled: true, timezone: "Africa/Johannesburg" })
    console.log(`[startup] Scheduled Series refresh: ${seriesSchedule}`)
  }
}

// Helper function to refresh source with specific content types
async function refreshSourceWithContentTypes(sourceId, refreshOptions) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source || source.type !== 'xtream') {
    throw new Error('Invalid source or not Xtream type')
  }

  // Temporarily modify refreshSourceCache to accept refresh options
  // Store options in a way refreshSourceCache can access them
  global.currentRefreshOptions = refreshOptions
  await refreshSourceCache(sourceId)
  delete global.currentRefreshOptions
}

// Helper function to export STRM files for VOD playlists
async function exportVodStrmFiles(contentType) {
  console.log(`[cron] Auto-exporting STRM files for ${contentType} playlists`)

  const vodPlaylists = db.prepare('SELECT * FROM playlists WHERE playlist_type = ?').all('vod')

  // Get or create jellyfin user
  let jellyfinUser = db.prepare('SELECT * FROM users WHERE username = ?').get('jellyfin')
  let jellyfinPassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('jellyfin_strm_password')?.value

  if (!jellyfinUser) {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*'
    jellyfinPassword = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    const hashed = await hashPassword(jellyfinPassword)
    db.prepare(
      `INSERT INTO users (username, password, max_connections, active, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run('jellyfin', hashed, 0, 1, 'Auto-created for Jellyfin STRM files')
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jellyfin_strm_password', jellyfinPassword)
    jellyfinUser = db.prepare('SELECT * FROM users WHERE username = ?').get('jellyfin')
  }

  if (!jellyfinPassword) {
    jellyfinPassword = 'jellyfin'
  }

  const hostIp = process.env.HOST_IP || 'localhost'
  const baseUrl = `http://${hostIp}:3005`

  for (const playlist of vodPlaylists) {
    try {
      const stats = await exportVodToStrm(playlist.id, baseUrl, jellyfinUser.username, jellyfinPassword)
      db.prepare("UPDATE playlists SET last_built = datetime('now') WHERE id = ?").run(playlist.id)
      console.log(`[cron] Exported STRM for "${playlist.name}": ${stats.created} created, ${stats.updated} updated`)
    } catch (e) {
      console.error(`[cron] Failed to export STRM for "${playlist.name}":`, e.message)
    }
  }
}
