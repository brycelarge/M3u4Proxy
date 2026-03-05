import express from 'express'
import db from '../db.js'

const router = express.Router()

// Helper to parse programme block from XMLTV
function parseProgBlock(block) {
  const channelMatch = block.match(/channel="([^"]*)"/)
  const titleMatch = block.match(/<title[^>]*>([^<]+)<\/title>/)
  const startMatch = block.match(/start="([^"]*)"/)
  const stopMatch = block.match(/stop="([^"]*)"/)
  const episodeMatch = block.match(/<episode-num[^>]*>([^<]+)<\/episode-num>/)
  
  return {
    channel: channelMatch ? channelMatch[1] : null,
    title: titleMatch ? titleMatch[1].trim() : null,
    start: startMatch ? startMatch[1] : null,
    stop: stopMatch ? stopMatch[1] : null,
    episode: episodeMatch ? episodeMatch[1] : null,
  }
}

// ── TMDB Match Corrector ──────────────────────────────────────────────────────
router.get('/tmdb/titles/:playlistId', async (req, res) => {
  try {
    const playlistId = req.params.playlistId
    const { filter, search } = req.query

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId)
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' })
    }

    const channels = db.prepare(`
      SELECT pc.*, sc.normalized_name
      FROM playlist_channels pc
      LEFT JOIN source_channels sc ON sc.url = pc.url
      WHERE pc.playlist_id = ?
    `).all(playlistId)

    if (!channels.length) {
      return res.json({ titles: [], total: 0, stats: { matched: 0, not_found: 0, unmatched: 0, blocked: 0 } })
    }

    const epgIds = new Set(channels.map(ch => ch.custom_tvg_id || ch.tvg_id).filter(Boolean))

    if (epgIds.size === 0) {
      return res.json({ titles: [], total: 0, stats: { matched: 0, not_found: 0, unmatched: 0, blocked: 0 } })
    }

    const cacheRows = db.prepare('SELECT content FROM epg_cache WHERE content IS NOT NULL').all()

    const tvgIdToChannels = new Map()
    const excludedChannels = new Set()

    for (const ch of channels) {
      const tvgId = ch.custom_tvg_id || ch.tvg_id
      if (!tvgId) continue

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

    const titleCounts = new Map()
    const titleChannels = new Map()
    const titleRuntimes = new Map()
    const titleEpisodes = new Map()
    const progRe = /<programme\b[^>]*>[\s\S]*?<\/programme>/g
    let matchedProgs = 0
    let skippedNewsAndSports = 0

    for (const row of cacheRows) {
      progRe.lastIndex = 0
      let m
      while ((m = progRe.exec(row.content)) !== null) {
        const prog = parseProgBlock(m[0])

        if (prog.channel && excludedChannels.has(prog.channel)) {
          skippedNewsAndSports++
          continue
        }

        if (prog.title && prog.channel && epgIds.has(prog.channel)) {
          matchedProgs++
          titleCounts.set(prog.title, (titleCounts.get(prog.title) || 0) + 1)

          if (prog.start && prog.stop && !titleRuntimes.has(prog.title)) {
            const startTime = new Date(prog.start)
            const stopTime = new Date(prog.stop)
            const runtimeMinutes = Math.round((stopTime - startTime) / 1000 / 60)
            if (runtimeMinutes > 0) {
              titleRuntimes.set(prog.title, runtimeMinutes)
            }
          }

          if (prog.episode && !titleEpisodes.has(prog.title)) {
            titleEpisodes.set(prog.title, prog.episode)
          }

          if (!titleChannels.has(prog.title)) {
            titleChannels.set(prog.title, new Set())
          }
          const channelInfos = tvgIdToChannels.get(prog.channel) || []
          for (const chInfo of channelInfos) {
            titleChannels.get(prog.title).add(JSON.stringify(chInfo))
          }
        }
      }
    }

    const enrichmentData = db.prepare('SELECT * FROM tmdb_enrichment').all()
    const enrichMap = new Map(enrichmentData.map(e => [e.title, e]))

    const episodeCounts = db.prepare(`
      SELECT show_title, COUNT(*) as count
      FROM tmdb_episodes
      GROUP BY show_title
    `).all()
    const episodeMap = new Map(episodeCounts.map(e => [e.show_title, e.count]))

    const titles = []
    for (const [title, count] of titleCounts.entries()) {
      const enrich = enrichMap.get(title)
      let status = 'unmatched'

      if (enrich) {
        if (enrich.blocked) status = 'blocked'
        else if (enrich.tmdb_id) status = 'matched'
        else status = 'not_found'
      }

      if (filter && filter !== 'all' && status !== filter) continue
      if (search && !title.toLowerCase().includes(search.toLowerCase())) continue

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
        channels: channels,
        runtime_minutes: titleRuntimes.get(title) || null,
        episode_info: titleEpisodes.get(title) || null
      })
    }

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

router.post('/tmdb/search', async (req, res) => {
  try {
    if (!process.env.TMDB_API_KEY) {
      return res.status(400).json({ error: 'TMDB_API_KEY not set' })
    }

    const { query, type } = req.body
    if (!query) return res.status(400).json({ error: 'query required' })

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

router.put('/tmdb/matches/:title', async (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)
    const { tmdb_id, media_type, poster, description, blocked } = req.body

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

    if (media_type === 'tv' && tmdb_id) {
      const { fetchAndStoreAllEpisodes } = await import('../epgEnrich.js')
      await fetchAndStoreAllEpisodes(title, tmdb_id)
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[tmdb] Error updating match:', e)
    res.status(500).json({ error: e.message })
  }
})

router.put('/tmdb/block/:title', (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)
    const { blocked } = req.body

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

router.delete('/tmdb/matches/:title', (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)

    db.prepare(`
      UPDATE tmdb_enrichment
      SET tmdb_id=NULL, media_type=NULL, poster=NULL, description=NULL, manual_override=0
      WHERE title=?
    `).run(title)

    db.prepare('DELETE FROM tmdb_episodes WHERE show_title=?').run(title)

    res.json({ ok: true })
  } catch (e) {
    console.error('[tmdb] Error clearing match:', e)
    res.status(500).json({ error: e.message })
  }
})

export default router
