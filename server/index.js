import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import db from './db.js'
import { runMigrations } from './migrate.js'
import { buildM3U, writeM3U, fetchAndParseM3U, fetchXtreamChannels } from './m3uBuilder.js'
import { connectClient, getActiveSessions, killSession, getBufferSeconds } from './streamer.js'
import { hashPassword, verifyPassword } from './auth.js'
import { registerHdhrRoutes, startAllDeviceServers } from './hdhr.js'
import { registerXtreamRoutes } from './xtream.js'
import { syncEpgSites, getLastSynced, getSiteList } from './epgSync.js'
import { runGrab, grabState, GUIDE_XML, EPG_DIR as GRAB_EPG_DIR } from './epgGrab.js'
import { enrichGuide, enrichState, parseEpisodeNum } from './epgEnrich.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3005

// Simple LRU cache for channel queries (5min TTL)
const channelCache = new Map()
const CACHE_TTL = 5 * 60 * 1000
function getCached(key) {
  const entry = channelCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    channelCache.delete(key)
    return null
  }
  return entry.data
}
function setCache(key, data) {
  channelCache.set(key, { data, ts: Date.now() })
  if (channelCache.size > 100) {
    const first = channelCache.keys().next().value
    channelCache.delete(first)
  }
}

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Serve built Vue app in production
const distPath = path.join(__dirname, '../dist')
app.use(express.static(distPath))

// ── Logo proxy / cache ────────────────────────────────────────────────────────
const LOGO_CACHE_DIR = process.env.LOGO_CACHE_DIR || '/data/logos'
mkdirSync(LOGO_CACHE_DIR, { recursive: true })

app.get('/api/logo', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).end()

  // Derive a stable filename from the URL
  const { createHash } = await import('node:crypto')
  const hash = createHash('md5').update(url).digest('hex')
  const ext  = url.split('?')[0].match(/\.(png|jpg|jpeg|gif|webp|svg|ico)$/i)?.[1]?.toLowerCase() || 'png'
  const file = path.join(LOGO_CACHE_DIR, `${hash}.${ext}`)

  // Serve from cache if exists
  if (existsSync(file)) {
    res.setHeader('Cache-Control', 'public, max-age=604800') // 7 days
    res.setHeader('Content-Type', ext === 'svg' ? 'image/svg+xml' : `image/${ext}`)
    const { createReadStream } = await import('node:fs')
    return createReadStream(file).pipe(res)
  }

  // Fetch and cache
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!upstream.ok) return res.status(upstream.status).end()

    const ct = upstream.headers.get('content-type') || `image/${ext}`
    const buf = Buffer.from(await upstream.arrayBuffer())
    writeFileSync(file, buf)

    res.setHeader('Cache-Control', 'public, max-age=604800')
    res.setHeader('Content-Type', ct)
    res.end(buf)
  } catch (e) {
    res.status(502).end()
  }
})

// ── CORS Proxy ────────────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing url param' })
  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    res.status(upstream.status)
    const ct = upstream.headers.get('content-type')
    if (ct) res.setHeader('content-type', ct)
    const { Readable } = await import('node:stream')
    const readable = Readable.fromWeb(upstream.body)
    readable.on('error', () => { if (!res.writableEnded) res.end() })
    res.on('close', () => readable.destroy())
    readable.pipe(res)
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message })
  }
})

// ── Sources ───────────────────────────────────────────────────────────────────
app.get('/api/sources', (req, res) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY name').all()
  for (const s of sources) {
    if (s.category === 'epg') {
      const epg = db.prepare('SELECT channel_count FROM epg_cache WHERE source_id = ?').get(s.id)
      s.channel_count = epg?.channel_count || 0
    } else {
      s.channel_count = db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE source_id = ?').get(s.id).c
    }
  }
  res.json(sources)
})

app.post('/api/sources', (req, res) => {
  const { name, type, url, username, password, refresh_cron, category, max_streams } = req.body
  if (!name || !url) return res.status(400).json({ error: 'name, url required' })
  const cat = category || 'playlist'
  const typ = cat === 'epg' ? 'epg' : (type || 'm3u')
  const result = db.prepare(
    'INSERT INTO sources (name, type, url, username, password, refresh_cron, category, max_streams) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, typ, url, username || null, password || null, refresh_cron || '0 */6 * * *', cat, Number(max_streams) || 0)
  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(result.lastInsertRowid))
})

app.put('/api/sources/:id', (req, res) => {
  const { name, type, url, username, password, refresh_cron, category, max_streams, priority, cleanup_rules } = req.body
  const cat = category || 'playlist'
  const typ = cat === 'epg' ? 'epg' : (type || 'm3u')
  const cleanupRulesJson = cleanup_rules ? JSON.stringify(cleanup_rules) : null
  db.prepare(
    'UPDATE sources SET name=?, type=?, url=?, username=?, password=?, refresh_cron=?, category=?, max_streams=?, priority=?, cleanup_rules=? WHERE id=?'
  ).run(name, typ, url, username || null, password || null, refresh_cron || '0 */6 * * *', cat, Number(max_streams) || 0, Number(priority) || 999, cleanupRulesJson, req.params.id)
  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id))
})

app.delete('/api/sources/:id', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ── Source cache helpers ──────────────────────────────────────────────────────
async function refreshSourceCache(sourceId) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source) throw new Error('Source not found')

  // EPG source — read guide.xml from disk (our own output) or fetch remote URL
  if (source.category === 'epg') {
    let content
    // If the URL points to ourselves, read from disk directly to avoid circular HTTP
    const selfHosts = ['localhost', '127.0.0.1', '0.0.0.0']
    let isLocal = false
    try { isLocal = selfHosts.some(h => new URL(source.url).hostname === h) } catch {}

    if (isLocal) {
      if (!existsSync(GUIDE_XML)) {
        throw new Error('guide.xml not yet generated — run an EPG grab first from the EPG Scraper page')
      }
      content = readFileSync(GUIDE_XML, 'utf8')
    } else {
      const resp = await fetch(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; M3UManager/1.0)' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching EPG from ${source.url}`)
      content = await resp.text()
    }

    const channelCount = (content.match(/<channel /g) || []).length
    db.prepare(`
      INSERT INTO epg_cache (source_id, content, channel_count, last_fetched)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(source_id) DO UPDATE SET
        content = excluded.content,
        channel_count = excluded.channel_count,
        last_fetched = excluded.last_fetched
    `).run(source.id, content, channelCount)
    db.prepare("UPDATE sources SET last_fetched = datetime('now') WHERE id = ?").run(source.id)
    console.log(`[source] Refreshed EPG "${source.name}" — ${channelCount} channels`)
    // Note: Enrichment is now only run manually or after cron grab completes (not after every source refresh)
    return channelCount
  }

  // Playlist source — fetch channels and store to source_channels
  let channels
  if (source.type === 'xtream') {
    channels = await fetchXtreamChannels(source.url, source.username, source.password)
  } else {
    channels = await fetchAndParseM3U(source.url)
  }

  // Load cleanup rules for this source
  let cleanupRules = []
  try {
    if (source.cleanup_rules) {
      cleanupRules = JSON.parse(source.cleanup_rules).filter(r => r.enabled)
    }
  } catch (e) {
    console.error(`[source] Failed to parse cleanup_rules for "${source.name}":`, e.message)
  }

  const insert = db.prepare(
    'INSERT INTO source_channels (source_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, quality, normalized_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const replace = db.transaction((sid, chs) => {
    db.prepare('DELETE FROM source_channels WHERE source_id = ?').run(sid)

    // Track seen URLs to deduplicate after cleanup (only for non-VOD sources)
    const seenUrls = new Map()
    const isVodSource = source.category === 'vod'

    for (const ch of chs) {
      let channelName = ch.tvg_name || ''

      // Apply cleanup rules before quality extraction and normalization
      for (const rule of cleanupRules) {
        try {
          if (rule.useRegex) {
            const regex = new RegExp(rule.find, rule.flags || 'gi')
            channelName = channelName.replace(regex, rule.replace || '')
          } else {
            // Simple string replacement (case-insensitive)
            const regex = new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
            channelName = channelName.replace(regex, rule.replace || '')
          }
        } catch (e) {
          console.error(`[source] Cleanup rule failed for "${source.name}":`, e.message)
        }
      }

      // Extract quality and clean the channel name
      const { cleanedName, quality } = extractQuality(channelName.trim())
      const normalizedName = normalizeChannelName(cleanedName)

      // Deduplicate by URL - keep first occurrence (skip for VOD sources)
      if (!isVodSource && seenUrls.has(ch.url)) {
        if (process.env.DEBUG) {
          console.log(`[source] Skipping duplicate URL: "${cleanedName}" (same as "${seenUrls.get(ch.url)}")`)
        }
        continue
      }
      if (!isVodSource) {
        seenUrls.set(ch.url, cleanedName)
      }

      insert.run(
        sid,
        ch.tvg_id || '',
        cleanedName,
        ch.tvg_logo || '',
        ch.group_title || 'Ungrouped',
        ch.url,
        ch.raw_extinf || '',
        quality,
        normalizedName
      )

      // Update playlist_channels with cleaned name for channels with this URL
      const updated = db.prepare('UPDATE playlist_channels SET tvg_name = ? WHERE url = ?')
        .run(cleanedName, ch.url)
      if (updated.changes > 0 && process.env.DEBUG) {
        console.log(`[source] Updated ${updated.changes} playlist channel(s): "${ch.tvg_name || ''}" -> "${cleanedName}"`)
      }
    }
    db.prepare("UPDATE sources SET last_fetched = datetime('now') WHERE id = ?").run(sid)
  })
  replace(source.id, channels)
  console.log(`[source] Refreshed "${source.name}" — ${channels.length} channels`)
  return channels.length
}

/**
 * Normalize channel name for grouping (lowercase, no spaces, no special chars)
 */
function normalizeChannelName(name) {
  let normalized = name.toLowerCase()

  // Remove quality indicators
  normalized = normalized.replace(/\b(hd|fhd|uhd|4k|sd|hevc|h\.?265)\b/gi, '')

  // Remove all non-alphanumeric characters
  normalized = normalized.replace(/[^a-z0-9]/g, '')

  return normalized
}

/**
 * Extract quality from channel name and return cleaned name + quality
 * Detects: HD, FHD, UHD, 4K, SD, 720p, 1080p, 2160p, etc.
 */
function extractQuality(name) {
  const qualityPatterns = [
    { regex: /\b(UHD|4K|2160p)\b/i, quality: 'UHD' },
    { regex: /\b(FHD|1080p)\b/i, quality: 'FHD' },
    { regex: /\b(HD|720p)\b/i, quality: 'HD' },
    { regex: /\bSD\b/i, quality: 'SD' },
  ]

  let quality = ''
  let cleanedName = name

  for (const { regex, quality: q } of qualityPatterns) {
    if (regex.test(name)) {
      quality = q
      // Remove the quality tag from the name
      cleanedName = name.replace(regex, '').trim()
      // Clean up multiple spaces and trim
      cleanedName = cleanedName.replace(/\s+/g, ' ').trim()
      break
    }
  }

  return { cleanedName, quality }
}

// Refresh a source — fetch live, store to DB cache
app.post('/api/sources/:id/refresh', async (req, res) => {
  try {
    const count = await refreshSourceCache(req.params.id)
    res.json({ ok: true, count })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Get groups across ALL sources (prefixed with source name to avoid collisions)
app.get('/api/sources/all/groups', (req, res) => {
  const playlistId = req.query.playlist_id ? parseInt(req.query.playlist_id) : null

  // Determine category filter based on playlist type
  let categoryFilter
  if (playlistId) {
    const playlist = db.prepare('SELECT playlist_type FROM playlists WHERE id = ?').get(playlistId)
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
    categoryFilter = playlist.playlist_type === 'vod' ? "category != 'epg'" : "category = 'playlist'"
  } else {
    categoryFilter = "category = 'playlist'"
  }

  // Single optimized query with JOIN instead of loop
  const rows = db.prepare(`
    SELECT
      s.id as source_id,
      s.name as source_name,
      sc.group_title,
      COUNT(*) as count
    FROM source_channels sc
    JOIN sources s ON s.id = sc.source_id
    WHERE s.${categoryFilter}
    GROUP BY s.id, s.name, sc.group_title
    ORDER BY s.name, sc.group_title
  `).all()

  const groups = rows.map(r => ({
    name:        `${r.source_name} › ${r.group_title}`,
    display:     r.group_title,
    source_id:   r.source_id,
    source_name: r.source_name,
    count:       r.count,
  }))

  const total = groups.reduce((s, g) => s + g.count, 0)
  res.json({ groups, total, cached: groups.length > 0 })
})

// Get channels for a prefixed group key across all sources
app.get('/api/sources/all/channels', (req, res) => {
  const groupKey = req.query.group  // e.g. "ky-tv › Sports"
  const limit    = Math.min(parseInt(req.query.limit  || '2000'), 5000)
  const offset   = parseInt(req.query.offset || '0')

  const cacheKey = `all:${groupKey || 'all'}:${limit}:${offset}`
  const cached = getCached(cacheKey)
  if (cached) return res.json(cached)

  if (!groupKey) {
    const total = db.prepare('SELECT COUNT(*) as c FROM source_channels').get().c
    const rows = db.prepare(`
      SELECT sc.id,sc.tvg_id,sc.tvg_name,sc.tvg_logo,sc.group_title,sc.url,sc.source_id,s.name as source_name
      FROM source_channels sc
      JOIN sources s ON s.id = sc.source_id
      ORDER BY sc.id LIMIT ? OFFSET ?
    `).all(limit, offset)
    const result = {
      total, offset, limit,
      channels: rows.map(r => ({
        id:          String(r.id),
        name:        r.tvg_name,
        logo:        r.tvg_logo,
        group:       `${r.source_name} › ${r.group_title}`,
        group_title: r.group_title,
        source_id:   r.source_id,
        source_name: r.source_name,
        url:         r.url,
        tvg_id:      r.tvg_id,
      }))
    }
    setCache(cacheKey, result)
    return res.json(result)
  }
  // Parse "sourceName › groupTitle" key
  const sep = ' › '
  const sepIdx = groupKey.indexOf(sep)
  if (sepIdx === -1) return res.status(400).json({ error: 'Invalid group key format' })
  const sourceName = groupKey.slice(0, sepIdx)
  const groupTitle = groupKey.slice(sepIdx + sep.length)
  const source = db.prepare('SELECT * FROM sources WHERE name = ?').get(sourceName)
  if (!source) return res.status(404).json({ error: `Source "${sourceName}" not found` })
  const total = db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE source_id = ? AND group_title = ?').get(source.id, groupTitle).c
  const rows = db.prepare(
    'SELECT id,tvg_id,tvg_name,tvg_logo,group_title,url,source_id,normalized_name,quality FROM source_channels WHERE source_id = ? AND group_title = ? ORDER BY id LIMIT ? OFFSET ?'
  ).all(source.id, groupTitle, limit, offset)
  const result = {
    total, offset, limit,
    channels: rows.map(r => ({
      id:              String(r.id),
      name:            r.tvg_name,
      logo:            r.tvg_logo,
      group:           groupKey,
      group_title:     r.group_title,
      source_id:       r.source_id,
      source_name:     sourceName,
      url:             r.url,
      tvg_id:          r.tvg_id,
      normalized_name: r.normalized_name,
      quality:         r.quality,
    }))
  }
  setCache(cacheKey, result)
  res.json(result)
})

// Get groups from DB cache
app.get('/api/sources/:id/groups', (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id)
  if (!source) return res.status(404).json({ error: 'Source not found' })
  const rows = db.prepare(
    'SELECT group_title, COUNT(*) as count FROM source_channels WHERE source_id = ? GROUP BY group_title ORDER BY group_title'
  ).all(source.id)
  const total = rows.reduce((s, r) => s + r.count, 0)
  res.json({
    groups: rows.map(r => ({ name: r.group_title, count: r.count })),
    total,
    last_fetched: source.last_fetched,
    cached: rows.length > 0,
  })
})

// Get channels for a specific group from DB cache
app.get('/api/sources/:id/channels', (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id)
  if (!source) return res.status(404).json({ error: 'Source not found' })
  const group  = req.query.group
  const limit  = Math.min(parseInt(req.query.limit  || '2000'), 5000)
  const offset = parseInt(req.query.offset || '0')

  const cacheKey = `src:${req.params.id}:${group || 'all'}:${limit}:${offset}`
  const cached = getCached(cacheKey)
  if (cached) return res.json(cached)

  const total  = group
    ? db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE source_id = ? AND group_title = ?').get(source.id, group).c
    : db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE source_id = ?').get(source.id).c
  const rows = group
    ? db.prepare('SELECT id,tvg_id,tvg_name,tvg_logo,group_title,url,source_id,normalized_name,quality FROM source_channels WHERE source_id = ? AND group_title = ? ORDER BY id LIMIT ? OFFSET ?').all(source.id, group, limit, offset)
    : db.prepare('SELECT id,tvg_id,tvg_name,tvg_logo,group_title,url,source_id,normalized_name,quality FROM source_channels WHERE source_id = ? ORDER BY id LIMIT ? OFFSET ?').all(source.id, limit, offset)

  const result = {
    total, offset, limit,
    channels: rows.map(r => ({
      id:              String(r.id),
      name:            r.tvg_name,
      logo:            r.tvg_logo,
      group:           r.group_title,
      url:             r.url,
      tvg_id:          r.tvg_id,
      group_title:     r.group_title,
      source_id:       r.source_id,
      normalized_name: r.normalized_name,
      quality:         r.quality,
    }))
  }

  setCache(cacheKey, result)
  res.json(result)
})

// ── Playlists ─────────────────────────────────────────────────────────────────
app.get('/api/playlists', (req, res) => {
  const playlists = db.prepare('SELECT * FROM playlists ORDER BY name').all()
  if (!playlists.length) return res.json([])

  // Single query for counts per playlist
  const counts = db.prepare(`
    SELECT playlist_id,
           COUNT(*)                    AS channel_count,
           COUNT(DISTINCT group_title) AS group_count,
           COUNT(DISTINCT source_id)   AS source_count
    FROM playlist_channels
    GROUP BY playlist_id
  `).all()
  const countMap = new Map(counts.map(r => [r.playlist_id, r]))

  // Single query for first 5 group names per playlist
  const groupRows = db.prepare(`
    SELECT playlist_id, group_title
    FROM (
      SELECT playlist_id, group_title,
             ROW_NUMBER() OVER (PARTITION BY playlist_id ORDER BY group_title) AS rn
      FROM (SELECT DISTINCT playlist_id, group_title FROM playlist_channels WHERE group_title != '')
    )
    WHERE rn <= 5
    ORDER BY playlist_id, group_title
  `).all()
  const groupMap = {}
  for (const r of groupRows) {
    if (!groupMap[r.playlist_id]) groupMap[r.playlist_id] = []
    groupMap[r.playlist_id].push(r.group_title)
  }

  for (const p of playlists) {
    const c = countMap.get(p.id)
    p.channel_count = c?.channel_count ?? 0
    p.group_count   = c?.group_count   ?? 0
    p.source_count  = c?.source_count  ?? 0
    p.group_names   = groupMap[p.id]   ?? []
  }
  res.json(playlists)
})

app.post('/api/playlists', (req, res) => {
  const { name, source_id, output_path, schedule, playlist_type } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const result = db.prepare(
    'INSERT INTO playlists (name, source_id, output_path, schedule, playlist_type) VALUES (?, ?, ?, ?, ?)'
  ).run(name, source_id || null, output_path || null, schedule || '0 */6 * * *', playlist_type || 'live')
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(result.lastInsertRowid))
})

