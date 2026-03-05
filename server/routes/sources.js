import express from 'express'
import db from '../db.js'
import { refreshSourceCache } from '../services/sourceManager.js'
import { getCached, setCache } from '../services/cache.js'

const router = express.Router()

// ── Sources ───────────────────────────────────────────────────────────────────
router.get('/sources', (req, res) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY name').all()

  // Batch query for all source channel counts
  const counts = db.prepare(`
    SELECT source_id, COUNT(*) as c
    FROM source_channels
    GROUP BY source_id
  `).all()
  const countMap = new Map(counts.map(r => [r.source_id, r.c]))

  // Batch query for EPG channel counts
  const epgCounts = db.prepare('SELECT source_id, channel_count FROM epg_cache').all()
  const epgCountMap = new Map(epgCounts.map(r => [r.source_id, r.channel_count]))

  for (const s of sources) {
    if (s.category === 'epg') {
      s.channel_count = epgCountMap.get(s.id) || 0
    } else {
      s.channel_count = countMap.get(s.id) || 0
    }
  }
  res.json(sources)
})

router.post('/sources', (req, res) => {
  const { name, type, url, username, password, refresh_cron, category, max_streams, force_ts_extension } = req.body
  if (!name || !url) return res.status(400).json({ error: 'name, url required' })
  const cat = category || 'playlist'
  const typ = cat === 'epg' ? 'epg' : (type || 'm3u')
  const result = db.prepare(
    'INSERT INTO sources (name, type, url, username, password, refresh_cron, category, max_streams, force_ts_extension) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, typ, url, username || null, password || null, refresh_cron || '0 */6 * * *', cat, Number(max_streams) || 0, force_ts_extension ? 1 : 0)
  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(result.lastInsertRowid))
})

router.put('/sources/:id', (req, res) => {
  const { name, type, url, username, password, refresh_cron, category, max_streams, priority, cleanup_rules, skip_rules, force_ts_extension } = req.body
  const cat = category || 'playlist'
  const typ = cat === 'epg' ? 'epg' : (type || 'm3u')
  const cleanupRulesJson = cleanup_rules ? JSON.stringify(cleanup_rules) : null
  const skipRulesJson = skip_rules ? JSON.stringify(skip_rules) : null
  db.prepare(
    'UPDATE sources SET name=?, type=?, url=?, username=?, password=?, refresh_cron=?, category=?, max_streams=?, priority=?, cleanup_rules=?, skip_rules=?, force_ts_extension=? WHERE id=?'
  ).run(name, typ, url, username || null, password || null, refresh_cron || '0 */6 * * *', cat, Number(max_streams) || 0, Number(priority) || 999, cleanupRulesJson, skipRulesJson, force_ts_extension ? 1 : 0, req.params.id)
  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id))
})

