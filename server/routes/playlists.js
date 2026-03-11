import express from 'express'
import cron from 'node-cron'
import { existsSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import db from '../db.js'
import { buildM3U, writeM3U } from '../m3uBuilder.js'
import { GUIDE_XML } from '../epgGrab.js'
import {
  getPlaylistXmltvCache,
  setPlaylistXmltvCache,
  getPlaylistXmltvCacheMeta,
  invalidatePlaylistXmltvCache,
} from '../services/xmltvCache.js'

const router = express.Router()

function buildPlaylistXmltvSignature(playlistId, channels, epgMappings, cacheRows) {
  const payload = {
    playlistId: Number(playlistId),
    channels: channels.map(ch => ({
      id: ch.id,
      tvg_id: ch.tvg_id || '',
      custom_tvg_id: ch.custom_tvg_id || '',
      tvg_name: ch.tvg_name || '',
      tvg_logo: ch.tvg_logo || '',
      custom_logo: ch.custom_logo || '',
      group_title: ch.group_title || '',
      sort_order: ch.sort_order ?? null,
      epg_source_id: ch.epg_source_id ?? null,
      source_id: ch.source_id ?? null,
      url: ch.url || '',
      epg_id: ch.epg_id || '',
    })),
    mappings: epgMappings.map(row => `${row.source_tvg_id}->${row.target_tvg_id}`),
    cacheRows: cacheRows.map(row => ({
      source_id: row.source_id,
      last_fetched: row.last_fetched || '',
      channel_count: row.channel_count || 0,
      content_len: row.content_len || 0,
    })),
  }

  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex')
}

function getRelevantEpgSources(channels, epgMappings) {
  const explicitSourceIds = new Set(
    channels
      .map(ch => ch.epg_source_id ? Number(ch.epg_source_id) : null)
      .filter(Number.isFinite)
  )

  if (explicitSourceIds.size) return [...explicitSourceIds]

  const localGuideSource = db.prepare(`
    SELECT id
    FROM sources
    WHERE category = 'epg'
      AND (
        name = 'EPG Grabber (guide.xml)'
        OR url LIKE '%/guide.xml'
      )
    ORDER BY id DESC
    LIMIT 1
  `).get()

  if (localGuideSource) {
    return [localGuideSource.id]
  }

  const allCachedSourceIds = db.prepare(`
    SELECT source_id
    FROM epg_cache
    WHERE content IS NOT NULL
    ORDER BY last_fetched DESC
  `).all().map(r => r.source_id)

  if (allCachedSourceIds.length === 1) return allCachedSourceIds

  const mappedSourceIds = new Set(
    epgMappings
      .filter(row => channels.some(ch => ch.tvg_id === row.source_tvg_id || ch.custom_tvg_id === row.source_tvg_id))
      .map(() => localGuideSource?.id)
      .filter(Number.isFinite)
  )

  return mappedSourceIds.size ? [...mappedSourceIds] : allCachedSourceIds
}

// ── Playlists ─────────────────────────────────────────────────────────────────
router.get('/playlists', (req, res) => {
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
    const c = countMap.get(p.id) || { channel_count: 0, group_count: 0, source_count: 0 }
    p.channel_count = c.channel_count
    p.group_count = c.group_count
    p.source_count = c.source_count
    p.groups = groupMap[p.id] || []
  }
  res.json(playlists)
})

router.post('/playlists', (req, res) => {
  const { name, source_id, output_path, schedule, playlist_type } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const result = db.prepare(
    'INSERT INTO playlists (name, source_id, output_path, schedule, playlist_type) VALUES (?, ?, ?, ?, ?)'
  ).run(name, source_id || null, output_path || null, schedule || '0 */6 * * *', playlist_type || 'live')
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(result.lastInsertRowid))
})