app.put('/api/playlists/:id', (req, res) => {
  const { name, source_id, output_path, schedule, playlist_type } = req.body
  db.prepare(
    'UPDATE playlists SET name=?, source_id=?, output_path=?, schedule=?, playlist_type=? WHERE id=?'
  ).run(name, source_id || null, output_path || null, schedule || '0 */6 * * *', playlist_type || 'live', req.params.id)
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id))
})

// VOD: list all groups from source_channels for a given source
app.get('/api/sources/:id/vod-groups', (req, res) => {
  const rows = db.prepare(
    `SELECT group_title, COUNT(*) as count FROM source_channels
     WHERE source_id = ? AND group_title != ''
     GROUP BY group_title ORDER BY group_title`
  ).all(req.params.id)
  res.json(rows)
})

// VOD: get channels from source_channels for specific groups
app.get('/api/sources/:id/vod-channels', (req, res) => {
  const groups = req.query.groups ? req.query.groups.split(',') : []
  const search = req.query.search || ''
  const limit  = Math.min(parseInt(req.query.limit || '200'), 1000)
  const offset = parseInt(req.query.offset || '0')
  let rows
  if (groups.length) {
    const placeholders = groups.map(() => '?').join(',')
    const pattern = search ? `%${search}%` : null
    if (pattern) {
      rows = db.prepare(
        `SELECT * FROM source_channels WHERE source_id = ? AND group_title IN (${placeholders}) AND tvg_name LIKE ? ORDER BY group_title, tvg_name LIMIT ? OFFSET ?`
      ).all(req.params.id, ...groups, pattern, limit, offset)
    } else {
      rows = db.prepare(
        `SELECT * FROM source_channels WHERE source_id = ? AND group_title IN (${placeholders}) ORDER BY group_title, tvg_name LIMIT ? OFFSET ?`
      ).all(req.params.id, ...groups, limit, offset)
    }
  } else {
    const pattern = search ? `%${search}%` : '%'
    rows = db.prepare(
      `SELECT * FROM source_channels WHERE source_id = ? AND tvg_name LIKE ? ORDER BY group_title, tvg_name LIMIT ? OFFSET ?`
    ).all(req.params.id, pattern, limit, offset)
  }
  res.json(rows)
})

app.delete('/api/playlists/:id', (req, res) => {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// PATCH schedule only — used by the scheduler UI
app.patch('/api/playlists/:id/schedule', (req, res) => {
  const { schedule } = req.body
  if (schedule && !cron.validate(schedule)) return res.status(400).json({ error: 'Invalid cron expression' })
  db.prepare('UPDATE playlists SET schedule = ? WHERE id = ?').run(schedule || null, req.params.id)
  res.json({ ok: true })
})

// GET all playlist schedules (for the settings scheduler UI)
app.get('/api/playlists/schedules', (req, res) => {
  const playlists = db.prepare('SELECT id, name, schedule, last_built, output_path, (SELECT COUNT(*) FROM playlist_channels WHERE playlist_id = playlists.id) as channel_count FROM playlists ORDER BY name').all()
  res.json(playlists.map(p => ({
    ...p,
    schedule_valid: p.schedule ? cron.validate(p.schedule) : false,
  })))
})

// Get channels in a playlist
app.get('/api/playlists/:id/channels', (req, res) => {
  res.json(db.prepare('SELECT * FROM playlist_channels WHERE playlist_id = ? ORDER BY sort_order, id').all(req.params.id))
})

// Get selection map for a playlist — returns { groups: {groupName: [sourceChannelId,...]}, overrides: {...} }
// Joins playlist_channels with source_channels by URL to recover the source channel IDs the browser uses
// groupKey format matches the browser: single-source = group_title, all-sources = "sourceName › group_title"
app.get('/api/playlists/:id/selection', (req, res) => {
  const playlistId = req.params.id

  // Get total channel count for this playlist
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM playlist_channels WHERE playlist_id = ?').get(playlistId).count

  // Compare playlist group counts vs source group counts.
  // Use sc.group_title (original source group) for selection keys, not pc.group_title (renamed groups).
  // Resolve source/group from source_channels by URL for legacy rows where source_id may be null.
  const pcGroups = db.prepare(`
    SELECT
      sc.group_title                        AS group_title,
      COALESCE(pc.source_id, sc.source_id)  AS source_id,
      s.name                                AS source_name,
      COUNT(*)                              AS pc_count,
      (
        SELECT COUNT(*)
        FROM source_channels sc2
        WHERE sc2.source_id = COALESCE(pc.source_id, sc.source_id)
          AND sc2.group_title = sc.group_title
      ) AS sc_count
    FROM playlist_channels pc
    LEFT JOIN source_channels sc ON sc.url = pc.url
    LEFT JOIN sources s ON s.id = COALESCE(pc.source_id, sc.source_id)
    WHERE pc.playlist_id = ?
      AND s.name IS NOT NULL
      AND sc.group_title IS NOT NULL
    GROUP BY sc.group_title, COALESCE(pc.source_id, sc.source_id), s.name
  `).all(playlistId)

  if (!pcGroups.length) return res.json({ groups: {}, overrides: {}, totalCount: 0 })

  const groups = {}
  const partialGroups = []

  for (const pg of pcGroups) {
    // Always prefix with source name — browser always uses "sourceName › groupTitle" keys
    const grpKey = `${pg.source_name} \u203a ${pg.group_title}`
    if (pg.pc_count >= pg.sc_count) {
      groups[grpKey] = '__all__'
    } else {
      partialGroups.push({ grpKey, source_id: pg.source_id, group_title: pg.group_title })
    }
  }

  // Step 3: only do the expensive URL JOIN for partial groups (rare case)
  const overrides = {}
  for (const pg of partialGroups) {
    const rows = db.prepare(`
      SELECT sc.id as sc_id, pc.sort_order, pc.custom_tvg_id, pc.group_title as pc_group,
             pc.epg_source_id, pc.tvg_name as pc_name, sc.tvg_name as sc_name, sc.group_title
      FROM playlist_channels pc
      JOIN source_channels sc ON sc.url = pc.url
      JOIN sources s ON s.id = sc.source_id
      WHERE pc.playlist_id = ?
        AND s.name = ?
        AND sc.group_title = ?
      ORDER BY pc.sort_order, pc.id
    `).all(playlistId, pg.grpKey.split(' › ')[0], pg.group_title)
    const ids = []
    for (const r of rows) {
      ids.push(String(r.sc_id))
      const ov = {}
      if (r.sort_order > 0)                            ov.sort_order    = r.sort_order
      if (r.custom_tvg_id)                             ov.custom_tvg_id = r.custom_tvg_id
      if (r.pc_group && r.pc_group !== r.group_title)  ov.group_title   = r.pc_group
      if (r.epg_source_id)                             ov.epg_source_id = r.epg_source_id
      if (r.pc_name && r.pc_name !== r.sc_name)        ov.tvg_name      = r.pc_name
      if (Object.keys(ov).length) overrides[String(r.sc_id)] = ov
    }
    groups[pg.grpKey] = ids
  }

  res.json({ groups, overrides, totalCount })
})

// Get other source variants for a channel (by source_channel id)
app.get('/api/source-channels/:id/variants', (req, res) => {
  const sourceChannel = db.prepare('SELECT normalized_name, tvg_name FROM source_channels WHERE id = ?').get(req.params.id)
  if (!sourceChannel || !sourceChannel.normalized_name) {
    return res.json([])
  }

  // Find all channels with the same normalized name from different sources
  const variants = db.prepare(`
    SELECT
      sc.id,
      sc.tvg_name,
      sc.quality,
      sc.url,
      sc.group_title,
      s.id as source_id,
      s.name as source_name
    FROM source_channels sc
    JOIN sources s ON sc.source_id = s.id
    WHERE sc.normalized_name = ?
    ORDER BY
      s.name,
      CASE sc.quality
        WHEN 'UHD' THEN 1
        WHEN 'FHD' THEN 2
        WHEN 'HD' THEN 3
        WHEN 'SD' THEN 4
        ELSE 5
      END
  `).all(sourceChannel.normalized_name)

  res.json(variants)
})

// Bulk fetch variants for multiple channels
app.post('/api/source-channels/bulk-variants', (req, res) => {
  const { channelIds } = req.body

  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.json([])
  }

  const results = []

  for (const channelId of channelIds) {
    // Get the channel from source_channels (not playlist_channels)
    const channel = db.prepare('SELECT * FROM source_channels WHERE id = ?').get(channelId)
    if (!channel || !channel.normalized_name) continue

    // Find all variants with the same normalized name from DIFFERENT sources
    // Return FULL channel objects so frontend can use them directly with toggleChannel
    const variants = db.prepare(`
      SELECT sc.*
      FROM source_channels sc
      JOIN sources s ON sc.source_id = s.id
      WHERE sc.normalized_name = ?
        AND sc.source_id != ?
      ORDER BY
        COALESCE(s.priority, 999) ASC,
        CASE sc.quality
          WHEN 'UHD' THEN 1
          WHEN 'FHD' THEN 2
          WHEN 'HD' THEN 3
          WHEN 'SD' THEN 4
          ELSE 5
        END
    `).all(channel.normalized_name, channel.source_id)

    if (variants.length > 0) {
      results.push({
        channel: {
          id: channel.id,
          tvg_name: channel.tvg_name,
          group_title: channel.group_title,
          source_id: channel.source_id
        },
        variants
      })
    }
  }

  res.json(results)
})

// Save channels to a playlist (replaces all existing)
app.put('/api/playlists/:id/channels', (req, res) => {
  const { channels } = req.body // array of channel objects
  if (!Array.isArray(channels)) return res.status(400).json({ error: 'channels must be array' })
  const insert = db.prepare(
    'INSERT INTO playlist_channels (playlist_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, custom_tvg_id, sort_order, source_id, epg_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const replaceAll = db.transaction((playlistId, chs) => {
    db.prepare('DELETE FROM playlist_channels WHERE playlist_id = ?').run(playlistId)
    chs.forEach((ch, i) => {
      insert.run(playlistId, ch.tvg_id || '', ch.tvg_name, ch.tvg_logo || '', ch.group_title || '', ch.url, ch.raw_extinf || '', ch.custom_tvg_id || '', ch.sort_order ?? i, ch.source_id || null, ch.epg_source_id || null)
    })
  })
  replaceAll(req.params.id, channels)
  res.json({ ok: true, count: channels.length })
})

// Save playlist by group selections — server resolves channels from source_channels directly
// Body: { sourceId: number|null, groups: { groupName: '__all__' | number[] }, overrides: { [channelId]: { sort_order, custom_tvg_id, group_title, epg_source_id, tvg_name } } }
app.put('/api/playlists/:id/channels-by-groups', (req, res) => {
  const { sourceId, groups, overrides = {} } = req.body
  if (!groups || typeof groups !== 'object') return res.status(400).json({ error: 'groups required' })

  const insert = db.prepare(
    'INSERT INTO playlist_channels (playlist_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, custom_tvg_id, sort_order, source_id, epg_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  const replaceAll = db.transaction((playlistId) => {
    db.prepare('DELETE FROM playlist_channels WHERE playlist_id = ?').run(playlistId)
    let i = 0
    for (const [groupName, sel] of Object.entries(groups)) {
      if (!sel || (Array.isArray(sel) && sel.length === 0)) continue
      let rows
      if (sel === '__all__') {
        if (sourceId === null || sourceId === undefined) {
          // All sources mode — group key is "sourceName › groupTitle", match by group_title suffix
          const parts = groupName.split(' › ')
          const gt = parts.length > 1 ? parts[parts.length - 1] : groupName
          rows = db.prepare('SELECT * FROM source_channels WHERE group_title = ?').all(gt)
        } else {
          rows = db.prepare('SELECT * FROM source_channels WHERE source_id = ? AND group_title = ?').all(sourceId, groupName)
        }
      } else {
        // Array of specific channel IDs
        const ids = sel
        if (!ids.length) continue
        const placeholders = ids.map(() => '?').join(',')
        rows = db.prepare(`SELECT * FROM source_channels WHERE id IN (${placeholders})`).all(...ids)
      }
      for (const ch of rows) {
        const ov = overrides[ch.id] || {}
        insert.run(
          playlistId,
          ch.tvg_id || '',
          ov.tvg_name || ch.tvg_name,
          ch.tvg_logo || '',
          ov.group_title || ch.group_title || '',
          ch.url,
          ch.raw_extinf || '',
          ov.custom_tvg_id || '',
          ov.sort_order ?? i,
          ch.source_id || null,
          ov.epg_source_id ? Number(ov.epg_source_id) : null
        )
        i++
      }
    }
    return i
  })

  const count = replaceAll(req.params.id)
  res.json({ ok: true, count })
})

