import express from 'express'
import path from 'node:path'
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import db from '../db.js'
import { GUIDE_XML, EPG_DIR, runGrab, grabState } from '../epgGrab.js'
import { syncEpgSites, getLastSynced, getSiteList } from '../epgSync.js'
import { enrichGuide, enrichState } from '../epgEnrich.js'

const CHANNELS_XML = path.join(EPG_DIR, 'channels.xml')

const router = express.Router()

// ── EPG Mappings ──────────────────────────────────────────────────────────────
router.get('/epg-mappings', (req, res) => {
  res.json(db.prepare('SELECT * FROM epg_mappings ORDER BY source_tvg_id').all())
})

router.post('/epg-mappings', (req, res) => {
  const { source_tvg_id, target_tvg_id, note } = req.body
  if (!source_tvg_id || !target_tvg_id) return res.status(400).json({ error: 'source_tvg_id and target_tvg_id required' })
  const result = db.prepare(
    'INSERT OR REPLACE INTO epg_mappings (source_tvg_id, target_tvg_id, note) VALUES (?, ?, ?)'
  ).run(source_tvg_id, target_tvg_id, note || null)
  res.json(db.prepare('SELECT * FROM epg_mappings WHERE id = ?').get(result.lastInsertRowid))
})

router.delete('/epg-mappings/:id', (req, res) => {
  db.prepare('DELETE FROM epg_mappings WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// Clear all EPG mappings + custom_tvg_id for every channel in a playlist
router.delete('/epg-mappings/by-playlist/:playlist_id', (req, res) => {
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
export function invalidateEpgCache() { _epgListCache = null; _epgListCacheKey = null }

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
router.get('/epg-mappings/auto-match', (req, res) => {
  try {
    const { playlist_id } = req.query
    if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' })

    // Check if playlist exists and is a live playlist
    const playlist = db.prepare('SELECT id, name, playlist_type FROM playlists WHERE id = ?').get(playlist_id)
    if (!playlist) return res.status(404).json({ error: `Playlist with ID ${playlist_id} not found` })
    if (playlist.playlist_type !== 'live') {
      return res.status(400).json({ error: 'EPG mappings only available for live playlists' })
    }

    // Get playlist channels, deduplicated by normalized_name (one channel per normalized name)
    // Use SAME ordering as M3U export to ensure we show the same channels
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
        sc.normalized_name,
        source_priority ASC,
        quality_order ASC,
        pc.sort_order, pc.id
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
    // Group by the FIRST channel_id (the one we're looking up), but include ALL variant channel_ids
    const variantsMap = new Map()
    const seenPairs = new Set()

    for (const v of allVariants) {
      const key = `${v.channel_id}|${v.url}`
      if (seenPairs.has(key)) continue // Skip duplicate url for same channel
      seenPairs.add(key)

      if (!variantsMap.has(v.channel_id)) variantsMap.set(v.channel_id, [])

      // Find the playlist_channel ID for this variant's URL
      const variantChannel = allChannels.find(ch => ch.url === v.url)

      variantsMap.get(v.channel_id).push({
        channel_id: variantChannel?.id || null,
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
        sort_order:    ch.sort_order || null,
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

// Bulk accept auto-matches
router.post('/epg-mappings/bulk', (req, res) => {
  const { mappings } = req.body // [{source_tvg_id, target_tvg_id}]
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' })
  const insert = db.prepare('INSERT OR REPLACE INTO epg_mappings (source_tvg_id, target_tvg_id, note) VALUES (?, ?, ?)')
  const valid = mappings.filter(r => r.source_tvg_id && r.source_tvg_id.trim())
  const insertAll = db.transaction((rows) => { for (const r of rows) insert.run(r.source_tvg_id, r.target_tvg_id, r.note || 'auto-matched') })
  insertAll(valid)
  res.json({ ok: true, count: valid.length })
})

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
router.get('/epg/sites/sync/status', (req, res) => {
  res.json({
    inProgress:  syncInProgress,
    lastSynced:  getLastSynced(db),
    totalSites:  db.prepare('SELECT COUNT(DISTINCT site) as c FROM epg_site_channels').get().c,
    totalChannels: db.prepare('SELECT COUNT(*) as c FROM epg_site_channels').get().c,
    log:         syncLog.slice(-20),
  })
})

// Trigger a sync
router.post('/epg/sites/sync', async (req, res) => {
  if (syncInProgress) return res.json({ ok: true, already: true, message: 'Sync already in progress' })
  // Start async, respond immediately
  res.json({ ok: true, message: 'Sync started' })
  runSync().catch(e => console.error('[epg-sync] Error:', e.message))
})

// List all sites from DB
router.get('/epg/sites', (req, res) => {
  const sites = getSiteList(db)
  if (!sites.length) {
    return res.json({ empty: true, message: 'No sites synced yet. Run a sync first.' })
  }
  res.json(sites)
})

// Search channels in DB — MUST be before /:site routes
router.get('/epg/sites/search', (req, res) => {
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

// Get details for a specific site
router.get('/epg/sites/:site', (req, res) => {
  const site = req.params.site
  const count = db.prepare('SELECT COUNT(*) as c FROM epg_site_channels WHERE site = ?').get(site).c
  if (count === 0) return res.status(404).json({ error: 'Site not found or no channels' })
  res.json({ site, count })
})

// List distinct country/variant files for a site from DB
router.get('/epg/sites/:site/files', (req, res) => {
  const rows = db.prepare(
    'SELECT file, COUNT(*) as count FROM epg_site_channels WHERE site = ? GROUP BY file ORDER BY file'
  ).all(req.params.site)
  if (!rows.length) return res.status(404).json({ error: `No files found for ${req.params.site}. Run a sync first.` })
  res.json(rows)
})

// Get channels for a specific site+file from DB
router.get('/epg/sites/:site/channels', (req, res) => {
  const { file } = req.query
  const rows = file
    ? db.prepare('SELECT * FROM epg_site_channels WHERE site = ? AND file = ? ORDER BY name').all(req.params.site, file)
    : db.prepare('SELECT * FROM epg_site_channels WHERE site = ? ORDER BY name').all(req.params.site)
  if (!rows.length) return res.status(404).json({ error: `No channels found for ${req.params.site}${file ? ` / ${file}` : ''}. Run a sync first.` })
  res.json(rows)
})

// Add/remove selected channel for EPG grabber
router.post('/epg/selected', (req, res) => {
  const { site, site_id, name, xmltv_id, lang, logo, selected } = req.body
  if (selected) {
    db.prepare(`
      INSERT OR REPLACE INTO epg_selected_channels (site, site_id, name, xmltv_id, lang, logo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(site, site_id, name, xmltv_id, lang || 'en', logo || '')
  } else {
    db.prepare('DELETE FROM epg_selected_channels WHERE site = ? AND site_id = ?').run(site, site_id)
  }
  res.json({ ok: true })
})

// List currently selected EPG channels
router.get('/epg/selected', (req, res) => {
  const rows = db.prepare('SELECT * FROM epg_selected_channels ORDER BY site, name').all()
  res.json(rows)
})

// Trigger EPG grab
router.post('/epg/grab', async (req, res) => {
  if (grabState.running) return res.json({ ok: true, already: true, message: 'Grab already in progress' })
  res.json({ ok: true, message: 'Grab started' })
  runGrab(db).catch(e => console.error('[epg-grab] Error:', e.message))
})

// Get grab status
router.get('/epg/grab/status', (req, res) => {
  // Check if guide.xml exists and get its size/date
  let guideInfo = null
  if (existsSync(GUIDE_XML)) {
    const s = statSync(GUIDE_XML)
    guideInfo = { size: s.size, mtime: s.mtime }
  }
  res.json({ ...grabState, guide: guideInfo })
})

// Trigger TMDB enrichment
router.post('/epg/enrich', async (req, res) => {
  if (enrichState.running) return res.json({ ok: true, already: true, message: 'Enrichment already in progress' })
  res.json({ ok: true, message: 'Enrichment started' })
  enrichGuide(db).catch(e => console.error('[epg-enrich] Error:', e.message))
})

// Get enrichment status
router.get('/epg/enrich/status', (req, res) => {
  res.json(enrichState)
})

// Note: /guide.xml is served at ROOT level in index.js, not under /api
// This endpoint is kept for backward compat but shouldn't be used

// Get sources for EPG dropdown
router.get('/epg/sources', (req, res) => {
  const sources = db.prepare("SELECT id, name FROM sources WHERE category = 'epg' ORDER BY name").all()
  res.json(sources)
})

// Get channels.xml content
router.get('/epg/channels-xml', (req, res) => {
  try {
    const content = existsSync(CHANNELS_XML) ? readFileSync(CHANNELS_XML, 'utf8') : ''
    res.json({ content, path: CHANNELS_XML })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Save channels.xml content and persist selections to DB
router.put('/epg/channels-xml', (req, res) => {
  const { content, channels } = req.body
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' })
  try {
    writeFileSync(CHANNELS_XML, content, 'utf8')

    if (Array.isArray(channels)) {
      const del = db.prepare('DELETE FROM epg_selected_channels')
      const ins = db.prepare(
        'INSERT INTO epg_selected_channels (site, site_id, name, xmltv_id, lang, logo, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))'
      )
      const save = db.transaction(() => {
        del.run()
        for (const ch of channels) {
          ins.run(ch.site, ch.site_id, ch.name, ch.xmltv_id, ch.lang || 'en', ch.logo || '')
        }
      })
      save()
    }

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get saved channel selections
router.get('/epg/selected-channels', (req, res) => {
  try {
    const channels = db.prepare('SELECT site, site_id, name, xmltv_id, lang, logo FROM epg_selected_channels ORDER BY site, name').all()
    res.json(channels)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get channel IDs from locally cached EPG sources (epg_cache table)
router.get('/epg/cached-channels', (req, res) => {
  const rows = db.prepare(`
    SELECT ec.source_id, ec.content, s.name as source_name
    FROM epg_cache ec
    JOIN sources s ON s.id = ec.source_id
    WHERE ec.content IS NOT NULL
    ORDER BY s.name
  `).all()

  const channels = []
  for (const row of rows) {
    const lines = row.content.split('\n')
    let currentId = null
    let currentName = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('<channel')) {
        const idMatch = trimmed.match(/id="([^"]*)"/)
        if (idMatch) currentId = idMatch[1]
      } else if (trimmed.startsWith('<display-name')) {
        const nameMatch = trimmed.match(/>([^<]*)</)
        if (nameMatch) currentName = nameMatch[1]
      } else if (trimmed === '</channel>') {
        if (currentId && currentName) {
          channels.push({
            id: currentId,
            name: currentName,
            source_id: row.source_id,
            source_name: row.source_name
          })
        }
        currentId = null
        currentName = null
      }
    }
  }

  res.json(channels)
})

// Register our own guide.xml as an EPG source
router.post('/epg/sources/from-scraper', (req, res) => {
  const proto = req.protocol || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const url = `${proto}://${host}/guide.xml`

  const existing = db.prepare('SELECT id FROM sources WHERE url LIKE ? AND category = ?').get('%/guide.xml', 'epg')
  if (existing) {
    return res.json({ ok: true, id: existing.id, created: false, message: 'EPG source already exists' })
  }
  const result = db.prepare(
    "INSERT INTO sources (name, type, url, category, refresh_cron) VALUES ('EPG Grabber (guide.xml)', 'epg', ?, 'epg', '0 4 * * *')"
  ).run(url)
  res.json({ ok: true, id: result.lastInsertRowid, created: true })
})

// Search EPG in cache (for manual mapping)
router.get('/epg/search-cached', (req, res) => {
  const { q, source_id } = req.query
  if (!q) return res.json([])

  const pattern = `%${q.toLowerCase()}%`
  let sql = `
    WITH channels AS (
      SELECT
        source_id,
        content
      FROM epg_cache
      WHERE content IS NOT NULL
      ${source_id ? 'AND source_id = ?' : ''}
    )
    SELECT * FROM channels
  `
  const rows = source_id ? db.prepare(sql).all(source_id) : db.prepare(sql).all()

  const results = []
  for (const row of rows) {
    const sourceName = db.prepare('SELECT name FROM sources WHERE id = ?').get(row.source_id)?.name || 'Unknown'
    const matches = []
    const lines = row.content.split('\n')
    let currentId = null
    let currentName = null
    let currentIcon = ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('<channel')) {
        const idMatch = trimmed.match(/id="([^"]*)"/)
        if (idMatch) currentId = idMatch[1]
      } else if (trimmed.startsWith('<display-name')) {
        const nameMatch = trimmed.match(/>([^<]*)<\//)
        if (nameMatch) currentName = nameMatch[1]
      } else if (trimmed.startsWith('<icon')) {
        const iconMatch = trimmed.match(/src="([^"]*)"/)
        if (iconMatch) currentIcon = iconMatch[1]
      } else if (trimmed === '</channel>') {
        if (currentId && currentName && currentName.toLowerCase().includes(q.toLowerCase())) {
          results.push({
            id: currentId,
            name: currentName,
            logo: currentIcon,
            source_id: row.source_id,
            source_name: sourceName
          })
        }
        currentId = null; currentName = null; currentIcon = ''
      }
    }
  }

  res.json(results.slice(0, 50))
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

export default router