router.put('/playlists/:id', (req, res) => {
  const { name, source_id, output_path, schedule, playlist_type } = req.body
  db.prepare(
    'UPDATE playlists SET name=?, source_id=?, output_path=?, schedule=?, playlist_type=? WHERE id=?'
  ).run(name, source_id || null, output_path || null, schedule || '0 */6 * * *', playlist_type || 'live', req.params.id)
  invalidatePlaylistXmltvCache(req.params.id)
  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id))
})

router.delete('/playlists/:id', (req, res) => {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id)
  invalidatePlaylistXmltvCache(req.params.id)
  res.json({ ok: true })
})

// Clean up orphaned playlist_channels (channels whose URLs no longer exist in source_channels)
router.post('/playlists/cleanup-orphans', (req, res) => {
  const deletedCount = db.prepare(`
    DELETE FROM playlist_channels
    WHERE id IN (
      SELECT pc.id FROM playlist_channels pc
      LEFT JOIN source_channels sc ON sc.url = pc.url
      WHERE sc.id IS NULL
    )
  `).run().changes

  // Assuming channelCache is imported or accessible, clear it
  // In the modular version, we'd import clearCache
  import('../services/cache.js').then(({ clearCache }) => clearCache())

  res.json({ ok: true, deleted: deletedCount, message: `Removed ${deletedCount} orphaned channels` })
})

// PATCH schedule only — used by the scheduler UI
router.patch('/playlists/:id/schedule', (req, res) => {
  const { schedule } = req.body
  if (schedule && !cron.validate(schedule)) return res.status(400).json({ error: 'Invalid cron expression' })
  db.prepare('UPDATE playlists SET schedule = ? WHERE id = ?').run(schedule || null, req.params.id)
  res.json({ ok: true })
})

// GET all playlist schedules (for the settings scheduler UI)
router.get('/playlists/schedules', (req, res) => {
  const playlists = db.prepare('SELECT id, name, schedule, last_built, output_path, (SELECT COUNT(*) FROM playlist_channels WHERE playlist_id = playlists.id) as channel_count FROM playlists ORDER BY name').all()
  res.json(playlists.map(p => ({
    ...p,
    schedule_valid: p.schedule ? cron.validate(p.schedule) : false,
  })))
})