// Get group order for a playlist
app.get('/api/playlists/:id/group-order', (req, res) => {
  const playlist = db.prepare('SELECT group_order FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Not found' })
  const groups = db.prepare("SELECT DISTINCT group_title FROM playlist_channels WHERE playlist_id = ? AND group_title != '' ORDER BY group_title").all(req.params.id).map(r => r.group_title)
  const saved  = playlist.group_order ? JSON.parse(playlist.group_order) : []
  // Merge: saved order first, then any new groups not yet in saved order
  const ordered = [...saved.filter(g => groups.includes(g)), ...groups.filter(g => !saved.includes(g))]
  res.json({ order: ordered })
})

// Save group order for a playlist
app.put('/api/playlists/:id/group-order', (req, res) => {
  const { order } = req.body
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' })
  db.prepare('UPDATE playlists SET group_order = ? WHERE id = ?').run(JSON.stringify(order), req.params.id)
  res.json({ ok: true })
})

// Build and save M3U to disk for a playlist
app.post('/api/playlists/:id/build', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })

  // Auto-derive output path from playlist name if not set
  if (!playlist.output_path) {
    const OUTPUT_DIR = process.env.OUTPUT_DIR || '/output'
    const slug = playlist.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    playlist.output_path = `${OUTPUT_DIR}/${slug}.m3u`
    db.prepare('UPDATE playlists SET output_path = ? WHERE id = ?').run(playlist.output_path, playlist.id)
    console.log(`[playlist] Auto-set output_path="${playlist.output_path}" for "${playlist.name}"`)
  }

  // Get all channels with their normalized names and deduplicate
  const allChannels = db.prepare(`
    SELECT
      pc.*,
      sc.normalized_name,
      COALESCE(s.priority, 999) as source_priority,
      CASE sc.quality
        WHEN 'UHD' THEN 1
        WHEN 'FHD' THEN 2
        WHEN 'HD' THEN 3
        WHEN 'SD' THEN 4
        ELSE 5
      END as quality_order
    FROM playlist_channels pc
    LEFT JOIN source_channels sc ON sc.url = pc.url
    LEFT JOIN sources s ON s.id = COALESCE(pc.source_id, sc.source_id)
    WHERE pc.playlist_id = ?
    ORDER BY
      sc.normalized_name,
      source_priority ASC,
      quality_order ASC,
      pc.sort_order, pc.id
  `).all(playlist.id)

  // Deduplicate by normalized_name - keep only the first (best) variant
  // Channels without normalized_name are kept as-is (no deduplication)
  const seen = new Set()
  let channels = allChannels.filter(ch => {
    if (!ch.normalized_name) return true // Keep channels without normalized_name
    if (seen.has(ch.normalized_name)) return false // Skip duplicates
    seen.add(ch.normalized_name)
    return true
  })

  const epgRows = db.prepare('SELECT * FROM epg_mappings').all()
  const epgMap = new Map(epgRows.map(r => [r.source_tvg_id, r.target_tvg_id]))
  if (playlist.group_order) {
    const order = JSON.parse(playlist.group_order)
    channels = [...channels].sort((a, b) => {
      const ai = order.indexOf(a.group_title); const bi = order.indexOf(b.group_title)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi) || a.sort_order - b.sort_order
    })
  }

  const content = buildM3U(channels, epgMap)
  try {
    writeM3U(playlist.output_path, content)
    db.prepare('UPDATE playlists SET last_built = datetime("now") WHERE id = ?').run(playlist.id)
    res.json({ ok: true, path: playlist.output_path, channels: channels.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/playlists/:id/m3u', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })

  // Get all channels with their normalized names and deduplicate
  const allChannels = db.prepare(`
    SELECT
      pc.id, pc.tvg_id, pc.tvg_name, pc.tvg_logo, pc.group_title,
      pc.url, pc.sort_order, pc.source_id, pc.epg_source_id,
      sc.normalized_name,
      COALESCE(s.priority, 999) as source_priority,
      CASE sc.quality
        WHEN 'UHD' THEN 1
        WHEN 'FHD' THEN 2
        WHEN 'HD' THEN 3
        WHEN 'SD' THEN 4
        ELSE 5
      END as quality_order
    FROM playlist_channels pc
    LEFT JOIN source_channels sc ON sc.url = pc.url
    LEFT JOIN sources s ON s.id = COALESCE(pc.source_id, sc.source_id)
    WHERE pc.playlist_id = ?
    ORDER BY
      sc.normalized_name,
      source_priority ASC,
      quality_order ASC,
      pc.sort_order, pc.id
  `).all(playlist.id)

  // Deduplicate by normalized_name - keep only the first (best) variant
  // Channels without normalized_name are kept as-is (no deduplication)
  const seen = new Set()
  let channels = allChannels.filter(ch => {
    if (!ch.normalized_name) return true // Keep channels without normalized_name
    if (seen.has(ch.normalized_name)) return false // Skip duplicates
    seen.add(ch.normalized_name)
    return true
  })

  const epgRows   = db.prepare('SELECT * FROM epg_mappings').all()
  const epgMap    = new Map(epgRows.map(r => [r.source_tvg_id, r.target_tvg_id]))
  if (playlist.group_order) {
    const order = JSON.parse(playlist.group_order)
    channels = [...channels].sort((a, b) => {
      const ai = order.indexOf(a.group_title); const bi = order.indexOf(b.group_title)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi) || a.sort_order - b.sort_order
    })
  }

  const proto   = req.headers['x-forwarded-proto'] || req.protocol
  const host    = req.headers['x-forwarded-host']  || req.headers.host
  const baseUrl = `${proto}://${host}`
  const epgUrl  = existsSync(GUIDE_XML) ? `${baseUrl}/guide.xml` : ''

  const catchupSrc  = process.env.CATCHUP_SOURCE  || ''
  const catchupDays = parseInt(process.env.CATCHUP_DAYS || '7')

  const content = buildM3U(channels, epgMap, { baseUrl, epgUrl, catchupSrc: catchupSrc || undefined, catchupDays })

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
  res.setHeader('Content-Disposition', `inline; filename="${playlist.name}.m3u"`)
  res.send(content)
})