router.delete('/sources/:id', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// Refresh a source — fetch live, store to DB cache
router.post('/sources/:id/refresh', async (req, res) => {
  try {
    const count = await refreshSourceCache(req.params.id)
    res.json({ ok: true, count })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Get groups across ALL sources (prefixed with source name to avoid collisions)
router.get('/sources/all/groups', (req, res) => {
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

// Get groups for a specific source
router.get('/sources/:id/groups', (req, res) => {
  const sourceId = parseInt(req.params.id)
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source) return res.status(404).json({ error: 'Source not found' })

  const rows = db.prepare(`
    SELECT group_title, COUNT(*) as count
    FROM source_channels
    WHERE source_id = ?
    GROUP BY group_title
    ORDER BY group_title
  `).all(sourceId)

  const groups = rows.map(r => ({
    name:        `${source.name} › ${r.group_title}`,
    display:     r.group_title,
    source_id:   sourceId,
    source_name: source.name,
    count:       r.count,
  }))

  const total = groups.reduce((s, g) => s + g.count, 0)
  res.json({ groups, total, cached: groups.length > 0 })
})

// Get channels for a prefixed group key across all sources
router.get('/sources/all/channels', (req, res) => {
  const groupKey = req.query.group  // e.g. "ky-tv › Sports"
  const sourceId = req.query.source_id ? parseInt(req.query.source_id) : null
  const limit    = Math.min(parseInt(req.query.limit  || '2000'), 5000)
  const offset   = parseInt(req.query.offset || '0')

  const cacheKey = `all-v3:${sourceId || ''}:${groupKey || 'all'}:${limit}:${offset}`
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
  const groupTitle = groupKey.slice(sepIdx + sep.length)

  // Query all channels with this group_title across all sources
  const total = db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE group_title = ?').get(groupTitle).c

  const rows = db.prepare(`
    SELECT sc.id, sc.tvg_id, sc.tvg_name, sc.tvg_logo, sc.group_title, sc.url, sc.source_id, sc.normalized_name, sc.quality, s.name as source_name
    FROM source_channels sc
    JOIN sources s ON sc.source_id = s.id
    WHERE sc.group_title = ?
    ORDER BY sc.id
    LIMIT ? OFFSET ?
  `).all(groupTitle, limit, offset)

  const result = {
    total, offset, limit,
    channels: rows.map(r => ({
      id:              String(r.id),
      name:            r.tvg_name,
      logo:            r.tvg_logo,
      group:           groupKey,
      group_title:     r.group_title,
      source_id:       r.source_id,
      source_name:     r.source_name,
      url:             r.url,
      tvg_id:          r.tvg_id,
      normalized_name: r.normalized_name,
      quality:         r.quality,
    }))
  }
  setCache(cacheKey, result)
  res.json(result)
})

// Get channels for a specific source and group
router.get('/sources/:id/channels', (req, res) => {
  const sourceId = parseInt(req.params.id)
  let groupTitle = req.query.group
  const limit = Math.min(parseInt(req.query.limit || '2000'), 5000)
  const offset = parseInt(req.query.offset || '0')

  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source) return res.status(404).json({ error: 'Source not found' })

  // Handle prefixed group names (e.g., "source › Sports" -> "Sports")
  if (groupTitle && groupTitle.includes(' › ')) {
    groupTitle = groupTitle.split(' › ')[1]
  }

  const cacheKey = `source:${sourceId}:${groupTitle || 'all'}:${limit}:${offset}`
  const cached = getCached(cacheKey)
  if (cached) return res.json(cached)

  let total, rows
  if (!groupTitle) {
    // Get all channels from this source
    total = db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE source_id = ?').get(sourceId).c
    rows = db.prepare(`
      SELECT id, tvg_id, tvg_name, tvg_logo, group_title, url, source_id, normalized_name, quality, raw_extinf
      FROM source_channels
      WHERE source_id = ?
      ORDER BY id
      LIMIT ? OFFSET ?
    `).all(sourceId, limit, offset)
  } else {
    // Get channels for specific group
    total = db.prepare('SELECT COUNT(*) as c FROM source_channels WHERE source_id = ? AND group_title = ?').get(sourceId, groupTitle).c
    rows = db.prepare(`
      SELECT id, tvg_id, tvg_name, tvg_logo, group_title, url, source_id, normalized_name, quality, raw_extinf
      FROM source_channels
      WHERE source_id = ? AND group_title = ?
      ORDER BY id
      LIMIT ? OFFSET ?
    `).all(sourceId, groupTitle, limit, offset)
  }

  const result = {
    total,
    offset,
    limit,
    channels: rows.map(r => ({
      id: String(r.id),
      name: r.tvg_name,
      logo: r.tvg_logo,
      group: `${source.name} › ${r.group_title}`,
      group_title: r.group_title,
      source_id: r.source_id,
      source_name: source.name,
      url: r.url,
      tvg_id: r.tvg_id,
      normalized_name: r.normalized_name,
      quality: r.quality,
      raw: r.raw_extinf,
    }))
  }

  setCache(cacheKey, result)
  res.json(result)
})

// Bulk fetch specific channel IDs (for review modal / export)
router.post('/source-channels/by-ids', (req, res) => {
  const { channelIds } = req.body
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.json([])
  }

  // Limit to prevent abuse
  const MAX_IDS = 50000
  const ids = channelIds.slice(0, MAX_IDS)

  // Build placeholders for SQL IN clause
  const placeholders = ids.map(() => '?').join(',')
  const channels = db.prepare(
    `SELECT id, tvg_id, tvg_name, tvg_logo, group_title, url, source_id, normalized_name, quality
     FROM source_channels
     WHERE id IN (${placeholders})`
  ).all(...ids)

  res.json(channels)
})

// VOD: list all groups from source_channels for a given source
router.get('/sources/:id/vod-groups', (req, res) => {
  const rows = db.prepare(
    `SELECT group_title, COUNT(*) as count FROM source_channels
     WHERE source_id = ? AND group_title != ''
     GROUP BY group_title ORDER BY group_title`
  ).all(req.params.id)
  res.json(rows)
})

// VOD: get channels from source_channels for specific groups
router.get('/sources/:id/vod-channels', (req, res) => {
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

export default router