// Get channels in a playlist
router.get('/playlists/:id/channels', (req, res) => {
  const dedupe = req.query.dedupe === 'true'

  if (!dedupe) {
    // Return all channels without deduplication
    res.json(db.prepare('SELECT * FROM playlist_channels WHERE playlist_id = ? ORDER BY sort_order, id').all(req.params.id))
    return
  }

  // Return deduplicated channels using SAME logic as M3U export and EPG Mappings
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
  `).all(req.params.id)

  // Deduplicate by normalized_name - keep only the first (best) variant
  const seen = new Set()
  const channels = allChannels.filter(ch => {
    if (!ch.normalized_name) return true
    if (seen.has(ch.normalized_name)) return false
    seen.add(ch.normalized_name)
    return true
  })

  // Re-sort by sort_order after deduplication
  channels.sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.id - b.id
  })

  res.json(channels)
})

// Get selected channels for a playlist — returns flat array of channel objects
router.get('/playlists/:id/selection', (req, res) => {
  const playlistId = req.params.id

  // Get total channel count for this playlist
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM playlist_channels WHERE playlist_id = ?').get(playlistId).count

  if (totalCount === 0) {
    return res.json({ channels: [], totalCount: 0 })
  }

  // Fetch all selected channels as a flat array with full metadata
  const rows = db.prepare(`
    SELECT
      sc.id as sc_id,
      sc.tvg_id,
      sc.tvg_name as sc_name,
      sc.tvg_logo,
      sc.group_title,
      sc.url,
      sc.source_id,
      sc.normalized_name,
      sc.quality,
      pc.sort_order,
      pc.custom_tvg_id,
      pc.group_title as pc_group,
      pc.epg_source_id,
      pc.tvg_name as pc_name,
      s.name as source_name
    FROM playlist_channels pc
    JOIN source_channels sc ON sc.url = pc.url
    JOIN sources s ON s.id = sc.source_id
    WHERE pc.playlist_id = ?
    ORDER BY pc.sort_order, pc.id
  `).all(playlistId)

  // Build channel objects with all metadata
  // IMPORTANT: Use current group_title from source_channels (r.group_title), not stale playlist_channels group
  // Only use pc_group if it's an override (different from current source group)
  const selectedChannels = rows.map(r => ({
    id: String(r.sc_id),
    name: r.pc_name || r.sc_name,  // For ReviewSelectionModal compatibility
    tvg_name: r.pc_name || r.sc_name,
    tvg_logo: r.tvg_logo,
    tvg_id: r.custom_tvg_id || r.tvg_id,
    group_title: r.group_title,  // Use CURRENT group from source_channels
    url: r.url,
    source_id: r.source_id,
    source_name: r.source_name,
    normalized_name: r.normalized_name,
    quality: r.quality,
    sort_order: r.sort_order || 0,
    epg_source_id: r.epg_source_id || null,
    // Store override values
    _override_group_title: r.pc_group && r.pc_group !== r.group_title ? r.pc_group : null,
    _original_tvg_name: r.sc_name,
    _original_tvg_id: r.tvg_id
  }))

  res.json({ channels: selectedChannels, totalCount })
})

// Save channels to a playlist (replaces all existing)
router.put('/playlists/:id/channels', (req, res) => {
  const { channels } = req.body // array of channel objects
  if (!Array.isArray(channels)) return res.status(400).json({ error: 'channels must be array' })
  const insert = db.prepare(
    'INSERT INTO playlist_channels (playlist_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, custom_tvg_id, sort_order, source_id, epg_source_id, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const replaceAll = db.transaction((playlistId, chs) => {
    db.prepare('DELETE FROM playlist_channels WHERE playlist_id = ?').run(playlistId)
    chs.forEach((ch, i) => {
      const contentType = ch.content_type || 'live'
      insert.run(playlistId, ch.tvg_id || '', ch.tvg_name, ch.tvg_logo || '', ch.group_title || '', ch.url, ch.raw_extinf || '', ch.custom_tvg_id || '', ch.sort_order ?? i, ch.source_id || null, ch.epg_source_id || null, contentType)
    })
  })
  replaceAll(req.params.id, channels)
  invalidatePlaylistXmltvCache(req.params.id)
  res.json({ ok: true, count: channels.length })
})

// Save playlist by group selections — server resolves channels from source_channels directly
// Body: { sourceId: number|null, groups: { groupName: '__all__' | number[] }, overrides: { [channelId]: { sort_order, custom_tvg_id, group_title, epg_source_id, tvg_name } } }
router.put('/playlists/:id/channels-by-groups', (req, res) => {
  const { sourceId, groups, overrides = {} } = req.body
  if (!groups || typeof groups !== 'object') return res.status(400).json({ error: 'groups required' })

  const insert = db.prepare(
    'INSERT INTO playlist_channels (playlist_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, custom_tvg_id, sort_order, source_id, epg_source_id, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  const replaceAll = db.transaction((playlistId) => {
    // Store group selections for STRM export to use later
    db.prepare('UPDATE playlists SET group_selections = ? WHERE id = ?').run(
      JSON.stringify({ sourceId, groups }),
      playlistId
    )

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
        const groupTitle = ov.group_title || ch.group_title || ''
        const contentType = ch.content_type || 'live'
        insert.run(
          playlistId,
          ch.tvg_id || '',
          ov.tvg_name || ch.tvg_name,
          ch.tvg_logo || '',
          groupTitle,
          ch.url,
          ch.raw_extinf || '',
          ov.custom_tvg_id || '',
          ov.sort_order ?? i,
          ch.source_id || null,
          ov.epg_source_id ? Number(ov.epg_source_id) : null,
          contentType
        )
        i++
      }
    }
    return i
  })

  const count = replaceAll(req.params.id)
  invalidatePlaylistXmltvCache(req.params.id)
  res.json({ ok: true, count })
})

// Get group order for a playlist
router.get('/playlists/:id/group-order', (req, res) => {
  const playlist = db.prepare('SELECT group_order FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Not found' })
  const groups = db.prepare("SELECT DISTINCT group_title FROM playlist_channels WHERE playlist_id = ? AND group_title != '' ORDER BY group_title").all(req.params.id).map(r => r.group_title)
  const saved = playlist.group_order ? JSON.parse(playlist.group_order) : []
  // Merge: saved order first, then any new groups not yet in saved order
  const ordered = [...saved.filter(g => groups.includes(g)), ...groups.filter(g => !saved.includes(g))]
  res.json({ order: ordered })
})

// Save group order for a playlist
router.put('/playlists/:id/group-order', (req, res) => {
  const { order } = req.body
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' })
  db.prepare('UPDATE playlists SET group_order = ? WHERE id = ?').run(JSON.stringify(order), req.params.id)
  invalidatePlaylistXmltvCache(req.params.id)
  res.json({ ok: true })
})

// Build and save M3U to disk for a playlist
router.post('/playlists/:id/build', async (req, res) => {
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

  // Load VOD metadata if this is a VOD playlist
  let vodMetadata = null
  if (playlist.playlist_type === 'vod') {
    const { getAllVodMetadata } = await import('../nfo-parser.js')
    const metadataRows = getAllVodMetadata()
    vodMetadata = new Map(metadataRows.map(m => [String(m.channel_id), m]))
  }

  if (!playlist.output_path) {
    const content = buildM3U(channels, epgMap, { vodMetadata })
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="${playlist.name}.m3u"`)
    return res.send(content)
  }

  const content = buildM3U(channels, epgMap, { vodMetadata })
  try {
    writeM3U(playlist.output_path, content)
    db.prepare("UPDATE playlists SET last_built = datetime('now') WHERE id = ?").run(playlist.id)
    res.json({ ok: true, path: playlist.output_path, channels: channels.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/playlists/:id/m3u', async (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })

  // Get all channels with their normalized names and deduplicate
  const allChannels = db.prepare(`
    SELECT
      pc.id, pc.tvg_id, pc.tvg_name, pc.tvg_logo, pc.group_title,
      pc.url, pc.sort_order, pc.source_id, pc.epg_source_id,
      pc.custom_tvg_id, pc.custom_logo,
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

  // Load VOD metadata if this is a VOD playlist
  let vodMetadata = null
  if (playlist.playlist_type === 'vod') {
    const { getAllVodMetadata } = await import('../nfo-parser.js')
    const metadataRows = getAllVodMetadata()
    vodMetadata = new Map(metadataRows.map(m => [String(m.channel_id), m]))
  }

  // Always sort by channel number (sort_order) after deduplication
  if (playlist.group_order) {
    const order = JSON.parse(playlist.group_order)
    channels = [...channels].sort((a, b) => {
      const ai = order.indexOf(a.group_title); const bi = order.indexOf(b.group_title)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi) || (a.sort_order || 9999) - (b.sort_order || 9999)
    })
  } else {
    // No group order - sort by channel number globally
    channels = [...channels].sort((a, b) => (a.sort_order || 9999) - (b.sort_order || 9999))
  }

  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const baseUrl = `${proto}://${host}`
  const epgUrl = existsSync(GUIDE_XML) ? `${baseUrl}/guide.xml` : ''

  const catchupSrc = process.env.CATCHUP_SOURCE || ''
  const catchupDays = parseInt(process.env.CATCHUP_DAYS || '7')

  const content = buildM3U(channels, epgMap, { baseUrl, epgUrl, catchupSrc: catchupSrc || undefined, catchupDays, vodMetadata })

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
  res.setHeader('Content-Disposition', `inline; filename="${playlist.name}.m3u"`)
  res.send(content)
})

// Per-playlist XMLTV — generates clean feed from playlist channels and their EPG mappings
router.get('/playlists/:id/xmltv', async (req, res) => {
  const t0 = Date.now()
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
  if (playlist.playlist_type === 'composite') return res.status(400).json({ error: 'XMLTV not available for composite playlists' })

  // Get all channels — no OR-join on epg_mappings (slow). Apply EPG mapping in JS.
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

  // Load EPG mappings once (small table) and apply in JS — avoids OR-join
  const epgMappings = db.prepare('SELECT source_tvg_id, target_tvg_id FROM epg_mappings').all()
  const epgMap = new Map(epgMappings.map(m => [m.source_tvg_id, m.target_tvg_id]))

  for (const ch of allChannels) {
    if (ch.custom_tvg_id && ch.custom_tvg_id !== '') {
      ch.epg_id = ch.custom_tvg_id
    } else if (ch.tvg_id && epgMap.has(ch.tvg_id)) {
      ch.epg_id = epgMap.get(ch.tvg_id)
    } else {
      ch.epg_id = ch.tvg_id || ''
    }
  }

  const t1 = Date.now()
  console.log(`[xmltv] channels query+epg_map: ${t1 - t0}ms (${allChannels.length} channels)`)

  // Deduplicate by normalized_name
  const seen = new Set()
  const channels = allChannels.filter(ch => {
    if (!ch.normalized_name) return true
    if (seen.has(ch.normalized_name)) return false
    seen.add(ch.normalized_name)
    return true
  })

  channels.sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.id - b.id
  })

  const mappedChannels = channels.filter(ch => ch.epg_id && ch.epg_id.trim())
  const compress = req.query.compress === 'true'

  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')

  if (!mappedChannels.length) {
    res.setHeader('X-XMLTV-Cache', 'MISS')
    res.setHeader('X-XMLTV-Sources', '0')
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="m3u4prox"></tv>`)
  }

  const relevantSourceIds = getRelevantEpgSources(mappedChannels, epgMappings)
  const cacheRows = relevantSourceIds.length ? relevantSourceIds.map(id => ({ source_id: id, channel_count: 0 })) : []

  const proto  = req.headers['x-forwarded-proto'] || req.protocol
  const host   = req.headers['x-forwarded-host']  || req.headers.host
  const port   = host?.split(':')[1] || (proto === 'https' ? '443' : '3005')
  const hostIp = process.env.HOST_IP
  const baseUrl = hostIp ? `${proto}://${hostIp}:${port}` : `${proto}://${host}`
  const cacheKey = buildPlaylistXmltvSignature(playlist.id, mappedChannels, epgMappings, cacheRows)
  const cached = getPlaylistXmltvCache(playlist.id, cacheKey, compress)

  if (cached) {
    const meta = getPlaylistXmltvCacheMeta(playlist.id)
    res.setHeader('X-XMLTV-Cache', 'HIT')
    res.setHeader('X-XMLTV-Sources', String(meta?.sourceIds?.length || 0))
    if (compress) res.setHeader('Content-Encoding', 'gzip')
    return res.send(cached)
  }

  const t2 = Date.now()
  const { generateXmltv } = await import('../services/xmltv.js')
  const out = generateXmltv(db, mappedChannels, relevantSourceIds, baseUrl)
  const t3 = Date.now()
  console.log(`[xmltv] generateXmltv: ${t3 - t2}ms, total: ${t3 - t0}ms`)
  let compressed = null

  if (compress) {
    const { gzipSync } = await import('node:zlib')
    compressed = gzipSync(Buffer.from(out))
    res.setHeader('Content-Encoding', 'gzip')
    setPlaylistXmltvCache(playlist.id, cacheKey, out, compressed, cacheRows.map(r => r.source_id))
    res.setHeader('X-XMLTV-Cache', 'MISS')
    res.setHeader('X-XMLTV-Sources', String(cacheRows.length))
    res.send(compressed)
  } else {
    setPlaylistXmltvCache(playlist.id, cacheKey, out, compressed, cacheRows.map(r => r.source_id))
    res.setHeader('X-XMLTV-Cache', 'MISS')
    res.setHeader('X-XMLTV-Sources', String(cacheRows.length))
    res.send(out)
  }
})

export default router