// Per-playlist XMLTV — generates clean feed from playlist channels and their EPG mappings
app.get('/api/playlists/:id/xmltv', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })

  // Get all channels with their normalized names and deduplicate
  const allChannels = db.prepare(`
    SELECT pc.*,
           sc.normalized_name,
           COALESCE(s.priority, 999) as source_priority,
           CASE sc.quality
             WHEN 'UHD' THEN 1
             WHEN 'FHD' THEN 2
             WHEN 'HD' THEN 3
             WHEN 'SD' THEN 4
             ELSE 5
           END as quality_order,
           CASE
             WHEN pc.custom_tvg_id != '' THEN pc.custom_tvg_id
             WHEN em.target_tvg_id IS NOT NULL THEN em.target_tvg_id
             ELSE pc.tvg_id
           END as epg_id
    FROM playlist_channels pc
    LEFT JOIN source_channels sc ON sc.url = pc.url
    LEFT JOIN sources s ON s.id = COALESCE(pc.source_id, sc.source_id)
    LEFT JOIN epg_mappings em ON (em.source_tvg_id = pc.tvg_id OR em.source_tvg_id = pc.custom_tvg_id)
    WHERE pc.playlist_id = ?
    ORDER BY
      sc.normalized_name,
      source_priority ASC,
      quality_order ASC,
      pc.sort_order, pc.id
  `).all(playlist.id)

  // Deduplicate by normalized_name - keep only the first (best) variant
  // Channels without normalized_name are kept as-is (no deduplication)
  const seen = new Set()
  const channels = allChannels.filter(ch => {
    if (!ch.normalized_name) return true // Keep channels without normalized_name
    if (seen.has(ch.normalized_name)) return false // Skip duplicates
    seen.add(ch.normalized_name)
    return true
  })

  // Re-sort by sort_order after deduplication
  channels.sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.id - b.id
  })

  // Filter to channels with EPG data
  const mappedChannels = channels.filter(ch => ch.epg_id && ch.epg_id.trim())

  if (!mappedChannels.length) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="m3u-manager"></tv>`)
  }

  // Get EPG data for mapped channels
  const epgIds = mappedChannels.map(ch => ch.epg_id)
  const cacheRows = db.prepare(`
    SELECT content FROM epg_cache WHERE content IS NOT NULL
  `).all()

  // Also get scraper channels
  const scraperChannels = db.prepare(`
    SELECT * FROM epg_site_channels WHERE xmltv_id IN (` + epgIds.map(() => '?').join(',') + `)
  `).all(epgIds)

  // Build channel XML from playlist
  const channels_xml = mappedChannels.map(ch => {
    const displayName = ch.tvg_name || ch.name || 'Unknown'
    const logo = ch.tvg_logo || ch.custom_logo || ''

    // Use the original tvg_id from the M3U file as the primary ID
    // This ensures consistency between M3U and XMLTV
    const primaryId = ch.tvg_id || ch.custom_tvg_id || ch.epg_id

    let xml = `  <channel id="${primaryId}">`
    xml += `\n    <display-name>${escapeXml(displayName)}</display-name>`
    if (logo) {
      // Proxy the logo URL through our server for Plex compatibility
      const proxyLogoUrl = `http://${req.headers.host}/api/logo?url=${encodeURIComponent(logo)}`
      xml += `\n    <icon src="${escapeXml(proxyLogoUrl)}" />`
    }

    // If the EPG ID is different from the primary ID, add it as an alias
    if (ch.epg_id && ch.epg_id !== primaryId) {
      xml += `\n    <alias>${escapeXml(ch.epg_id)}</alias>`
    }

    xml += `\n  </channel>`
    return xml
  })

  // Get programme data from cache and scraper
  const programmes_xml = []
  const wantedIds = new Set(epgIds)

  // Create a mapping between EPG IDs and original channel IDs
  const idMapping = {}
  mappedChannels.forEach(ch => {
    const primaryId = ch.tvg_id || ch.custom_tvg_id || ch.epg_id
    if (ch.epg_id && ch.epg_id !== primaryId) {
      idMapping[ch.epg_id] = primaryId
    }
  })

  // Get TMDB enrichment data
  const { showMap, epMap } = getEnrichmentMaps()

  // From cache
  for (const row of cacheRows) {
    const progRe = /<programme\b[^>]*channel="([^"]*)"[^>]*>[\s\S]*?<\/programme>/g
    let m
    while ((m = progRe.exec(row.content)) !== null) {
      const channelId = m[1]
      if (wantedIds.has(channelId)) {
        // If the programme uses an EPG ID that we've mapped to a primary ID,
        // update the channel attribute to use the primary ID
        let progContent = m[0]

        // Update channel ID if needed
        if (idMapping[channelId]) {
          progContent = progContent.replace(`channel="${channelId}"`, `channel="${idMapping[channelId]}"`)
        }

        // Parse and apply TMDB enrichment
        const prog = parseProgBlock(progContent)
        const enriched = applyEnrichment(prog, showMap, epMap)

        // Add enriched poster if available and not already present
        if (enriched.icon && !/<icon\b/.test(progContent)) {
          const proxyUrl = `http://${req.headers.host}/api/logo?url=${encodeURIComponent(enriched.icon)}`
          progContent = progContent.replace('</programme>', `  <icon src="${proxyUrl}" />\n</programme>`)
        }

        // Add enriched description if available and not already present
        if (enriched.desc && !/<desc\b/.test(progContent)) {
          progContent = progContent.replace('</programme>', `  <desc>${escapeXml(enriched.desc)}</desc>\n</programme>`)
        }

        // Fix any existing icon URLs to use our proxy
        const iconMatch = progContent.match(/<icon\s+src="([^"]+)"\s*\/>/)
        if (iconMatch) {
          const originalUrl = iconMatch[1]
          // Only proxy external URLs, not already proxied ones
          if (!originalUrl.startsWith('/api/logo') && !originalUrl.includes('/api/logo?url=')) {
            const proxyUrl = `http://${req.headers.host}/api/logo?url=${encodeURIComponent(originalUrl)}`
            progContent = progContent.replace(/<icon\s+src="([^"]+)"\s*\/>/, `<icon src="${proxyUrl}" />`)
          }
        }

        programmes_xml.push(progContent)
      }
    }
  }

  // From scraper (if not in cache)
  // Note: scraper data doesn't include programmes, only channel metadata
  // Programmes would need to be fetched from the original EPG sources

  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<tv generator-info-name="m3u-manager">`,
    ...channels_xml,
    ...programmes_xml,
    `</tv>`,
  ].join('\n')

  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.send(out)
})

// Helper function to escape XML special characters
function escapeXml(str) {
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── EPG Mappings ──────────────────────────────────────────────────────────────
app.get('/api/epg-mappings', (req, res) => {
  res.json(db.prepare('SELECT * FROM epg_mappings ORDER BY source_tvg_id').all())
})

app.post('/api/epg-mappings', (req, res) => {
  const { source_tvg_id, target_tvg_id, note } = req.body
  if (!source_tvg_id || !target_tvg_id) return res.status(400).json({ error: 'source_tvg_id and target_tvg_id required' })
  const result = db.prepare(
    'INSERT OR REPLACE INTO epg_mappings (source_tvg_id, target_tvg_id, note) VALUES (?, ?, ?)'
  ).run(source_tvg_id, target_tvg_id, note || null)
  res.json(db.prepare('SELECT * FROM epg_mappings WHERE id = ?').get(result.lastInsertRowid))
})

app.delete('/api/epg-mappings/:id', (req, res) => {
  db.prepare('DELETE FROM epg_mappings WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// Clear all EPG mappings + custom_tvg_id for every channel in a playlist
app.delete('/api/epg-mappings/by-playlist/:playlist_id', (req, res) => {
  const tvgIds = db.prepare(
    `SELECT DISTINCT COALESCE(NULLIF(custom_tvg_id,''), NULLIF(tvg_id,'')) as tid
     FROM playlist_channels WHERE playlist_id = ? AND (tvg_id != '' OR custom_tvg_id != '')`
  ).all(req.params.playlist_id).map(r => r.tid).filter(Boolean)

  const del = db.transaction(() => {
    for (const tid of tvgIds) {
      db.prepare('DELETE FROM epg_mappings WHERE source_tvg_id = ?').run(tid)
    }
    db.prepare('UPDATE playlist_channels SET custom_tvg_id = NULL WHERE playlist_id = ?').run(req.params.playlist_id)
  })
  del()
  res.json({ ok: true, cleared: tvgIds.length })
})

// ── EPG Auto-match ─────────────────────────────────────────────────────────────
// In-memory EPG channel cache — rebuilt when EPG data changes
let _epgListCache = null
let _epgListCacheKey = null

function getEpgList() {
  const cacheRows = db.prepare(`
    SELECT source_id, last_fetched FROM epg_cache WHERE content IS NOT NULL ORDER BY last_fetched DESC
  `).all()
  const cacheKey = cacheRows.map(r => `${r.source_id}:${r.last_fetched}`).join('|')
  if (_epgListCache && _epgListCacheKey === cacheKey) return _epgListCache

  const fullRows = db.prepare(`
    SELECT ec.content, ec.source_id, s.name AS source_name
    FROM epg_cache ec JOIN sources s ON s.id = ec.source_id
    WHERE ec.content IS NOT NULL ORDER BY ec.last_fetched DESC
  `).all()

  const epgList = []
  const epgSeen = new Set()
  for (const cacheRow of fullRows) {
    if (!cacheRow.content) continue
    let currentId = null, currentName = null, currentIcon = ''
    for (const line of cacheRow.content.split('\n')) {
      const trimmed = line.trim()
      if (!currentId) {
        const idMatch = trimmed.match(/<channel\s[^>]*id="([^"]*)"/)
        if (idMatch) {
          currentId = idMatch[1]; currentName = null; currentIcon = ''
          const nameMatch = trimmed.match(/<display-name[^>]*>([^<]+)<\/display-name>/)
          if (nameMatch) currentName = nameMatch[1].trim()
          const iconMatch = trimmed.match(/<icon\s[^>]*src="([^"]*)"/)
          if (iconMatch) currentIcon = iconMatch[1]
          if (trimmed.includes('</channel>')) {
            if (currentId && currentName && !epgSeen.has(currentId)) {
              epgSeen.add(currentId)
              epgList.push({ id: currentId, name: currentName, icon: currentIcon, source_name: cacheRow.source_name, source_id: cacheRow.source_id })
            }
            currentId = null; currentName = null; currentIcon = ''
          }
        }
      } else {
        if (!currentName) {
          const nameMatch = trimmed.match(/<display-name[^>]*>([^<]+)<\/display-name>/)
          if (nameMatch) currentName = nameMatch[1].trim()
        }
        if (!currentIcon) {
          const iconMatch = trimmed.match(/<icon\s[^>]*src="([^"]*)"/)
          if (iconMatch) currentIcon = iconMatch[1]
        }
        if (trimmed.includes('</channel>')) {
          if (currentId && currentName && !epgSeen.has(currentId)) {
            epgSeen.add(currentId)
            epgList.push({ id: currentId, name: currentName, icon: currentIcon, source_name: cacheRow.source_name, source_id: cacheRow.source_id })
          }
          currentId = null; currentName = null; currentIcon = ''
        }
      }
    }
  }
  _epgListCache = epgList
  _epgListCacheKey = cacheKey
  return epgList
}

// Invalidate EPG cache when EPG data is refreshed
function invalidateEpgCache() { _epgListCache = null; _epgListCacheKey = null }

// Dice coefficient similarity — fast, good for channel name matching
function diceSimilarity(a, b) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const s1 = normalize(a), s2 = normalize(b)
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0
  const bigrams1 = new Map()
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2)
    bigrams1.set(bg, (bigrams1.get(bg) || 0) + 1)
  }
  let intersection = 0
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2)
    if (bigrams1.get(bg) > 0) { intersection++; bigrams1.set(bg, bigrams1.get(bg) - 1) }
  }
  return (2 * intersection) / (s1.length + s2.length - 2)
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\b(hd|uhd|fhd|sd|4k|h\.265|hevc|\+1|\(p\))\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// GET /api/epg-mappings/auto-match?playlist_id=X  — returns suggested matches for all channels in playlist
app.get('/api/epg-mappings/auto-match', (req, res) => {
  try {
    const { playlist_id } = req.query
    if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' })

    // Check if playlist exists
    const playlist = db.prepare('SELECT id, name FROM playlists WHERE id = ?').get(playlist_id)
    if (!playlist) return res.status(404).json({ error: `Playlist with ID ${playlist_id} not found` })

    // Get playlist channels, deduplicated by normalized_name (one channel per normalized name)
    const allChannels = db.prepare(`
      SELECT
        pc.id, pc.tvg_id, pc.tvg_name, pc.tvg_logo, pc.custom_logo, pc.custom_tvg_id, pc.epg_source_id, pc.sort_order,
        sc.normalized_name,
        COALESCE(s.priority, 999) as source_priority,
        CASE sc.quality
          WHEN 'UHD' THEN 1
          WHEN 'FHD' THEN 2
          WHEN 'HD' THEN 3
          WHEN 'SD' THEN 4
          ELSE 5
        END as quality_order
      FROM playlist_channels pc
      LEFT JOIN source_channels sc ON sc.url = pc.url
      LEFT JOIN sources s ON s.id = COALESCE(pc.source_id, sc.source_id)
      WHERE pc.playlist_id = ?
      ORDER BY
        pc.sort_order ASC,
        pc.id ASC
    `).all(playlist_id)

    // Deduplicate by normalized_name - keep only the first (best) variant
    // Channels without normalized_name are kept as-is (no deduplication)
    const seen = new Set()
    const playlistChannels = allChannels.filter(ch => {
      if (!ch.normalized_name) return true // Keep channels without normalized_name
      if (seen.has(ch.normalized_name)) return false // Skip duplicates
      seen.add(ch.normalized_name)
      return true
    })

    if (!playlistChannels.length) {
      return res.json({
        matches: [],
        warning: `No channels found in playlist '${playlist.name}' (ID: ${playlist_id})`
      })
    }

    // Use cached EPG list — only re-parses XML when EPG data changes
    const epgList = getEpgList()
    if (!epgList.length) {
      // Check if we have any EPG sources
      const epgSourceCount = db.prepare('SELECT COUNT(*) as count FROM sources WHERE type = "epg"').get()
      if (epgSourceCount.count === 0) {
        return res.json({
          matches: [],
          warning: 'No EPG sources configured. Add an EPG source first.'
        })
      }

      return res.json({
        matches: [],
        warning: 'No EPG data cached yet — refresh an EPG source first'
      })
    }

    // Build lookup maps for O(1) exact ID match and per-source filtering
    const epgById = new Map(epgList.map(e => [e.id, e]))
    const epgBySource = new Map()
    for (const e of epgList) {
      if (!epgBySource.has(e.source_id)) epgBySource.set(e.source_id, [])
      epgBySource.get(e.source_id).push(e)
    }

    const existingMappings = new Map(
      db.prepare('SELECT source_tvg_id, target_tvg_id FROM epg_mappings').all()
        .map(r => [r.source_tvg_id, r.target_tvg_id])
    )

    // Bulk fetch all variants for all playlist channels at once
    const channelIds = playlistChannels.map(ch => ch.id)
    const allVariants = db.prepare(`
      SELECT
        pc.id as channel_id,
        sc.tvg_name,
        sc.quality,
        sc.url,
        s.name as source_name,
        sc.normalized_name
      FROM playlist_channels pc
      JOIN source_channels sc_lookup ON pc.url = sc_lookup.url
      JOIN source_channels sc ON sc.normalized_name = sc_lookup.normalized_name
      JOIN sources s ON sc.source_id = s.id
      WHERE pc.id IN (${channelIds.map(() => '?').join(',')})
      ORDER BY pc.id, CASE sc.quality
        WHEN 'UHD' THEN 1
        WHEN 'FHD' THEN 2
        WHEN 'HD' THEN 3
        WHEN 'SD' THEN 4
        ELSE 5
      END
    `).all(...channelIds)

    // Build variants lookup map
    const variantsMap = new Map()
    for (const v of allVariants) {
      if (!variantsMap.has(v.channel_id)) variantsMap.set(v.channel_id, [])
      variantsMap.get(v.channel_id).push({
        tvg_name: v.tvg_name,
        quality: v.quality,
        url: v.url,
        source_name: v.source_name
      })
    }

    const matches = []
    for (const ch of playlistChannels) {
      const effectiveId    = ch.custom_tvg_id || ch.tvg_id || ''
      const alreadyMapped  = existingMappings.get(effectiveId)
      const preferredSourceId = ch.epg_source_id ? Number(ch.epg_source_id) : null
      const candidateList  = preferredSourceId ? (epgBySource.get(preferredSourceId) ?? []) : epgList

      // O(1) exact ID lookup
      const exactMatch = effectiveId
        ? (preferredSourceId
            ? (epgBySource.get(preferredSourceId) ?? []).find(e => e.id === effectiveId) ?? null
            : epgById.get(effectiveId) ?? null)
        : null

      // Only run Dice if no exact match and not already mapped
      let scored = []
      if (!exactMatch && !alreadyMapped) {
        const normCh = normalizeName(ch.tvg_name)
        scored = candidateList
          .map(epg => ({ ...epg, score: Math.round(diceSimilarity(normCh, normalizeName(epg.name)) * 100) }))
          .filter(e => e.score > 20)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
      }

      // Get variants from pre-fetched map
      const variants = variantsMap.get(ch.id) || []

      matches.push({
        channel_id:    ch.id,
        tvg_id:        effectiveId,
        tvg_name:      ch.tvg_name,
        tvg_logo:      ch.tvg_logo || null,
        custom_logo:   ch.custom_logo || null,
        mapped_to:     alreadyMapped || null,
        exact_match:   exactMatch || null,
        suggestions:   scored,
        epg_source_id: ch.epg_source_id || null,
        variants:      variants || [],
      })
    }

    matches.sort((a, b) => {
      if (a.exact_match && !b.exact_match) return 1
      if (!a.exact_match && b.exact_match) return -1
      return (b.suggestions[0]?.score || 0) - (a.suggestions[0]?.score || 0)
    })

    res.json({ matches, epg_count: epgList.length })
  } catch (err) {
    console.error('Error in auto-match endpoint:', err)
    res.status(500).json({ error: `Server error: ${err.message}` })
  }
})

// Delete a single channel from a playlist
app.delete('/api/playlist-channels/:id', (req, res) => {
  const r = db.prepare('DELETE FROM playlist_channels WHERE id = ?').run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Channel not found' })
  res.json({ ok: true })
})

// Patch custom_logo on a playlist channel
app.patch('/api/playlist-channels/:id/custom-logo', (req, res) => {
  const { custom_logo } = req.body
  if (custom_logo === undefined) return res.status(400).json({ error: 'custom_logo required' })
  db.prepare('UPDATE playlist_channels SET custom_logo = ? WHERE id = ?').run(custom_logo || null, req.params.id)
  res.json({ ok: true })
})

// Patch custom_tvg_id on a playlist channel (used when channel has no tvg_id)
app.patch('/api/playlist-channels/:id/custom-tvg-id', (req, res) => {
  const { custom_tvg_id } = req.body
  if (custom_tvg_id === undefined) return res.status(400).json({ error: 'custom_tvg_id required' })
  db.prepare('UPDATE playlist_channels SET custom_tvg_id = ? WHERE id = ?').run(custom_tvg_id || '', req.params.id)
  res.json({ ok: true })
})

// Bulk accept auto-matches
app.post('/api/epg-mappings/bulk', (req, res) => {
  const { mappings } = req.body // [{source_tvg_id, target_tvg_id}]
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' })
  const insert = db.prepare('INSERT OR REPLACE INTO epg_mappings (source_tvg_id, target_tvg_id, note) VALUES (?, ?, ?)')
  const valid = mappings.filter(r => r.source_tvg_id && r.source_tvg_id.trim())
  const insertAll = db.transaction((rows) => { for (const r of rows) insert.run(r.source_tvg_id, r.target_tvg_id, r.note || 'auto-matched') })
  insertAll(valid)
  res.json({ ok: true, count: valid.length })
})

// ── EPG Scraper ───────────────────────────────────────────────────────────────
// Use EPG_DIR from epgGrab.js (imported as GRAB_EPG_DIR)
const EPG_DIR        = GRAB_EPG_DIR
const CHANNELS_XML   = path.join(EPG_DIR, 'channels.xml')
const GUIDE_XML_URL  = process.env.GUIDE_XML_URL  || `http://127.0.0.1:${process.env.PORT || 3005}/guide.xml`

// Track in-progress sync so we don't double-run
let syncInProgress = false
let syncLog = []

// Trigger a sync (non-blocking — streams progress via syncLog)
async function runSync() {
  if (syncInProgress) return { already: true }
  syncInProgress = true
  syncLog = []
  try {
    const result = await syncEpgSites(db, {
      onProgress: (msg) => { syncLog.push(msg); if (syncLog.length > 100) syncLog.shift() }
    })
    return result
  } finally {
    syncInProgress = false
  }
}

// Sync status
app.get('/api/epg/sites/sync/status', (req, res) => {
  res.json({
    inProgress:  syncInProgress,
    lastSynced:  getLastSynced(db),
    totalSites:  db.prepare('SELECT COUNT(DISTINCT site) as c FROM epg_site_channels').get().c,
    totalChannels: db.prepare('SELECT COUNT(*) as c FROM epg_site_channels').get().c,
    log:         syncLog.slice(-20),
  })
})

// Trigger a sync
app.post('/api/epg/sites/sync', async (req, res) => {
  if (syncInProgress) return res.json({ ok: true, already: true, message: 'Sync already in progress' })
  // Start async, respond immediately
  res.json({ ok: true, message: 'Sync started' })
  runSync().catch(e => console.error('[epg-sync] Error:', e.message))
})

// List all sites from DB
app.get('/api/epg/sites', (req, res) => {
  const sites = getSiteList(db)
  if (!sites.length) {
    return res.json({ empty: true, message: 'No sites synced yet. Run a sync first.' })
  }
  res.json(sites)
})

// Search channels in DB — MUST be before /:site routes
app.get('/api/epg/sites/search', (req, res) => {
  const { q, site } = req.query
  if (!q || q.length < 2) return res.json([])
  const pattern = `%${q}%`
  let rows
  if (site) {
    rows = db.prepare(
      `SELECT * FROM epg_site_channels
       WHERE site = ? AND (name LIKE ? OR xmltv_id LIKE ? OR site_id LIKE ?)
       LIMIT 100`
    ).all(site, pattern, pattern, pattern)
  } else {
    rows = db.prepare(
      `SELECT * FROM epg_site_channels
       WHERE name LIKE ? OR xmltv_id LIKE ? OR site_id LIKE ?
       LIMIT 100`
    ).all(pattern, pattern, pattern)
  }
  res.json(rows)
})

// List distinct country/variant files for a site from DB
app.get('/api/epg/sites/:site/files', (req, res) => {
  const rows = db.prepare(
    `SELECT file, COUNT(*) as count FROM epg_site_channels WHERE site = ? GROUP BY file ORDER BY file`
  ).all(req.params.site)
  if (!rows.length) return res.status(404).json({ error: `No files found for ${req.params.site}. Run a sync first.` })
  res.json(rows)
})

// Get channels for a specific site+file from DB
app.get('/api/epg/sites/:site/channels', (req, res) => {
  const { file } = req.query
  const rows = file
    ? db.prepare('SELECT * FROM epg_site_channels WHERE site = ? AND file = ? ORDER BY name').all(req.params.site, file)
    : db.prepare('SELECT * FROM epg_site_channels WHERE site = ? ORDER BY name').all(req.params.site)
  if (!rows.length) return res.status(404).json({ error: `No channels found for ${req.params.site}${file ? ` / ${file}` : ''}. Run a sync first.` })
  res.json(rows)
})

// ── EPG Grab (built-in epg-grabber) ──────────────────────────────────────────

// Serve guide.xml directly — this IS the EPG feed for Emby/Plex/Jellyfin
app.get('/guide.xml', (req, res) => {
  if (!existsSync(GUIDE_XML)) return res.status(404).send('guide.xml not yet generated. Run an EPG grab first.')
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.sendFile(GUIDE_XML)
})

// Grab status
app.get('/api/epg/grab/status', (req, res) => {
  res.json({
    ...grabState,
    guideExists: existsSync(GUIDE_XML),
    guideUrl:    `${req.protocol}://${req.headers.host}/guide.xml`,
  })
})

// Trigger a grab (non-blocking)
app.post('/api/epg/grab', async (req, res) => {
  // If inProgress flag is stuck (more than 30 minutes), reset it
  const MAX_GRAB_TIME = 30 * 60 * 1000 // 30 minutes
  if (grabState.inProgress && grabState.lastStarted) {
    const lastStartTime = new Date(grabState.lastStarted).getTime()
    const timeSinceStart = Date.now() - lastStartTime
    if (timeSinceStart > MAX_GRAB_TIME) {
      console.log(`[epg-grab] Resetting stuck grab status (${Math.round(timeSinceStart/60000)} minutes since start)`)
      grabState.inProgress = false
    }
  }

  if (grabState.inProgress) return res.json({ ok: true, already: true, message: 'Grab already in progress' })
  res.json({ ok: true, message: 'Grab started' })

  // Set a timeout to automatically reset the status if it gets stuck
  const safetyTimeout = setTimeout(() => {
    if (grabState.inProgress) {
      console.log('[epg-grab] Safety timeout reached - resetting inProgress flag')
      grabState.inProgress = false
    }
  }, MAX_GRAB_TIME)

  runGrab({ onProgress: (msg) => {} })
    .finally(() => clearTimeout(safetyTimeout))
    .then(async () => {
      // Ensure guide.xml is registered as an EPG source
      const proto = 'http'
      const host = `127.0.0.1:${process.env.PORT || 3005}`
      const guideUrl = `${proto}://${host}/guide.xml`

      let guideSourceId = db.prepare('SELECT id FROM sources WHERE url = ? AND category = ?').get(guideUrl, 'epg')?.id
      if (!guideSourceId) {
        const result = db.prepare(
          `INSERT INTO sources (name, type, url, category, refresh_cron) VALUES ('EPG Grabber (guide.xml)', 'epg', ?, 'epg', '0 4 * * *')`
        ).run(guideUrl)
        guideSourceId = result.lastInsertRowid
        console.log('[epg-grab] Created EPG source for guide.xml')
      }

      // Cache the guide.xml content so it's searchable in EPG Mappings
      if (guideSourceId) {
        await refreshSourceCache(guideSourceId).catch(e => console.error(`[epg-grab] Failed to cache guide.xml:`, e.message))
      }

      // Auto-refresh all other EPG sources so last_fetched + channel_count update
      const epgSources = db.prepare("SELECT * FROM sources WHERE category = 'epg' AND id != ?").all(guideSourceId || 0)
      for (const s of epgSources) {
        refreshSourceCache(s.id).catch(e => console.error(`[epg-grab] Auto-refresh "${s.name}":`, e.message))
      }
    })
    .catch(e => console.error('[epg-grab] Error:', e.message))
})

// ── TMDB EPG Enrichment ───────────────────────────────────────────────────────
app.get('/api/epg/enrich/status', (req, res) => {
  const hasCacheData = !!db.prepare('SELECT 1 FROM epg_cache WHERE content IS NOT NULL LIMIT 1').get()
  res.json({
    ...enrichState,
    tmdbKeySet:  !!process.env.TMDB_API_KEY,
    guideExists: hasCacheData,
  })
})

app.post('/api/epg/enrich', async (req, res) => {
  if (!process.env.TMDB_API_KEY) return res.status(400).json({ error: 'TMDB_API_KEY not set in .env' })

  // If inProgress flag is stuck (more than 30 minutes), reset it
  const MAX_ENRICH_TIME = 30 * 60 * 1000 // 30 minutes
  if (enrichState.inProgress && enrichState.lastRun) {
    const lastRunTime = new Date(enrichState.lastRun).getTime()
    const timeSinceLastRun = Date.now() - lastRunTime
    if (timeSinceLastRun > MAX_ENRICH_TIME) {
      console.log(`[epg-enrich] Resetting stuck enrichment status (${Math.round(timeSinceLastRun/60000)} minutes since last run)`)
      enrichState.inProgress = false
    }
  }

  if (enrichState.inProgress) return res.json({ ok: true, already: true, message: 'Enrichment already in progress' })
  const hasCacheData = !!db.prepare('SELECT 1 FROM epg_cache WHERE content IS NOT NULL LIMIT 1').get()
  if (!hasCacheData) return res.status(400).json({ error: 'No EPG data cached yet — fetch an EPG source first' })
  res.json({ ok: true, message: 'Enrichment started' })

  // Set a timeout to automatically reset the status if it gets stuck
  const safetyTimeout = setTimeout(() => {
    if (enrichState.inProgress) {
      console.log('[epg-enrich] Safety timeout reached - resetting inProgress flag')
      enrichState.inProgress = false
    }
  }, MAX_ENRICH_TIME)

  enrichGuide(null)
    .catch(e => console.error('[epg-enrich] Error:', e.message))
    .finally(() => clearTimeout(safetyTimeout))
})

// ── TMDB Match Corrector ──────────────────────────────────────────────────────

app.get('/api/tmdb/titles/:playlistId', async (req, res) => {
  try {
    const playlistId = req.params.playlistId
    const { filter, search } = req.query

    // Get XMLTV content
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId)
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' })
    }

    // Get all channels for this playlist
    const channels = db.prepare(`
      SELECT pc.*, sc.normalized_name
      FROM playlist_channels pc
      LEFT JOIN source_channels sc ON sc.url = pc.url
      WHERE pc.playlist_id = ?
    `).all(playlistId)

    if (!channels.length) {
      return res.json({ titles: [], total: 0, stats: { matched: 0, not_found: 0, unmatched: 0, blocked: 0 } })
    }

    // Get EPG data - build set of tvg_ids for this playlist's channels
    const epgIds = new Set(channels.map(ch => ch.custom_tvg_id || ch.tvg_id).filter(Boolean))

    if (epgIds.size === 0) {
      return res.json({ titles: [], total: 0, stats: { matched: 0, not_found: 0, unmatched: 0, blocked: 0 } })
    }

    const cacheRows = db.prepare('SELECT content FROM epg_cache WHERE content IS NOT NULL').all()

    // Build a map of tvg_id to channel info (name and group)
    // Also build a set of excluded news/sports channel IDs
    const tvgIdToChannels = new Map()
    const excludedChannels = new Set()

    for (const ch of channels) {
      const tvgId = ch.custom_tvg_id || ch.tvg_id
      if (!tvgId) continue

      // Check if this is a news or sports channel
      const groupLower = (ch.group_title || '').toLowerCase()
      if (groupLower.includes('news') || groupLower.includes('sport')) {
        excludedChannels.add(tvgId)
      }

      if (!tvgIdToChannels.has(tvgId)) {
        tvgIdToChannels.set(tvgId, [])
      }
      tvgIdToChannels.get(tvgId).push({
        name: ch.tvg_name,
        group: ch.group_title
      })
    }

    // Extract titles from programmes that match this playlist's channels
    const titleCounts = new Map()
    const titleChannels = new Map() // Track which channels have each title
    const titleRuntimes = new Map() // Track runtime for each title (in minutes)
    const titleEpisodes = new Map() // Track episode info for each title
    const progRe = /<programme\b[^>]*>[\s\S]*?<\/programme>/g
    let matchedProgs = 0
    let skippedNewsAndSports = 0

    for (const row of cacheRows) {
      progRe.lastIndex = 0
      let m
      while ((m = progRe.exec(row.content)) !== null) {
        const prog = parseProgBlock(m[0])

        // Skip news and sports channels
        if (prog.channel && excludedChannels.has(prog.channel)) {
          skippedNewsAndSports++
          continue
        }

        // Only count programmes for channels in this playlist
        if (prog.title && prog.channel && epgIds.has(prog.channel)) {
          matchedProgs++
          titleCounts.set(prog.title, (titleCounts.get(prog.title) || 0) + 1)

          // Calculate runtime from start/stop times
          if (prog.start && prog.stop && !titleRuntimes.has(prog.title)) {
            const startTime = new Date(prog.start)
            const stopTime = new Date(prog.stop)
            const runtimeMinutes = Math.round((stopTime - startTime) / 1000 / 60)
            if (runtimeMinutes > 0) {
              titleRuntimes.set(prog.title, runtimeMinutes)
            }
          }

          // Track episode info if available
          if (prog.episode && !titleEpisodes.has(prog.title)) {
            titleEpisodes.set(prog.title, prog.episode)
          }

          // Track which channels have this title
          if (!titleChannels.has(prog.title)) {
            titleChannels.set(prog.title, new Set())
          }
          // Add all channels with this tvg_id
          const channelInfos = tvgIdToChannels.get(prog.channel) || []
          for (const chInfo of channelInfos) {
            titleChannels.get(prog.title).add(JSON.stringify(chInfo))
          }
        }
      }
    }

    // Get enrichment data for all titles
    const enrichmentData = db.prepare('SELECT * FROM tmdb_enrichment').all()
    const enrichMap = new Map(enrichmentData.map(e => [e.title, e]))

    // Get episode counts for TV shows
    const episodeCounts = db.prepare(`
      SELECT show_title, COUNT(*) as count
      FROM tmdb_episodes
      GROUP BY show_title
    `).all()
    const episodeMap = new Map(episodeCounts.map(e => [e.show_title, e.count]))

    // Build title list with match status
    const titles = []
    for (const [title, count] of titleCounts.entries()) {
      const enrich = enrichMap.get(title)
      let status = 'unmatched'

      if (enrich) {
        if (enrich.blocked) status = 'blocked'
        else if (enrich.tmdb_id) status = 'matched'
        else status = 'not_found'
      }

      // Apply filters
      if (filter && filter !== 'all' && status !== filter) continue
      if (search && !title.toLowerCase().includes(search.toLowerCase())) continue

      // Get channel info for this title
      const channelSet = titleChannels.get(title) || new Set()
      const channels = Array.from(channelSet).map(str => JSON.parse(str))

      titles.push({
        title,
        programme_count: count,
        status,
        tmdb_id: enrich?.tmdb_id || null,
        media_type: enrich?.media_type || null,
        poster: enrich?.poster || null,
        description: enrich?.description || null,
        fetched_at: enrich?.fetched_at || null,
        episode_count: enrich?.media_type === 'tv' ? (episodeMap.get(title) || 0) : null,
        manual_override: enrich?.manual_override || false,
        blocked: enrich?.blocked || false,
        channels: channels, // Array of {name, group}
        runtime_minutes: titleRuntimes.get(title) || null,
        episode_info: titleEpisodes.get(title) || null
      })
    }

    // Calculate stats
    const stats = {
      matched: titles.filter(t => t.status === 'matched').length,
      not_found: titles.filter(t => t.status === 'not_found').length,
      unmatched: titles.filter(t => t.status === 'unmatched').length,
      blocked: titles.filter(t => t.status === 'blocked').length
    }

    res.json({ titles, total: titles.length, stats })
  } catch (e) {
    console.error('[tmdb] Error getting titles:', e)
    res.status(500).json({ error: e.message })
  }
})

// Manual TMDB search
app.post('/api/tmdb/search', async (req, res) => {
  try {
    if (!process.env.TMDB_API_KEY) {
      return res.status(400).json({ error: 'TMDB_API_KEY not set' })
    }

    const { query, type } = req.body
    if (!query) return res.status(400).json({ error: 'query required' })

    const { tmdbSearchTitle } = await import('./epgEnrich.js')
    const types = type === 'both' ? ['tv', 'movie'] : [type || 'tv']
    const results = []

    for (const t of types) {
      try {
        const url = `https://api.themoviedb.org/3/search/${t}?api_key=${process.env.TMDB_API_KEY}&language=en-US&query=${encodeURIComponent(query)}&page=1`
        const response = await fetch(url)
        const data = await response.json()

        if (data.results) {
          for (const item of data.results.slice(0, 10)) {
            results.push({
              tmdb_id: item.id,
              media_type: t,
              title: item.title || item.name,
              poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : null,
              description: item.overview || null,
              release_date: item.release_date || item.first_air_date || null
            })
          }
        }
      } catch (e) {
        console.error(`[tmdb] Search error for ${t}:`, e.message)
      }
    }

    res.json({ results })
  } catch (e) {
    console.error('[tmdb] Search error:', e)
    res.status(500).json({ error: e.message })
  }
})

// Update a match
app.put('/api/tmdb/matches/:title', async (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)
    const { tmdb_id, media_type, poster, description, blocked } = req.body

    // Update or insert enrichment data
    db.prepare(`
      INSERT INTO tmdb_enrichment (title, tmdb_id, media_type, poster, description, manual_override, blocked, fetched_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(title) DO UPDATE SET
        tmdb_id=excluded.tmdb_id,
        media_type=excluded.media_type,
        poster=excluded.poster,
        description=excluded.description,
        manual_override=1,
        blocked=excluded.blocked,
        fetched_at=excluded.fetched_at
    `).run(title, tmdb_id, media_type, poster, description, blocked ? 1 : 0)

    // If TV show, fetch episodes
    if (media_type === 'tv' && tmdb_id) {
      const { fetchAndStoreAllEpisodes } = await import('./epgEnrich.js')
      await fetchAndStoreAllEpisodes(title, tmdb_id)
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[tmdb] Error updating match:', e)
    res.status(500).json({ error: e.message })
  }
})

// Block/unblock a title
app.put('/api/tmdb/block/:title', (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)
    const { blocked } = req.body

    // Insert or update with blocked flag
    db.prepare(`
      INSERT INTO tmdb_enrichment (title, blocked, fetched_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(title) DO UPDATE SET
        blocked=excluded.blocked,
        fetched_at=excluded.fetched_at
    `).run(title, blocked ? 1 : 0)

    res.json({ ok: true })
  } catch (e) {
    console.error('[tmdb] Error blocking title:', e)
    res.status(500).json({ error: e.message })
  }
})

// Clear a match
app.delete('/api/tmdb/matches/:title', (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)

    // Clear match data but preserve blocked flag
    db.prepare(`
      UPDATE tmdb_enrichment
      SET tmdb_id=NULL, media_type=NULL, poster=NULL, description=NULL, manual_override=0
      WHERE title=?
    `).run(title)

    // Delete episodes
    db.prepare('DELETE FROM tmdb_episodes WHERE show_title=?').run(title)

    res.json({ ok: true })
  } catch (e) {
    console.error('[tmdb] Error clearing match:', e)
    res.status(500).json({ error: e.message })
  }
})

// Register our own guide.xml as an EPG source
app.post('/api/epg/sources/from-scraper', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.headers.host
  const url   = `${proto}://${host}/guide.xml`
  const existing = db.prepare('SELECT id FROM sources WHERE url = ? AND category = ?').get(url, 'epg')
  if (existing) {
    return res.json({ ok: true, id: existing.id, created: false, message: 'EPG source already exists' })
  }
  const result = db.prepare(
    `INSERT INTO sources (name, type, url, category, refresh_cron) VALUES ('EPG Grabber (guide.xml)', 'epg', ?, 'epg', '0 4 * * *')`
  ).run(url)
  res.json({ ok: true, id: result.lastInsertRowid, created: true, url })
})

// Get channels.xml content
app.get('/api/epg/channels-xml', (req, res) => {
  try {
    const content = existsSync(CHANNELS_XML) ? readFileSync(CHANNELS_XML, 'utf8') : ''
    res.json({ content, path: CHANNELS_XML })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Save channels.xml content and persist selections to DB
app.put('/api/epg/channels-xml', (req, res) => {
  const { content, channels } = req.body
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' })
  try {
    mkdirSync(EPG_DIR, { recursive: true })
    writeFileSync(CHANNELS_XML, content, 'utf8')

    // Persist selected channels to DB if provided
    if (Array.isArray(channels) && channels.length > 0) {
      const deleteAll = db.prepare('DELETE FROM epg_selected_channels')
      const insert = db.prepare(
        'INSERT INTO epg_selected_channels (site, site_id, name, xmltv_id, lang, logo) VALUES (?, ?, ?, ?, ?, ?)'
      )
      const transaction = db.transaction((channelList) => {
        deleteAll.run()
        for (const ch of channelList) {
          insert.run(ch.site, ch.site_id, ch.name, ch.xmltv_id || '', ch.lang || 'en', ch.logo || '')
        }
      })
      transaction(channels)
    }

    res.json({ ok: true, path: CHANNELS_XML })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get saved channel selections
app.get('/api/epg/selected-channels', (req, res) => {
  try {
    const channels = db.prepare('SELECT site, site_id, name, xmltv_id, lang, logo FROM epg_selected_channels ORDER BY site, name').all()
    res.json(channels)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Shared EPG helpers ────────────────────────────────────────────────────────
function parseXmltvDate(s) {
  if (!s) return null
  const clean = s.replace(/\s.*/, '')
  try { return new Date(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}T${clean.slice(8,10)}:${clean.slice(10,12)}:${clean.slice(12,14)}Z`).toISOString() } catch { return null }
}

function parseProgBlock(fullMatch) {
  const attrsMatch = fullMatch.match(/^<programme\b([^>]*)>/)
  const attrs = attrsMatch?.[1] ?? ''
  const body  = fullMatch.slice(attrsMatch?.[0].length ?? 0, -'</programme>'.length)
  const get     = (tag) => { const r = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return r ? r[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim() : null }
  const getAttr = (tag, attr) => { const r = body.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return r ? r[1] : null }
  return {
    channel:  attrs.match(/\bchannel="([^"]*)"/)?.[1] ?? null,
    start:    parseXmltvDate(attrs.match(/\bstart="([^"]*)"/)?.[1]),
    stop:     parseXmltvDate(attrs.match(/\bstop="([^"]*)"/)?.[1]),
    title:    get('title'),
    desc:     get('desc'),
    icon:     getAttr('icon', 'src'),
    category: get('category'),
    episode:  get('episode-num'),
  }
}

function getMappedIds() {
  const ids = new Set(
    db.prepare('SELECT target_tvg_id FROM epg_mappings WHERE target_tvg_id IS NOT NULL').all().map(r => r.target_tvg_id)
  )
  db.prepare('SELECT custom_tvg_id FROM playlist_channels WHERE custom_tvg_id IS NOT NULL AND custom_tvg_id != \'\'').all().forEach(r => ids.add(r.custom_tvg_id))
  return ids
}

function getEnrichmentMaps() {
  const showMap = new Map(
    db.prepare('SELECT title, poster, description FROM tmdb_enrichment WHERE poster IS NOT NULL OR description IS NOT NULL').all()
      .map(r => [r.title, { poster: r.poster, desc: r.description }])
  )
  const epMap = new Map(
    db.prepare('SELECT show_title, season, episode, poster, description FROM tmdb_episodes').all()
      .map(r => [`${r.show_title}\0${r.season}\0${r.episode}`, { poster: r.poster, desc: r.description }])
  )
  return { showMap, epMap }
}

function applyEnrichment(prog, showMap, epMap) {
  if (!prog.title) return prog
  const ep    = prog.episode ? parseEpisodeNum(`<episode-num system="xmltv_ns">${prog.episode}</episode-num>`) : null
  const epKey = ep ? `${prog.title}\0${ep.season}\0${ep.episode}` : null
  const data  = (epKey && epMap.get(epKey)) || showMap.get(prog.title)
  if (!data) return prog
  return {
    ...prog,
    icon: prog.icon || data.poster || null,
    desc: prog.desc || data.desc   || null,
  }
}

// Programmes for a single mapped channel (used by EPG viewer slide-out)
app.get('/api/epg/programmes', (req, res) => {
  const { channel_id } = req.query
  if (!channel_id) return res.status(400).json({ error: 'channel_id required' })

  const mappedIds = getMappedIds()
  if (!mappedIds.has(channel_id)) return res.status(403).json({ error: 'Channel not mapped' })

  const xmls = db.prepare('SELECT content FROM epg_cache WHERE content IS NOT NULL').all().map(r => r.content)
  if (!xmls.length) return res.status(404).json({ error: 'No EPG data cached yet' })

  const { showMap, epMap } = getEnrichmentMaps()
  const programmes = []
  const progRe = /<programme\b[\s\S]*?<\/programme>/g

  for (const xml of xmls) {
    progRe.lastIndex = 0
    let m
    while ((m = progRe.exec(xml)) !== null) {
      const prog = parseProgBlock(m[0])
      if (prog.channel !== channel_id) continue
      programmes.push(applyEnrichment(prog, showMap, epMap))
    }
  }

  programmes.sort((a, b) => new Date(a.start) - new Date(b.start))
  res.json(programmes)
})

// Guide grid for active playlist - shows playlist channels with their EPG programmes
app.get('/api/epg/guide-grid', (req, res) => {
  const windowHours = Math.min(parseInt(req.query.hours ?? '6', 10), 24)
  const fromParam   = req.query.from ? new Date(req.query.from) : new Date()
  // Snap to nearest 30min
  fromParam.setMinutes(fromParam.getMinutes() < 30 ? 0 : 30, 0, 0)
  const from = fromParam
  const to   = new Date(from.getTime() + windowHours * 60 * 60 * 1000)

  // Get active playlist from localStorage default or first playlist
  const activePlaylistId = req.query.playlist_id ? parseInt(req.query.playlist_id) : null

  let channels
  if (activePlaylistId) {
    // Get specific playlist channels
    channels = db.prepare(`
      SELECT pc.*,
             CASE
               WHEN pc.custom_tvg_id != '' THEN pc.custom_tvg_id
               WHEN em.target_tvg_id IS NOT NULL THEN em.target_tvg_id
               ELSE pc.tvg_id
             END as epg_id
      FROM playlist_channels pc
      LEFT JOIN epg_mappings em ON (em.source_tvg_id = pc.tvg_id OR em.source_tvg_id = pc.custom_tvg_id)
      WHERE pc.playlist_id = ?
      ORDER BY pc.sort_order, pc.id
    `).all(activePlaylistId)
  } else {
    // Get all mapped channels (fallback)
    const mappedIds = getMappedIds()
    if (!mappedIds.size) return res.json({ channels: [], from: from.toISOString(), to: to.toISOString() })

    // Get all playlist channels with mappings
    channels = db.prepare(`
      SELECT pc.*,
             CASE
               WHEN pc.custom_tvg_id != '' THEN pc.custom_tvg_id
               WHEN em.target_tvg_id IS NOT NULL THEN em.target_tvg_id
               ELSE pc.tvg_id
             END as epg_id
      FROM playlist_channels pc
      LEFT JOIN epg_mappings em ON (em.source_tvg_id = pc.tvg_id OR em.source_tvg_id = pc.custom_tvg_id)
      WHERE pc.custom_tvg_id IS NOT NULL AND pc.custom_tvg_id != ''
         OR em.target_tvg_id IS NOT NULL
      ORDER BY pc.playlist_id, pc.sort_order, pc.id
    `).all()
  }

  // Filter to channels with EPG data
  const mappedChannels = channels.filter(ch => ch.epg_id && ch.epg_id.trim())
  if (!mappedChannels.length) return res.json({ channels: [], from: from.toISOString(), to: to.toISOString() })

  // Deduplicate by epg_id - keep first occurrence of each unique EPG ID
  const seenIds = new Set()
  const uniqueChannels = []
  for (const ch of mappedChannels) {
    if (!seenIds.has(ch.epg_id)) {
      seenIds.add(ch.epg_id)
      uniqueChannels.push(ch)
    }
  }

  // Build channel list from playlist
  const channelList = uniqueChannels.map(ch => ({
    id: ch.epg_id,
    name: ch.tvg_name || ch.name || 'Unknown',
    icon: ch.tvg_logo || ch.custom_logo || null,
    url: ch.url || null,
    channelId: ch.id,
    programmes: []
  }))

  // Get EPG data for these channels
  const epgIds = mappedChannels.map(ch => ch.epg_id)
  const wantedIds = new Set(epgIds)

  // Get programmes from cache first
  const cacheRows = db.prepare('SELECT content FROM epg_cache WHERE content IS NOT NULL').all()
  const { showMap, epMap } = getEnrichmentMaps()
  const channelsWithoutProgrammes = new Set()

  // Collect programmes in window from cache
  const progRe = /<programme\b[\s\S]*?<\/programme>/g
  for (const row of cacheRows) {
    progRe.lastIndex = 0
    let m
    while ((m = progRe.exec(row.content)) !== null) {
      const prog = parseProgBlock(m[0])
      if (!prog.channel || !wantedIds.has(prog.channel)) continue
      if (!prog.start || !prog.stop) continue
      const pStart = new Date(prog.start)
      const pStop  = new Date(prog.stop)
      if (pStop <= from || pStart >= to) continue  // outside window

      const ch = channelList.find(c => c.id === prog.channel)
      if (ch) {
        ch.programmes.push(applyEnrichment(prog, showMap, epMap))
        channelsWithoutProgrammes.delete(prog.channel)
      }
    }
  }

  // Mark channels that didn't get programmes from cache
  for (const ch of channelList) {
    if (ch.programmes.length === 0) {
      channelsWithoutProgrammes.add(ch.id)
    }
  }

  // For channels without programmes, try to fetch from scraper sources
  // This is a simplified approach - in production, you'd cache this data
  if (channelsWithoutProgrammes.size > 0) {
    // Get unique sites for channels without programmes
    const scraperCh = db.prepare(`
      SELECT DISTINCT site FROM epg_site_channels
      WHERE xmltv_id IN (` + [...channelsWithoutProgrammes].map(() => '?').join(',') + `)
    `).all([...channelsWithoutProgrammes])

    // For each site, we'd need to fetch their XMLTV feed
    // This is complex and requires knowing the source URLs
    // For now, we'll leave channels without programmes
    // TODO: Implement fetching from original EPG sources
  }

  // Sort programmes by start time
  for (const ch of channelList) {
    ch.programmes.sort((a, b) => new Date(a.start) - new Date(b.start))
  }

  res.json({ channels: channelList, from: from.toISOString(), to: to.toISOString() })
})

// Proxy guide.xml from tuliprox EPG scraper
app.get('/api/epg/guide', async (req, res) => {
  const url = req.query.url || GUIDE_XML_URL
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!upstream.ok) return res.status(upstream.status).json({ error: `EPG server returned ${upstream.status}` })
    res.setHeader('content-type', 'application/xml')
    const { Readable } = await import('node:stream')
    const readable = Readable.fromWeb(upstream.body)
    readable.on('error', () => { if (!res.writableEnded) res.end() })
    res.on('close', () => readable.destroy())
    readable.pipe(res)
  } catch (e) {
    res.status(502).json({ error: `Cannot reach EPG server: ${e.message}` })
  }
})

// Parse guide.xml and return channel list (for ID matching preview)
app.get('/api/epg/channels', async (req, res) => {
  const url = req.query.url || GUIDE_XML_URL
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!upstream.ok) return res.status(upstream.status).json({ error: `EPG server returned ${upstream.status}` })
    const xml = await upstream.text()
    // Extract <channel id="..."><display-name>...</display-name></channel>
    const channels = []
    const channelRe = /<channel id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g
    let m
    while ((m = channelRe.exec(xml)) !== null) {
      const id = m[1]
      const nameMatch = m[2].match(/<display-name[^>]*>([^<]*)<\/display-name>/)
      const iconMatch = m[2].match(/<icon src="([^"]*)"/)
      channels.push({ id, name: nameMatch?.[1] || id, icon: iconMatch?.[1] || '' })
    }
    res.json(channels)
  } catch (e) {
    res.status(502).json({ error: `Cannot reach EPG server: ${e.message}` })
  }
})

// List EPG sources that have cached data
app.get('/api/epg/sources', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, ec.channel_count, ec.last_fetched
    FROM sources s
    JOIN epg_cache ec ON ec.source_id = s.id
    WHERE s.category = 'epg' AND ec.content IS NOT NULL
    ORDER BY s.name
  `).all()
  res.json(rows)
})

// Search EPG channels from cached sources — supports ?q=query&source_id=N
app.get('/api/epg/search-cached', (req, res) => {
  const { q, source_id } = req.query
  const query = (q || '').toLowerCase().trim()

  const whereClause = source_id ? 'WHERE ec.source_id = ? AND ec.content IS NOT NULL' : 'WHERE ec.content IS NOT NULL'
  const params = source_id ? [Number(source_id)] : []

  const rows = db.prepare(`
    SELECT ec.source_id, ec.content, s.name as source_name
    FROM epg_cache ec
    JOIN sources s ON s.id = ec.source_id
    ${whereClause}
  `).all(...params)

  const results = []
  for (const row of rows) {
    let currentId = null, currentName = null, currentIcon = ''
    for (const line of row.content.split('\n')) {
      const trimmed = line.trim()
      if (!currentId) {
        const idMatch = trimmed.match(/<channel\s[^>]*id="([^"]*)"/)
        if (idMatch) {
          currentId = idMatch[1]; currentName = null; currentIcon = ''
          // Handle single-line blocks: <channel id="..."><display-name>...</display-name>...</channel>
          const nm = trimmed.match(/<display-name[^>]*>([^<]+)<\/display-name>/)
          if (nm) currentName = nm[1].trim()
          const im = trimmed.match(/<icon\s[^>]*src="([^"]*)"/)
          if (im) currentIcon = im[1]
          if (trimmed.includes('</channel>')) {
            if (currentId && currentName) {
              if (!query || currentName.toLowerCase().includes(query) || currentId.toLowerCase().includes(query)) {
                results.push({ id: currentId, name: currentName, icon: currentIcon, source_name: row.source_name, source_id: row.source_id })
                if (results.length >= 100) break
              }
            }
            currentId = null; currentName = null; currentIcon = ''
          }
        }
      } else {
        // Multi-line block
        if (!currentName) {
          const nm = trimmed.match(/<display-name[^>]*>([^<]+)<\/display-name>/)
          if (nm) currentName = nm[1].trim()
        }
        if (!currentIcon) {
          const im = trimmed.match(/<icon\s[^>]*src="([^"]*)"/)
          if (im) currentIcon = im[1]
        }
        if (trimmed.includes('</channel>')) {
          if (currentId && currentName) {
            if (!query || currentName.toLowerCase().includes(query) || currentId.toLowerCase().includes(query)) {
              results.push({ id: currentId, name: currentName, icon: currentIcon, source_name: row.source_name, source_id: row.source_id })
              if (results.length >= 100) break
            }
          }
          currentId = null; currentName = null; currentIcon = ''
        }
      }
    }
    if (results.length >= 100) break
  }
  res.json(results)
})

// Get channel IDs from locally cached EPG sources (epg_cache table)
app.get('/api/epg/cached-channels', (req, res) => {
  const rows = db.prepare(`
    SELECT ec.source_id, ec.content, s.name as source_name
    FROM epg_cache ec
    JOIN sources s ON s.id = ec.source_id
    WHERE ec.content IS NOT NULL
  `).all()

  const channels = []
  const channelRe = /<channel id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g
  for (const row of rows) {
    let m
    channelRe.lastIndex = 0
    while ((m = channelRe.exec(row.content)) !== null) {
      const id = m[1]
      const nameMatch = m[2].match(/<display-name[^>]*>([^<]*)<\/display-name>/)
      const iconMatch = m[2].match(/<icon src="([^"]*)"/)
      channels.push({
        id,
        name:        nameMatch?.[1] || id,
        icon:        iconMatch?.[1] || '',
        source_name: row.source_name,
      })
    }
  }
  res.json(channels)
})

// Search EPG channels (for ID matching)
app.get('/api/epg/search', async (req, res) => {
  const { q, url } = req.query
  if (!q) return res.json([])
  try {
    const guideUrl = url || GUIDE_XML_URL
    const upstream = await fetch(guideUrl, { signal: AbortSignal.timeout(30_000) })
    if (!upstream.ok) return res.status(upstream.status).json({ error: `EPG server returned ${upstream.status}` })
    const xml = await upstream.text()
    const channels = []
    const channelRe = /<channel id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g
    const query = q.toLowerCase()
    let m
    while ((m = channelRe.exec(xml)) !== null) {
      const id = m[1]
      const nameMatch = m[2].match(/<display-name[^>]*>([^<]*)<\/display-name>/)
      const name = nameMatch?.[1] || id
      if (id.toLowerCase().includes(query) || name.toLowerCase().includes(query)) {
        channels.push({ id, name })
      }
    }
    res.json(channels.slice(0, 50))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all()
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])))
})

app.put('/api/settings', (req, res) => {
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

  res.json({ ok: true })
})

// ── Scheduler ─────────────────────────────────────────────────────────────────
function schedulePlaylists() {
  const playlists = db.prepare('SELECT * FROM playlists WHERE schedule IS NOT NULL AND output_path IS NOT NULL').all()
  for (const p of playlists) {
    if (!cron.validate(p.schedule)) continue
    cron.schedule(p.schedule, async () => {
      console.log(`[cron] Building playlist "${p.name}" (id=${p.id})`)
      try {
        const channels = db.prepare('SELECT * FROM playlist_channels WHERE playlist_id = ? ORDER BY sort_order, id').all(p.id)
        const epgRows = db.prepare('SELECT * FROM epg_mappings').all()
        const epgMap = new Map(epgRows.map(r => [r.source_tvg_id, r.target_tvg_id]))
        const content = buildM3U(channels, epgMap)
        writeM3U(p.output_path, content)
        db.prepare('UPDATE playlists SET last_built = datetime("now") WHERE id = ?').run(p.id)
        console.log(`[cron] Built "${p.name}" -> ${p.output_path} (${channels.length} channels)`)
      } catch (e) {
        console.error(`[cron] Failed to build "${p.name}":`, e.message)
      }
    })
    console.log(`[cron] Scheduled "${p.name}" with cron: ${p.schedule}`)
  }
}

function scheduleSources() {
  const sources = db.prepare('SELECT * FROM sources WHERE refresh_cron IS NOT NULL').all()
  for (const s of sources) {
    if (!cron.validate(s.refresh_cron)) continue
    cron.schedule(s.refresh_cron, async () => {
      console.log(`[cron] Refreshing source "${s.name}" (id=${s.id})`)
      try {
        await refreshSourceCache(s.id)
      } catch (e) {
        console.error(`[cron] Failed to refresh "${s.name}":`, e.message)
      }
    })
    console.log(`[cron] Scheduled source refresh "${s.name}" with cron: ${s.refresh_cron}`)
  }
}

schedulePlaylists()
scheduleSources()

// Auto-sync EPG sites DB weekly (Sunday 3am) if never synced or stale
const EPG_SYNC_CRON = process.env.EPG_SYNC_CRON || '0 3 * * 0'
if (cron.validate(EPG_SYNC_CRON)) {
  cron.schedule(EPG_SYNC_CRON, () => {
    console.log('[cron] Running weekly EPG sites sync…')
    runSync().catch(e => console.error('[cron] EPG sync error:', e.message))
  })
}
// Auto-sync on first startup if DB is empty
const epgCount = db.prepare('SELECT COUNT(*) as c FROM epg_site_channels').get().c
if (epgCount === 0) {
  console.log('[startup] EPG site channels DB is empty — triggering initial sync…')
  setTimeout(() => runSync().catch(e => console.error('[startup] EPG sync error:', e.message)), 3000)
}

// EPG grab and enrichment cron schedules from settings
const getEpgGrabSchedule = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('epg_grab_schedule')?.value || '0 23 * * *'
const getEnrichSchedule = () => db.prepare('SELECT value FROM settings WHERE key = ?').get('epg_enrich_schedule')?.value || '0 2 * * *'

let epgGrabCronJob = null
let enrichCronJob = null

function startEpgGrabCron() {
  if (epgGrabCronJob) epgGrabCronJob.stop()
  const schedule = getEpgGrabSchedule()
  if (!schedule) {
    console.log('[startup] EPG grab schedule disabled')
    return
  }
  console.log(`[startup] Configuring EPG grab cron with schedule: ${schedule}`)
  if (cron.validate(schedule)) {
    epgGrabCronJob = cron.schedule(schedule, () => {
      console.log(`[cron] Running daily EPG grab at ${new Date().toISOString()}…`)
      runGrab({ onProgress: (msg) => console.log(`[cron-epg] ${msg}`) })
        .then(() => {
          console.log(`[cron] EPG grab completed successfully at ${new Date().toISOString()}`)
          const epgSources = db.prepare("SELECT * FROM sources WHERE category = 'epg'").all()
          // Refresh all EPG sources sequentially
          ;(async () => {
            for (const s of epgSources) {
              try {
                console.log(`[cron] Refreshing EPG source "${s.name}"...`)
                await refreshSourceCache(s.id)
                console.log(`[cron] Successfully refreshed EPG source "${s.name}"`)
              } catch (e) {
                console.error(`[cron] Auto-refresh "${s.name}":`, e.message)
              }
            }
          })()
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

function startEnrichCron() {
  if (enrichCronJob) enrichCronJob.stop()
  const schedule = getEnrichSchedule()
  if (!schedule) {
    console.log('[startup] TMDB enrichment schedule disabled')
    return
  }
  console.log(`[startup] Configuring TMDB enrichment cron with schedule: ${schedule}`)
  if (cron.validate(schedule)) {
    enrichCronJob = cron.schedule(schedule, () => {
      console.log(`[cron] Running TMDB enrichment at ${new Date().toISOString()}…`)
      enrichGuide(null)
        .then(() => console.log(`[cron] TMDB enrichment completed at ${new Date().toISOString()}`))
        .catch(e => console.error('[cron] Enrichment error:', e.message))
    }, {
      scheduled: true,
      timezone: "Africa/Johannesburg"
    })
  } else {
    console.error(`[startup] Invalid enrichment cron schedule: ${schedule}`)
  }
}

startEpgGrabCron()
startEnrichCron()

// Startup EPG grab disabled - only runs via scheduler
// setTimeout(() => {
//   const lastRun = grabState.lastFinished ? new Date(grabState.lastFinished) : null
//   const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000)
//   if (!lastRun || lastRun < twelveHoursAgo) {
//     console.log('[startup] Running EPG grab (more than 12h since last run)...')
//     runGrab({ onProgress: (msg) => console.log(`[startup-epg] ${msg}`) })
//       .catch(e => console.error('[startup] EPG grab error:', e.message))
//   } else {
//     console.log(`[startup] Skipping EPG grab (last run: ${lastRun.toISOString()})`)
//   }
// }, 10000) // Wait 10 seconds after server start

// ── HDHomeRun simulation ───────────────────────────────────────────────────────
registerHdhrRoutes(app)
startAllDeviceServers().catch(e => console.error('[hdhr] Boot error:', e.message))

// ── Xtream Codes API ──────────────────────────────────────────────────────────
registerXtreamRoutes(app)

// ── HDHomeRun virtual device management ───────────────────────────────────────
app.get('/api/hdhr/virtual-devices', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, p.name AS playlist_name
    FROM hdhr_devices d
    LEFT JOIN playlists p ON p.id = d.playlist_id
    ORDER BY d.port
  `).all()
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const hostname = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0]
  res.json(rows.map(d => {
    const deviceBase = `${proto}://${hostname}:${d.port}`
    const appBase    = `${proto}://${hostname}`
    const xmltvUrl   = d.playlist_id ? `${appBase}:${process.env.PORT || 3005}/api/playlists/${d.playlist_id}/xmltv` : null
    return {
      ...d,
      plex_url:      deviceBase,
      discover_url:  `${deviceBase}/discover.json`,
      lineup_url:    `${deviceBase}/lineup.json`,
      m3u_url:       `${deviceBase}/lineup.m3u`,
      xmltv_url:     xmltvUrl,
    }
  }))
})

app.post('/api/hdhr/virtual-devices', async (req, res) => {
  const { name, playlist_id, port, tuner_count, active } = req.body
  if (!port) return res.status(400).json({ error: 'port required' })
  const existing = db.prepare('SELECT id FROM hdhr_devices WHERE port = ?').get(port)
  if (existing) return res.status(409).json({ error: `Port ${port} is already in use` })
  try {
    const result = db.prepare(
      `INSERT INTO hdhr_devices (name, playlist_id, port, tuner_count, active) VALUES (?, ?, ?, ?, ?)`
    ).run(name || 'M3U Tuner', playlist_id || null, Number(port), Number(tuner_count) || 4, active === false ? 0 : 1)
    const { startDeviceServer } = await import('./hdhr.js')
    await startDeviceServer(result.lastInsertRowid)
    res.json({ ok: true, id: result.lastInsertRowid })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/hdhr/virtual-devices/:id', async (req, res) => {
  const { name, playlist_id, port, tuner_count, active } = req.body
  const existing = db.prepare('SELECT * FROM hdhr_devices WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Device not found' })
  const portConflict = db.prepare('SELECT id FROM hdhr_devices WHERE port = ? AND id != ?').get(port, req.params.id)
  if (portConflict) return res.status(409).json({ error: `Port ${port} is already in use` })
  try {
    db.prepare(
      `UPDATE hdhr_devices SET name=?, playlist_id=?, port=?, tuner_count=?, active=? WHERE id=?`
    ).run(name || 'M3U Tuner', playlist_id || null, Number(port), Number(tuner_count) || 4, active === false ? 0 : 1, req.params.id)
    const { restartDeviceServer } = await import('./hdhr.js')
    await restartDeviceServer(Number(req.params.id))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/hdhr/virtual-devices/:id', async (req, res) => {
  try {
    const { stopDeviceServer } = await import('./hdhr.js')
    await stopDeviceServer(Number(req.params.id))
    db.prepare('DELETE FROM hdhr_devices WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// HDHomeRun status for the frontend settings page
app.get('/api/hdhr/status', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.headers.host
  const base  = `${proto}://${host}`
  const row   = db.prepare("SELECT value FROM settings WHERE key = 'hdhr_device_id'").get()
  res.json({
    discoverUrl: `${base}/discover.json`,
    lineupUrl:   `${base}/lineup.json`,
    deviceId:    row?.value || null,
  })
})

// ── Player page ───────────────────────────────────────────────────────────────
// GET /player/:channelId  — simple HTML5 video player
app.get('/player/:channelId', (req, res) => {
  const { channelId } = req.params
  const channelName = req.query.name || 'Live Stream'
  // Use absolute URL for mpegts.js worker compatibility
  const protocol = req.protocol
  const host = req.get('host')
  const streamUrl = `${protocol}://${host}/stream/${channelId}`

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channelName}</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    .header {
      background: #1a1d27;
      border-bottom: 1px solid #2e3250;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .back-btn {
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
    }
    .back-btn:hover { color: #e2e8f0; }
    .title {
      color: #f1f5f9;
      font-size: 14px;
      font-weight: 600;
    }
    .player-container {
      width: 100vw;
      height: calc(100vh - 49px);
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    video {
      width: 100%;
      height: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .error {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #ef4444;
      background: rgba(0,0,0,0.8);
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      max-width: 400px;
    }
  </style>
</head>
<body>
  <div class="header">
    <button class="back-btn" onclick="window.close()">←</button>
    <div class="title">${channelName}</div>
  </div>
  <div class="player-container">
    <video id="video" controls></video>
    <div id="error" class="error" style="display:none;"></div>
  </div>
  <script>
    const streamUrl = '${streamUrl}';
    const errorDiv = document.getElementById('error');
    const video = document.getElementById('video');
    let player = null;

    function playStream() {
      // Use mpegts.js to play the proxied MPEG-TS stream from backend
      if (mpegts.getFeatureList().mseLivePlayback) {
        player = mpegts.createPlayer({
          type: 'mpegts',
          isLive: true,
          url: streamUrl
        }, {
          enableWorker: true,
          enableStashBuffer: true,
          stashInitialSize: 128
        });

        player.attachMediaElement(video);
        player.load();

        player.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
          errorDiv.textContent = 'Stream error: ' + errorType + ' - ' + errorDetail;
          errorDiv.style.display = 'block';
          console.error('mpegts.js error:', errorType, errorDetail, errorInfo);
        });

        video.addEventListener('loadedmetadata', () => {
          video.play().catch(e => {
            console.error('Autoplay failed:', e);
          });
        });
      } else {
        errorDiv.textContent = 'Your browser does not support streaming';
        errorDiv.style.display = 'block';
      }
    }

    playStream();
  </script>
</body>
</html>
  `)
})

/**
 * Get all channel variants for a given channel, ordered by availability and quality
 * Returns array of {id, url, tvg_name, quality, source_id}
 *
 * Logic:
 * 1. Get all variants with same normalized_name
 * 2. Check each source's max_streams vs active streams
 * 3. Prioritize sources with available slots
 * 4. Within available sources, order by quality (best first)
 * 5. Unavailable sources go last (in case all fail)
 */
function getChannelVariants(channelId) {
  // First get the channel to find its normalized_name
  const channel = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
  if (!channel) return []

  // Get the source channel to find normalized_name
  const sourceChannel = db.prepare('SELECT normalized_name FROM source_channels WHERE url = ?').get(channel.url)
  if (!sourceChannel || !sourceChannel.normalized_name) {
    // No normalized name, return just this channel
    return [{ id: channel.id, url: channel.url, tvg_name: channel.tvg_name, quality: '', source_id: channel.source_id }]
  }

  // Find all source channels with the same normalized_name
  const variants = db.prepare(`
    SELECT sc.id, sc.url, sc.tvg_name, sc.quality, sc.source_id, s.max_streams, s.priority
    FROM source_channels sc
    LEFT JOIN sources s ON sc.source_id = s.id
    WHERE sc.normalized_name = ?
  `).all(sourceChannel.normalized_name)

  if (!variants.length) {
    return [{ id: channel.id, url: channel.url, tvg_name: channel.tvg_name, quality: '', source_id: channel.source_id }]
  }

  // Get active sessions to count streams per source
  const activeSessions = getActiveSessions()
  const activeBySource = new Map()
  for (const session of activeSessions) {
    if (session.sourceId) {
      activeBySource.set(session.sourceId, (activeBySource.get(session.sourceId) || 0) + 1)
    }
  }

  // Categorize variants: available vs unavailable
  const available = []
  const unavailable = []

  for (const variant of variants) {
    const activeCount = activeBySource.get(variant.source_id) || 0
    const maxStreams = variant.max_streams || 0
    const hasCapacity = maxStreams === 0 || activeCount < maxStreams

    const variantData = {
      id: variant.id,
      url: variant.url,
      tvg_name: variant.tvg_name,
      quality: variant.quality || '',
      source_id: variant.source_id,
      priority: variant.priority || 999,
      activeCount,
      maxStreams
    }

    if (hasCapacity) {
      available.push(variantData)
    } else {
      unavailable.push(variantData)
    }
  }

  // Sort available by priority then quality
  available.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const qualityOrder = { 'UHD': 1, 'FHD': 2, 'HD': 3, 'SD': 4 }
    const aQ = qualityOrder[a.quality] || 5
    const bQ = qualityOrder[b.quality] || 5
    return aQ - bQ
  })

  // Sort unavailable by priority then quality (as fallback)
  unavailable.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const qualityOrder = { 'UHD': 1, 'FHD': 2, 'HD': 3, 'SD': 4 }
    const aQ = qualityOrder[a.quality] || 5
    const bQ = qualityOrder[b.quality] || 5
    return aQ - bQ
  })

  // Return available sources first, then unavailable as fallback
  return [...available, ...unavailable].map(v => ({
    id: v.id,
    url: v.url,
    tvg_name: v.tvg_name,
    quality: v.quality,
    source_id: v.source_id
  }))
}

/**
 * Track failed stream in database for dead channel reporting
 */
function trackFailedStream(channelId, playlistId, tvgName, groupTitle, url, error, httpStatus = null) {
  try {
    // Check if this channel+url combo already exists
    const existing = db.prepare('SELECT id, fail_count FROM failed_streams WHERE channel_id = ? AND url = ?').get(channelId, url)

    if (existing) {
      // Increment fail count and update last_failed timestamp
      db.prepare(`
        UPDATE failed_streams
        SET fail_count = fail_count + 1,
            last_failed = datetime('now'),
            error = ?,
            http_status = ?
        WHERE id = ?
      `).run(error, httpStatus, existing.id)
    } else {
      // Insert new failed stream record
      db.prepare(`
        INSERT INTO failed_streams (channel_id, playlist_id, tvg_name, group_title, url, error, http_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(channelId, playlistId, tvgName, groupTitle, url, error, httpStatus)
    }
  } catch (e) {
    console.error('[stream] Failed to track dead channel:', e.message)
  }
}

/**
 * Try to connect to a stream with timeout
 */
async function tryConnectWithTimeout(channelId, url, name, res, sourceId, username, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Connection timeout'))
    }, timeoutMs)

    connectClient(channelId, url, name, res, sourceId, username)
      .then(() => {
        clearTimeout(timeout)
        resolve()
      })
      .catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })
  })
}

// ── Stream proxy ──────────────────────────────────────────────────────────────
// GET /stream/:channelId  — proxy upstream IPTV stream, reuse for multiple clients
app.get('/stream/:channelId', async (req, res) => {
  const { channelId } = req.params
  const row = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
  if (!row) return res.status(404).send('Channel not found')

  // Resolve username from query creds so max_connections is enforced on this path too
  let username = null
  const u = req.query.username, p = req.query.password
  if (u && p) {
    const userRow = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(u)
    const authed  = userRow && await verifyPassword(p, userRow.password)
    if (authed) {
      if (userRow.expires_at && new Date(userRow.expires_at) < new Date()) {
        return res.status(403).send('Account expired')
      }
      const active = getActiveSessions().filter(s => s.username === u).length
      if (userRow.max_connections > 0 && active >= userRow.max_connections) {
        return res.status(429).send(`Stream limit reached (${userRow.max_connections} max)`)
      }
      username = u
      db.prepare(`UPDATE users SET last_connected_at = datetime('now') WHERE username = ?`).run(u)
    }
  }

  // Get client info for logging
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown'
  const userAgent = req.get('user-agent') || 'unknown'

  console.log(`[stream] Client ${clientIp} requesting "${row.tvg_name}" (channel ${channelId})`)
  console.log(`[stream] User-Agent: ${userAgent.substring(0, 80)}`)

  // Get all channel variants (ordered by availability and quality)
  const variants = getChannelVariants(channelId)

  // Log variant selection with source capacity info
  const activeSessions = getActiveSessions()
  const activeBySource = new Map()
  for (const session of activeSessions) {
    if (session.sourceId) {
      activeBySource.set(session.sourceId, (activeBySource.get(session.sourceId) || 0) + 1)
    }
  }

  console.log(`[stream] Found ${variants.length} variant(s) for channel ${channelId}`)
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    if (v.source_id) {
      const source = db.prepare('SELECT name, max_streams FROM sources WHERE id = ?').get(v.source_id)
      const active = activeBySource.get(v.source_id) || 0
      const max = source?.max_streams || 0
      const capacityInfo = max > 0 ? ` [${active}/${max} streams]` : ` [${active} streams, unlimited]`
      console.log(`[stream]   ${i + 1}. ${v.tvg_name} (${v.quality || 'unknown'}) from ${source?.name || 'unknown'}${capacityInfo}`)
    }
  }

  // Try each variant in order until one succeeds
  let lastError = null

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]
    const qualityLabel = variant.quality ? ` (${variant.quality})` : ''
    console.log(`[stream] Trying variant ${i + 1}/${variants.length}: ${variant.tvg_name}${qualityLabel}`)

    try {
      await connectClient(channelId, variant.url, variant.tvg_name, res, variant.source_id || null, username)
      console.log(`[stream] Successfully connected to variant ${i + 1}`)
      return // Success!
    } catch (e) {
      lastError = e
      console.error(`[stream] Variant ${i + 1} failed:`, e)
      // Continue to next variant
    }
  }

  // All variants failed
  console.log(`[stream] All ${variants.length} variant(s) failed for channel ${channelId}`)
  if (!res.headersSent) {
    res.status(502).send(`Stream unavailable - all ${variants.length} source(s) failed`)
  }
})

// GET /api/streams  — list active stream sessions
app.get('/api/streams', (req, res) => {
  res.json(getActiveSessions())
})

// DELETE /api/streams/:channelId  — kill a stream session
app.delete('/api/streams/:channelId', (req, res) => {
  killSession(req.params.channelId)
  res.json({ ok: true })
})

// ── Proxy settings ────────────────────────────────────────────────────────────
app.get('/api/proxy-settings', (req, res) => {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxy_buffer_seconds')
  const bufferSeconds = setting ? parseFloat(setting.value) : getBufferSeconds()
  res.json({ bufferSeconds })
})

app.put('/api/proxy-settings', (req, res) => {
  const { bufferSeconds } = req.body
  const val = parseFloat(bufferSeconds)
  if (isNaN(val) || val < 0 || val > 30) {
    return res.status(400).json({ error: 'bufferSeconds must be 0–30' })
  }
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('proxy_buffer_seconds', String(val))
    res.json({ ok: true, bufferSeconds: val })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Stream history ────────────────────────────────────────────────────────────
app.get('/api/stream-history', (req, res) => {
  const username = req.query.username || null
  const limit    = Math.min(parseInt(req.query.limit || '200'), 1000)
  const rows = username
    ? db.prepare('SELECT * FROM stream_history WHERE username = ? ORDER BY started_at DESC LIMIT ?').all(username, limit)
    : db.prepare('SELECT * FROM stream_history ORDER BY started_at DESC LIMIT ?').all(limit)
  res.json(rows)
})

// ── Admin auth ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin'
  if (password !== adminPassword) return res.status(401).json({ error: 'Invalid password' })
  const token     = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt)
  res.json({ token, expiresAt })
})

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token']
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
  res.json({ ok: true })
})

app.get('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token']
  if (!token) return res.status(401).json({ error: 'No token' })
  const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token)
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' })
  res.json({ ok: true })
})

// ── User Management ───────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.*, p.name AS playlist_name, vp.name AS vod_playlist_name
    FROM users u
    LEFT JOIN playlists p  ON p.id  = u.playlist_id
    LEFT JOIN playlists vp ON vp.id = u.vod_playlist_id
    ORDER BY u.created_at DESC
  `).all()
  res.json(users)
})

app.post('/api/users', async (req, res) => {
  const { username, password, playlist_id, vod_playlist_id, max_connections, expires_at, active, notes } = req.body
  if (!username || !password) return res.status(400).json({ error: 'username and password required' })
  try {
    const hashed = await hashPassword(password)
    const result = db.prepare(
      `INSERT INTO users (username, password, playlist_id, vod_playlist_id, max_connections, expires_at, active, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      username.trim(),
      hashed,
      playlist_id || null,
      vod_playlist_id || null,
      Number(max_connections) || 1,
      expires_at || null,
      active === false ? 0 : 1,
      notes || null
    )
    res.json({ ok: true, id: result.lastInsertRowid })
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' })
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/users/:id', async (req, res) => {
  const { username, password, playlist_id, vod_playlist_id, max_connections, expires_at, active, notes } = req.body
  if (!username) return res.status(400).json({ error: 'username required' })
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'User not found' })
  try {
    const newPassword = password ? await hashPassword(password) : existing.password
    db.prepare(
      `UPDATE users SET username=?, password=?, playlist_id=?, vod_playlist_id=?, max_connections=?, expires_at=?, active=?, notes=?
       WHERE id=?`
    ).run(
      username.trim(),
      newPassword,
      playlist_id || null,
      vod_playlist_id || null,
      Number(max_connections) || 1,
      expires_at || null,
      active === false ? 0 : 1,
      notes || null,
      req.params.id
    )
    db.sync() // Ensure data is persisted to disk
    res.json({ ok: true })
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' })
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ── Backup & Restore ──────────────────────────────────────────────────────────
const BACKUP_TABLES = ['sources', 'playlists', 'playlist_channels', 'epg_mappings', 'settings', 'epg_site_channels', 'users', 'stream_history', 'admin_sessions', 'failed_streams']

// GET /api/backup — download a gzipped JSON bundle of all data
app.get('/api/backup', (req, res) => {
  const bundle = { version: 1, exportedAt: new Date().toISOString(), tables: {}, files: {} }

  for (const table of BACKUP_TABLES) {
    try { bundle.tables[table] = db.prepare(`SELECT * FROM ${table}`).all() } catch { bundle.tables[table] = [] }
  }

  // Include channels.xml, guide.xml, and .env as base64
  const channelsXmlPath = path.join(EPG_DIR, 'channels.xml')
  const guideXmlPath = path.join(EPG_DIR, 'guide.xml')
  if (existsSync(channelsXmlPath)) bundle.files['channels.xml'] = readFileSync(channelsXmlPath, 'base64')
  if (existsSync(guideXmlPath))    bundle.files['guide.xml']    = readFileSync(guideXmlPath, 'base64')
  const envPath = path.join(process.cwd(), '.env')
  if (existsSync(envPath))         bundle.files['.env']         = readFileSync(envPath, 'base64')

  const date       = new Date().toISOString().slice(0, 10)
  const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)))

  res.setHeader('Content-Type', 'application/gzip')
  res.setHeader('Content-Disposition', `attachment; filename="m3u-manager-backup-${date}.json.gz"`)
  res.setHeader('Content-Length', compressed.length)
  res.end(compressed)
})

// POST /api/restore — upload a gzipped JSON bundle and restore all data
app.post('/api/restore', express.raw({ type: 'application/gzip', limit: '500mb' }), async (req, res) => {
  try {
    const bundle = JSON.parse(gunzipSync(req.body).toString('utf8'))

    if (!bundle.version || !bundle.tables) return res.status(400).json({ error: 'Invalid backup file' })

    // Restore tables in dependency order (users after playlists due to FK on playlist_id)
    const order = ['sources', 'epg_mappings', 'settings', 'playlists', 'playlist_channels', 'epg_site_channels', 'users', 'stream_history', 'admin_sessions', 'failed_streams']
    db.exec('PRAGMA foreign_keys = OFF')
    const restore = db.transaction(() => {
      for (const table of order) {
        const rows = bundle.tables[table]
        if (!rows?.length) continue
        db.prepare(`DELETE FROM ${table}`).run()
        const cols = Object.keys(rows[0])
        const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        for (const row of rows) stmt.run(cols.map(c => row[c]))
      }
    })
    restore()
    db.exec('PRAGMA foreign_keys = ON')

    // Restore files
    const DATA_DIR = process.env.DATA_DIR || '/data'
    const EPG_DIR_PATH = path.join(DATA_DIR, 'epg')
    mkdirSync(EPG_DIR_PATH, { recursive: true })
    if (bundle.files?.['channels.xml']) {
      const p = path.join(EPG_DIR_PATH, 'channels.xml')
      writeFileSync(p, Buffer.from(bundle.files['channels.xml'], 'base64'))
    }
    if (bundle.files?.['guide.xml']) {
      const guideXmlPath = path.join(EPG_DIR_PATH, 'guide.xml')
      writeFileSync(guideXmlPath, Buffer.from(bundle.files['guide.xml'], 'base64'))
    }
    // Restore .env — only write keys not already present in the running environment
    // to avoid clobbering host-specific overrides (e.g. HOST_IP on Unraid)
    if (bundle.files?.['.env']) {
      const envPath = path.join(process.cwd(), '.env')
      const restored = Buffer.from(bundle.files['.env'], 'base64').toString('utf8')
      // Merge: existing file wins for any key already set
      const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
      const existingKeys = new Set(
        existing.split('\n').map(l => l.split('=')[0].trim()).filter(Boolean)
      )
      const newLines = restored.split('\n').filter(l => {
        const k = l.split('=')[0].trim()
        return k && !existingKeys.has(k)
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

// ── Diagnostics ───────────────────────────────────────────────────────────────
app.get('/api/diagnostics/ip', async (req, res) => {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { stdout } = await exec('curl', ['-s', '--max-time', '5', 'https://ipinfo.io/json'])
    res.json(JSON.parse(stdout))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/diagnostics/speedtest', async (req, res) => {
  const TEST_URL = 'https://speed.cloudflare.com/__down?bytes=25000000' // 25MB
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const start = Date.now()
    const { stdout } = await exec('curl', [
      '-s', '-o', '/dev/null',
      '-w', '%{size_download} %{http_code}',
      '--max-time', '30',
      TEST_URL,
    ])
    const [sizeStr, statusStr] = stdout.trim().split(' ')
    const bytes   = Number(sizeStr)
    const status  = Number(statusStr)
    if (status !== 200) throw new Error(`HTTP ${status}`)
    const elapsed = (Date.now() - start) / 1000
    const mbps    = ((bytes * 8) / elapsed / 1_000_000).toFixed(2)
    const mbDown  = (bytes / 1_000_000).toFixed(2)
    res.json({ mbps: Number(mbps), bytes, mb: Number(mbDown), elapsed: elapsed.toFixed(2) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/diagnostics/dead-channels', (req, res) => {
  const playlist_id = req.query.playlist_id || null
  const rows = playlist_id
    ? db.prepare(`SELECT * FROM failed_streams WHERE playlist_id = ? ORDER BY fail_count DESC, last_failed DESC LIMIT 500`).all(playlist_id)
    : db.prepare(`SELECT * FROM failed_streams ORDER BY fail_count DESC, last_failed DESC LIMIT 500`).all()
  const total = db.prepare('SELECT COUNT(*) as c FROM failed_streams').get().c
  res.json({ total, rows })
})

app.delete('/api/diagnostics/dead-channels', (req, res) => {
  const playlist_id = req.query.playlist_id || null
  if (playlist_id) {
    db.prepare('DELETE FROM failed_streams WHERE playlist_id = ?').run(playlist_id)
  } else {
    db.prepare('DELETE FROM failed_streams').run()
  }
  res.json({ ok: true })
})

app.get('/api/diagnostics/vpn', async (req, res) => {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const [routes, tun0] = await Promise.all([
      exec('ip', ['route', 'show']).then(r => r.stdout).catch(() => ''),
      exec('ip', ['addr', 'show', 'tun0']).then(r => r.stdout).catch(() => null),
    ])
    res.json({
      vpnActive:      tun0 !== null,
      defaultViaTun:  routes.includes('tun0'),
      tun0:           tun0 || null,
      routes,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// SPA fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})

// Run migrations before starting server
await runMigrations(db)

console.log('[db] Database initialized')

app.listen(PORT, () => {
  console.log(`M3u4Proxy server running on http://localhost:${PORT}`)
})
