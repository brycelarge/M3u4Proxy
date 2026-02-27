/**
 * Xtream Codes API emulation
 *
 * Authentication is user-based: each user in the `users` table has a
 * username/password and is assigned a playlist. Apps connect to:
 *
 *   /xtream/player_api.php?username=X&password=Y
 *   /xtream/get.php?username=X&password=Y
 *   /xtream/xmltv.php?username=X&password=Y
 *   /xtream/:user/:pass/:channelId   (stream URL)
 *
 * Legacy per-playlist endpoints (/xtream/:pid/...) are kept for
 * backwards compatibility with the Settings page credential display.
 */

import db from './db.js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { GUIDE_XML } from './epgGrab.js'
import { verifyPassword } from './auth.js'

// Extract current/upcoming program from XMLTV guide for a channel
function getEpgFromXmltv(tvgId, epgMap) {
  if (!tvgId || !existsSync(GUIDE_XML)) return null

  try {
    const mappedId = epgMap.get(tvgId) || tvgId
    const xmlContent = readFileSync(GUIDE_XML, 'utf8')

    // Find all programmes for this channel
    const channelRegex = new RegExp(`<programme[^>]*channel="${mappedId}"[^>]*>([\\s\\S]*?)</programme>`, 'g')
    const programmes = []
    let match

    while ((match = channelRegex.exec(xmlContent)) !== null) {
      const progBlock = match[0]
      const startMatch = progBlock.match(/start="([^"]+)"/)
      const stopMatch = progBlock.match(/stop="([^"]+)"/)
      const titleMatch = progBlock.match(/<title[^>]*>([^<]+)<\/title>/)
      const descMatch = progBlock.match(/<desc[^>]*>([^<]+)<\/desc>/)

      if (startMatch && stopMatch) {
        programmes.push({
          start: startMatch[1],
          stop: stopMatch[1],
          title: titleMatch ? titleMatch[1] : '',
          description: descMatch ? descMatch[1] : ''
        })
      }
    }

    if (programmes.length === 0) return null

    // Find current or next programme
    const now = new Date()
    const parseXmltvTime = (str) => {
      // XMLTV format: YYYYMMDDHHmmss +TZTZ
      const year = parseInt(str.substring(0, 4))
      const month = parseInt(str.substring(4, 6)) - 1
      const day = parseInt(str.substring(6, 8))
      const hour = parseInt(str.substring(8, 10))
      const min = parseInt(str.substring(10, 12))
      const sec = parseInt(str.substring(12, 14))
      return new Date(year, month, day, hour, min, sec)
    }

    // Find current programme
    for (const prog of programmes) {
      const start = parseXmltvTime(prog.start)
      const stop = parseXmltvTime(prog.stop)
      if (now >= start && now <= stop) {
        return {
          title: prog.title,
          description: prog.description,
          start: prog.start,
          stop: prog.stop
        }
      }
    }

    // If no current programme, return next upcoming
    for (const prog of programmes) {
      const start = parseXmltvTime(prog.start)
      if (start > now) {
        return {
          title: prog.title,
          description: prog.description,
          start: prog.start,
          stop: prog.stop
        }
      }
    }

    return null
  } catch (e) {
    console.error(`[xtream] Error parsing XMLTV for ${tvgId}:`, e.message)
    return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.headers.host || ''
  // If request came in on localhost/127.0.0.1 but HOST_IP is set, use HOST_IP so
  // external apps get correct stream URLs instead of localhost
  const hostName = host.split(':')[0]
  if (process.env.HOST_IP && (hostName === 'localhost' || hostName === '127.0.0.1')) {
    const port = host.split(':')[1] || process.env.PORT || '3005'
    return `${proto}://${process.env.HOST_IP}:${port}`
  }
  return `${proto}://${host}`
}

function getPlaylist(id) {
  return db.prepare('SELECT * FROM playlists WHERE id = ?').get(id)
}

function getChannels(playlistId) {
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
  `).all(playlistId)

  // Deduplicate by normalized_name - keep only the first (best) variant
  // Channels without normalized_name are kept as-is (no deduplication)
  const seen = new Set()
  let channels = allChannels.filter(ch => {
    if (!ch.normalized_name) return true // Keep channels without normalized_name
    if (seen.has(ch.normalized_name)) return false // Skip duplicates
    seen.add(ch.normalized_name)
    return true
  })

  const playlist = db.prepare('SELECT group_order FROM playlists WHERE id = ?').get(playlistId)
  if (playlist?.group_order) {
    const order = JSON.parse(playlist.group_order)
    channels = [...channels].sort((a, b) => {
      const ai = order.indexOf(a.group_title), bi = order.indexOf(b.group_title)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi) || a.sort_order - b.sort_order
    })
  }
  return channels
}

function getEpgMap() {
  return new Map(
    db.prepare('SELECT source_tvg_id, target_tvg_id FROM epg_mappings').all()
      .map(r => [r.source_tvg_id, r.target_tvg_id])
  )
}

// ── User-based auth ───────────────────────────────────────────────────────────
function touchLastConnected(username) {
  try { db.prepare(`UPDATE users SET last_connected_at = datetime('now') WHERE username = ?`).run(username) } catch {}
}

async function lookupUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username)
  if (!user) return null
  if (!await verifyPassword(password, user.password)) return null
  if (user.expires_at && new Date(user.expires_at) < new Date()) return null
  touchLastConnected(username)
  return user
}

function getActiveCons(username) {
  // Count active stream sessions belonging to this user
  // Sessions are keyed by channelId; we track user via session metadata
  try {
    const { getActiveSessions } = globalThis.__streamer || {}
    if (!getActiveSessions) return 0
    return getActiveSessions().filter(s => s.username === username).length
  } catch { return 0 }
}

function buildUserInfo(user, base) {
  const expTs = user.expires_at ? Math.floor(new Date(user.expires_at).getTime() / 1000) : null
  return {
    user_info: {
      username:        user.username,
      password:        user.password,
      message:         'M3u4Proxy',
      auth:            1,
      status:          'Active',
      exp_date:        expTs ? String(expTs) : null,
      is_trial:        '0',
      active_cons:     String(getActiveCons(user.username)),
      created_at:      String(Math.floor(new Date(user.created_at).getTime() / 1000)),
      max_connections: String(user.max_connections),
      allowed_output_formats: ['m3u8', 'ts'],
    },
    server_info: {
      url:             new URL(base).hostname,
      port:            new URL(base).port || '80',
      https_port:      new URL(base).port || '443',
      server_protocol: new URL(base).protocol.replace(':', ''),
      rtmp_port:       '1935',
      timezone:        'UTC',
      timestamp_now:   Math.floor(Date.now() / 1000),
      time_now:        new Date().toISOString().slice(0, 19).replace('T', ' '),
      xui:             true,
    },
  }
}

// ── Legacy per-playlist creds (Settings page display only) ───────────────────
function getCreds(playlistId) {
  return {
    username: getSetting(`xtream_${playlistId}_user`, 'user'),
    password: getSetting(`xtream_${playlistId}_pass`, 'pass'),
  }
}

// ── Category / stream builders ────────────────────────────────────────────────
function buildCategories(channels) {
  const seen = new Map()
  let idx = 1
  for (const ch of channels) {
    const g = ch.group_title || 'Uncategorized'
    if (!seen.has(g)) seen.set(g, idx++)
  }
  return [...seen.entries()].map(([name, id]) => ({
    category_id:   String(id),
    category_name: name,
    parent_id:     0,
  }))
}

function getVodChannels(playlistId) {
  return db.prepare(
    'SELECT * FROM playlist_channels WHERE playlist_id = ? ORDER BY group_title, tvg_name'
  ).all(playlistId)
}

function getMovieChannels(playlistIds) {
  if (!Array.isArray(playlistIds) || playlistIds.length === 0) return []
  const placeholders = playlistIds.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM playlist_channels WHERE playlist_id IN (${placeholders}) AND content_type = 'movie' ORDER BY group_title, tvg_name`
  ).all(...playlistIds)
}

function getSeriesChannels(playlistIds) {
  if (!Array.isArray(playlistIds) || playlistIds.length === 0) return []
  const placeholders = playlistIds.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM playlist_channels WHERE playlist_id IN (${placeholders}) AND content_type = 'series' ORDER BY group_title, tvg_name`
  ).all(...playlistIds)
}

function buildVodCategories(channels) {
  const seen = new Map()
  let idx = 1
  for (const ch of channels) {
    const g = ch.group_title || 'Uncategorized'
    // Remove 'Movie:' prefix for display
    const displayName = g.startsWith('Movie:') ? g.substring(6).trim() : g
    if (!seen.has(displayName)) seen.set(displayName, idx++)
  }
  return [...seen.entries()].map(([name, id]) => ({
    category_id:   String(id),
    category_name: name,
    parent_id:     0,
  }))
}

function buildSeriesCategories(channels) {
  const seen = new Map()
  let idx = 1
  for (const ch of channels) {
    const g = ch.group_title || 'Uncategorized'
    // Remove 'Series:' prefix for display
    const displayName = g.startsWith('Series:') ? g.substring(7).trim() : g
    if (!seen.has(displayName)) seen.set(displayName, idx++)
  }
  return [...seen.entries()].map(([name, id]) => ({
    category_id:   String(id),
    category_name: name,
    parent_id:     0,
  }))
}

function buildSeriesList(channels) {
  // Group episodes by series name
  // Series name comes from metadata (stored when fetching from upstream)
  const seriesMap = new Map()

  for (const ch of channels) {
    if (!ch.tvg_name) continue

    // Try to get series name from metadata first, fallback to parsing tvg_name
    let seriesName
    if (ch.meta && (ch.meta.name || ch.meta.title)) {
      seriesName = ch.meta.name || ch.meta.title
    } else {
      // Fallback: Extract series name from tvg_name (everything before SxxExx)
      const match = ch.tvg_name.match(/^(.+?)\s+S\d+E\d+/i)
      if (!match) continue
      seriesName = match[1].trim()
    }

    if (!seriesMap.has(seriesName)) {
      seriesMap.set(seriesName, {
        episodes: [],
        cover: ch.tvg_logo || '',
        category: ch.group_title || 'Uncategorized',
        meta: ch.meta || null
      })
    }
    seriesMap.get(seriesName).episodes.push(ch)
  }

  // Build series list
  const series = []
  let idx = 1
  for (const [name, data] of seriesMap) {
    // Remove 'Series:' prefix from category for display
    const displayCategory = data.category.startsWith('Series:') ? data.category.substring(7).trim() : data.category

    // Parse metadata if available
    const meta = data.meta ? (typeof data.meta === 'string' ? JSON.parse(data.meta) : data.meta) : {}

    const rating = meta.rating ? parseFloat(meta.rating) : 0
    const rating5 = meta.rating_5based !== undefined ? meta.rating_5based : (rating ? rating / 2 : 0)

    series.push({
      num: idx,
      series_id: String(idx),
      name: name,
      cover: meta.cover || data.cover || '',
      plot: meta.plot || '',
      cast: meta.cast || '',
      director: meta.director || '',
      genre: meta.genre || displayCategory,
      releaseDate: meta.releaseDate || meta.year || '',
      last_modified: meta.last_modified || '',
      rating: String(rating),
      rating_5based: rating5,
      backdrop_path: meta.backdrop_path || (meta.cover ? [meta.cover] : []),
      youtube_trailer: meta.youtube_trailer || meta.trailer || '',
      episode_run_time: meta.episode_run_time !== undefined ? meta.episode_run_time : 0,
      category_id: String(meta.category_id || '1'),
      tmdb_id: meta.tmdb_id || ''
    })
    idx++
  }

  return series
}

async function buildSeriesInfo(seriesId, channels, base, username, password) {
  try {
    // Find all episodes for this series
    // seriesId is the index in the series list (1-based)
    const seriesList = buildSeriesList(channels)
    console.log(`[xtream] buildSeriesInfo: seriesId=${seriesId}, total series=${seriesList.length}`)

    if (seriesId < 1 || seriesId > seriesList.length) {
      console.log(`[xtream] buildSeriesInfo: seriesId out of range`)
      return { info: {}, episodes: {}, seasons: [] }
    }

    const series = seriesList[seriesId - 1]
    const seriesName = series.name
    console.log(`[xtream] buildSeriesInfo: Looking for series "${seriesName}"`)

    // Build streaming base URL using plain password from request
    const streamBase = username && password
      ? `${base}/series/${encodeURIComponent(username)}/${encodeURIComponent(password).replace(/%24/g, '$')}`
      : null

    // Import NFO parser to read enriched metadata from Jellyfin
    const { findNfoForChannel } = await import('./nfo-parser.js')

  // Get all episodes for this series
  const episodes = channels.filter(ch => {
    if (!ch.tvg_name) return false

    // Try to match by metadata first
    if (ch.meta && (ch.meta.name || ch.meta.title)) {
      const metaName = ch.meta.name || ch.meta.title
      return metaName === seriesName
    }

    // Fallback: parse from tvg_name
    const match = ch.tvg_name.match(/^(.+?)\s+S\d+E\d+/i)
    return match && match[1].trim() === seriesName
  })

  console.log(`[xtream] buildSeriesInfo: Sample episode names:`, episodes.slice(0, 3).map(e => e.tvg_name))

  // Group episodes by season
  const seasonMap = new Map()
  for (const ep of episodes) {
    if (!ep.tvg_name) continue
    const match = ep.tvg_name.match(/S(\d+)E(\d+)/i)
    if (!match) continue

    const seasonNum = parseInt(match[1], 10)
    const episodeNum = parseInt(match[2], 10)

    if (!seasonMap.has(seasonNum)) {
      seasonMap.set(seasonNum, [])
    }

    // Try to get enriched metadata from NFO file in Jellyfin's vod-strm directory
    const nfoData = findNfoForChannel(ep.id)
    const poster = nfoData?.poster || ep.tvg_logo || ''
    const runtime = nfoData?.runtime ? parseInt(nfoData.runtime) : 0

    const directSource = streamBase ? `${streamBase}/${ep.id}.mkv` : ep.url || ''

    const addedTimestamp = Math.floor(Date.now() / 1000).toString()

    seasonMap.get(seasonNum).push({
      id: String(ep.id),
      episode_num: episodeNum,
      title: nfoData?.title || ep.tvg_name,
      container_extension: 'mkv',
      info: {
        movie_image: poster,
        cover: poster,
        plot: nfoData?.plot || '',
        duration: runtime ? `${Math.floor(runtime / 60)}:${String(runtime % 60).padStart(2, '0')}` : '',
        duration_secs: runtime * 60,
        video: {},
        audio: {},
        bitrate: 0,
        rating: nfoData?.rating ? String(nfoData.rating) : '',
        releasedate: nfoData?.releaseDate || ''
      },
      custom_sid: streamBase ? `${streamBase}/${ep.id}.mkv` : '',
      added: addedTimestamp,
      season: seasonNum,
      direct_source: directSource
    })
  }

  // Build seasons array
  const seasons = []
  for (const [seasonNum, eps] of seasonMap) {
    seasons.push({
      air_date: '',
      episode_count: eps.length,
      id: seasonNum,
      name: `Season ${seasonNum}`,
      overview: '',
      season_number: seasonNum,
      cover: series.cover,
      cover_big: series.cover
    })
  }

  // Build episodes object (keyed by season number as string)
  const episodesObj = {}
  for (const [seasonNum, eps] of seasonMap) {
    episodesObj[String(seasonNum)] = eps.sort((a, b) => a.episode_num - b.episode_num)
  }

    console.log(`[xtream] buildSeriesInfo: Found ${episodes.length} episodes, ${seasonMap.size} seasons`)

    const response = {
      info: series,
      episodes: episodesObj,
      seasons: seasons.sort((a, b) => parseInt(a.season) - parseInt(b.season))
    }

    console.log(`[xtream] buildSeriesInfo: Response structure:`)
    console.log(`[xtream]   - info:`, JSON.stringify(response.info).substring(0, 200))
    console.log(`[xtream]   - seasons count:`, response.seasons.length)
    console.log(`[xtream]   - episodes keys:`, Object.keys(response.episodes))
    console.log(`[xtream]   - episodes per season:`, Object.entries(response.episodes).map(([s, eps]) => `S${s}:${eps.length}`).join(', '))
    console.log(`[xtream]   - Full response:`, JSON.stringify(response, null, 2))

    return response
  } catch (error) {
    console.error(`[xtream] buildSeriesInfo ERROR:`, error.message)
    console.error(`[xtream] Stack:`, error.stack)
    return { info: {}, episodes: {}, seasons: [] }
  }
}

function buildVodStreams(channels, base, user) {
  const cats   = buildVodCategories(channels)
  const catMap = new Map(cats.map(c => [c.category_name, c.category_id]))
  const streamBase = user
    ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
    : null

  return channels.map((ch, idx) => {
    const g = ch.group_title || 'Uncategorized'
    const displayName = g.startsWith('Movie:') ? g.substring(6).trim() : g
    const categoryId = catMap.get(displayName) || '1'

    return {
      num:              idx + 1,
      name:             ch.tvg_name,
      stream_type:      'movie',
      stream_id:        ch.id,
      stream_icon:      ch.tvg_logo ? `${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}` : '',
      added:            '0',
      is_adult:         '0',
      category_id:      categoryId,
      category_ids:     [categoryId],
      container_extension: 'ts',
      direct_source:    streamBase ? `${streamBase}/${ch.id}` : ch.url,
      custom_sid:       streamBase ? `${streamBase}/${ch.id}` : '',
    }
  })
}

function buildStreams(channels, base, epgMap, user) {
  const groupIds = buildCategories(channels)
  const catMap   = new Map(groupIds.map(c => [c.category_name, c.category_id]))
  const streamBase = user
    ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
    : null

  return channels.map((ch, idx) => {
    const tvgId = epgMap.get(ch.tvg_id) || ch.custom_tvg_id || ch.tvg_id || ''
    return {
      num:           ch.sort_order > 0 ? ch.sort_order : idx + 1,
      name:          ch.tvg_name,
      stream_type:   'live',
      stream_id:     ch.id,
      stream_icon:   ch.tvg_logo ? `${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}` : '',
      epg_channel_id: tvgId,
      added:         '0',
      is_adult:      '0',
      category_id:   catMap.get(ch.group_title || 'Uncategorized') || '1',
      category_ids:  [catMap.get(ch.group_title || 'Uncategorized') || '1'],
      custom_sid:    streamBase ? `${streamBase}/${ch.id}` : '',
      tv_archive:    0,
      direct_source: streamBase ? `${streamBase}/${ch.id}` : '',
      tv_archive_duration: 0,
    }
  })
}

// ── M3U builder for a user ────────────────────────────────────────────────────
function buildM3UForUser(user, base) {
  if (!user.playlist_id) return '#EXTM3U\n'
  const channels = getChannels(user.playlist_id)
  const epgMap   = getEpgMap()
  const epgUrl   = existsSync(GUIDE_XML) ? `${base}/guide.xml` : ''
  const lines    = [`#EXTM3U url-tvg="${epgUrl}"`]
  channels.forEach((ch, idx) => {
    const tvgId = epgMap.get(ch.tvg_id) || ch.custom_tvg_id || ch.tvg_id || ''
    const chno  = ch.sort_order > 0 ? ch.sort_order : idx + 1
    const logo  = ch.tvg_logo ? ` tvg-logo="${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}"` : ''
    const group = ch.group_title ? ` group-title="${ch.group_title}"` : ''
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${ch.tvg_name}" tvg-chno="${chno}"${logo}${group},${ch.tvg_name}`)
    lines.push(`${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}/${ch.id}`)
  })
  return lines.join('\n')
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerXtreamRoutes(app) {

  // ── User-based player_api.php ─────────────────────────────────────────────
  const handlePlayerApi = async (req, res) => {
    const base     = getBaseUrl(req)
    const u        = req.query.username || req.body?.username || ''
    const p        = req.query.password || req.body?.password || ''
    const action   = req.query.action   || req.body?.action

    console.log(`[xtream] ${req.method} ${req.path} u="${u}" p="${p}" action="${action}" query=${JSON.stringify(req.query)}`)

    const user = await lookupUser(u, p)
    if (!user) {
      console.log(`[xtream] AUTH FAILED — no user found for u="${u}" p="${p}"`)
      return res.json({ user_info: { auth: 0 } })
    }

    if (!action) return res.json(buildUserInfo(user, base))

    const epgMap     = getEpgMap()

    // Get channels from all assigned live playlists
    let liveChans = []
    try {
      const playlistIds = JSON.parse(user.playlist_ids || '[]')
      if (playlistIds.length > 0) {
        for (const id of playlistIds) {
          liveChans.push(...getChannels(id))
        }
      } else if (user.playlist_id) {
        // Fallback to old single playlist
        liveChans = getChannels(user.playlist_id)
      }
    } catch {
      if (user.playlist_id) {
        liveChans = getChannels(user.playlist_id)
      }
    }

    // Get VOD playlist IDs
    let vodPlaylistIds = []
    try {
      vodPlaylistIds = JSON.parse(user.vod_playlist_ids || '[]')
      if (vodPlaylistIds.length === 0 && user.vod_playlist_id) {
        vodPlaylistIds = [user.vod_playlist_id]
      }
    } catch {
      if (user.vod_playlist_id) {
        vodPlaylistIds = [user.vod_playlist_id]
      }
    }

    // Get movie and series channels separately
    const movieChans = getMovieChannels(vodPlaylistIds)
    const seriesChans = getSeriesChannels(vodPlaylistIds)

    switch (action) {
      case 'get_live_categories':
        return res.json(buildCategories(liveChans))

      case 'get_live_streams': {
        let streams = buildStreams(liveChans, base, epgMap, user)
        const catId = req.query.category_id || req.body?.category_id
        if (catId) streams = streams.filter(s => s.category_id === String(catId))
        return res.json(streams)
      }

      case 'get_vod_categories': {
        console.log(`[xtream] DEBUG: movieChans count: ${movieChans.length}`)
        console.log(`[xtream] DEBUG: Sample movie group_titles:`, movieChans.slice(0, 10).map(c => c.group_title))

        // Count channels per group_title
        const groupCounts = {}
        for (const ch of movieChans) {
          const g = ch.group_title || 'Uncategorized'
          groupCounts[g] = (groupCounts[g] || 0) + 1
        }
        console.log(`[xtream] DEBUG: Group counts:`, Object.entries(groupCounts).slice(0, 10))

        const categories = buildVodCategories(movieChans)
        console.log(`[xtream] VOD categories: ${categories.length} categories from ${movieChans.length} movie channels`)
        console.log(`[xtream] Sample categories:`, categories.slice(0, 5).map(c => c.category_name))
        return res.json(categories)
      }

      case 'get_vod_streams': {
        // Import NFO parser to test metadata enrichment
        const { findNfoForChannel } = await import('./nfo-parser.js')

        // Debug: Test NFO metadata for first 5 movies
        console.log(`[xtream] Testing NFO metadata for ${Math.min(5, movieChans.length)} movies:`)
        for (let i = 0; i < Math.min(5, movieChans.length); i++) {
          const ch = movieChans[i]
          const nfoData = findNfoForChannel(ch.id)
          console.log(`[xtream] Movie: "${ch.tvg_name}" (ID: ${ch.id})`)
          console.log(`[xtream]   NFO found: ${nfoData ? 'YES' : 'NO'}`)
          if (nfoData) {
            console.log(`[xtream]   NFO data:`, {
              title: nfoData.title,
              plot: nfoData.plot?.substring(0, 100) + '...',
              rating: nfoData.rating,
              genre: nfoData.genre,
              year: nfoData.year,
              runtime: nfoData.runtime,
              director: nfoData.director,
              actor: nfoData.actor,
              poster: nfoData.poster,
              tmdb_id: nfoData.tmdb_id
            })
          }
        }

        let streams = buildVodStreams(movieChans, base, user)
        const catId = req.query.category_id || req.body?.category_id
        if (catId) streams = streams.filter(s => s.category_id === String(catId))
        return res.json(streams)
      }

      case 'get_vod_info': {
        const vodId = req.query.vod_id || req.body?.vod_id
        const ch = vodId ? movieChans.find(c => String(c.id) === String(vodId)) : null
        if (!ch) return res.json({ info: {}, movie_data: {} })
        const streamBase = user
          ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
          : null

        // Try to get enriched metadata from NFO file
        const { findNfoForChannel } = await import('./nfo-parser.js')
        const nfoData = findNfoForChannel(ch.id)

        const rating5 = nfoData?.rating ? (parseFloat(nfoData.rating) / 2).toFixed(1) : ''
        const poster = nfoData?.poster ? `${base}/api/proxy-image?url=${encodeURIComponent(nfoData.poster)}` : ch.tvg_logo || ''

        return res.json({
          info: {
            tmdb_id:       nfoData?.tmdb_id || '',
            name:          nfoData?.title || ch.tvg_name,
            o_name:        nfoData?.original_title || ch.tvg_name,
            cover_big:     poster,
            movie_image:   poster,
            releasedate:   nfoData?.release_date || '',
            episode_run_time: nfoData?.runtime ? String(nfoData.runtime) : '',
            youtube_trailer: '',
            genre:         nfoData?.genre || ch.group_title || '',
            plot:          nfoData?.plot || '',
            cast:          nfoData?.actor || '',
            director:      nfoData?.director || '',
            rating:        nfoData?.rating ? String(nfoData.rating) : '',
            rating_5based: rating5,
          },
          movie_data: {
            stream_id:           ch.id,
            name:                nfoData?.title || ch.tvg_name,
            added:               '0',
            category_id:         '1',
            container_extension: 'ts',
            custom_sid:          streamBase ? `${streamBase}/${ch.id}` : '',
            direct_source:       streamBase ? `${streamBase}/${ch.id}` : ch.url,
          },
        })
      }

      case 'get_series_categories':
        return res.json(buildSeriesCategories(seriesChans))

      case 'get_series': {
        let series = buildSeriesList(seriesChans)
        const catId = req.query.category_id || req.body?.category_id
        if (catId) {
          // Filter series by category - need to check if any episode in series matches category
          series = series.filter(s => s.category_id === String(catId))
        }
        return res.json(series)
      }

      case 'get_series_info': {
        const seriesId = req.query.series_id || req.body?.series_id
        const seasonFilter = req.query.season || req.body?.season
        if (!seriesId) return res.json({ info: {}, episodes: {}, seasons: [] })

        console.log(`[xtream] get_series_info: series_id=${seriesId}, season=${seasonFilter || 'all'}`)

        const seriesInfo = await buildSeriesInfo(parseInt(seriesId, 10), seriesChans, base, u, p)

        // If season filter is specified, only return episodes for that season
        if (seasonFilter && seriesInfo.episodes[seasonFilter]) {
          const filteredEpisodes = {}
          filteredEpisodes[seasonFilter] = seriesInfo.episodes[seasonFilter]
          seriesInfo.episodes = filteredEpisodes
          console.log(`[xtream] Filtered to season ${seasonFilter}: ${seriesInfo.episodes[seasonFilter].length} episodes`)
        }

        return res.json(seriesInfo)
      }

      case 'get_short_epg':
      case 'get_simple_data_table':
        return res.json({ epg_listings: [] })

      case 'get_epg': {
        // GSE Smart IPTV uses this to get VOD info
        const streamId = req.query.stream_id || req.body?.stream_id

        // Search in live, movies, and series
        let ch = streamId ? liveChans.find(c => String(c.id) === String(streamId)) : null
        let streamType = 'live'

        if (!ch) {
          ch = streamId ? movieChans.find(c => String(c.id) === String(streamId)) : null
          streamType = 'movie'
        }
        if (!ch) {
          ch = streamId ? seriesChans.find(c => String(c.id) === String(streamId)) : null
          streamType = 'series'
        }
        if (!ch) {
          console.log(`[xtream] get_epg: channel ${streamId} not found`)
          return res.json([])
        }

        const streamBase = user
          ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
          : null

        // Get enrichment data based on stream type
        let nfoData = null
        let epgData = null

        if (streamType === 'live') {
          // For live TV, get EPG data from XMLTV guide
          epgData = getEpgFromXmltv(ch.tvg_id, epgMap)
        } else {
          // For movies and series, get NFO metadata
          const { findNfoForChannel } = await import('./nfo-parser.js')
          nfoData = findNfoForChannel(ch.id)
        }

        // Determine category
        const g = ch.group_title || 'Uncategorized'
        const displayName = g.startsWith('Movie:') ? g.substring(6).trim() :
                           g.startsWith('Series:') ? g.substring(7).trim() : g
        const cats = streamType === 'movie' ? buildVodCategories(movieChans) :
                     streamType === 'series' ? buildSeriesCategories(seriesChans) :
                     buildCategories(liveChans)
        const catMap = new Map(cats.map(c => [c.category_name, c.category_id]))
        const categoryId = catMap.get(displayName) || '1'

        const response = [{
          num: 1,
          name: epgData?.title || nfoData?.title || ch.tvg_name,
          stream_type: streamType,
          stream_id: ch.id,
          stream_icon: ch.tvg_logo ? `${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}` : '',
          epg_channel_id: ch.tvg_id || '',
          added: '0',
          custom_sid: streamBase ? `${streamBase}/${ch.id}` : '',
          tv_archive: 0,
          direct_source: streamBase ? `${streamBase}/${ch.id}` : ch.url,
          tv_archive_duration: 0,
          category_id: categoryId,
          category_ids: [categoryId],
          thumbnail: nfoData?.poster ? `${base}/api/proxy-image?url=${encodeURIComponent(nfoData.poster)}` : '',
          // EPG enrichment for live TV
          ...(epgData && {
            description: epgData.description || '',
            start: epgData.start || '',
            stop: epgData.stop || '',
            now_playing: epgData.title || ''
          }),
          // NFO enrichment for movies/series
          ...(nfoData && {
            description: nfoData.plot || '',
            rating: nfoData.rating || '',
            year: nfoData.year || '',
            genre: Array.isArray(nfoData.genre) ? nfoData.genre.join(', ') : nfoData.genre || '',
            director: Array.isArray(nfoData.director) ? nfoData.director.join(', ') : nfoData.director || '',
            cast: Array.isArray(nfoData.actor) ? nfoData.actor.join(', ') : nfoData.actor || '',
            tmdb_id: nfoData.tmdbId || '',
            imdb_id: nfoData.imdbId || '',
            backdrop: nfoData.fanart ? `${base}/api/proxy-image?url=${encodeURIComponent(nfoData.fanart)}` : ''
          })
        }]

        console.log(`[xtream] get_epg response for ${streamId}:`, JSON.stringify(response, null, 2))
        return res.json(response)
      }

      default:
        return res.json([])
    }
  }

  app.get('/xtream/player_api.php',  handlePlayerApi)
  app.post('/xtream/player_api.php', handlePlayerApi)
  // Root-level aliases — different apps use different paths
  app.get('/player_api.php',   handlePlayerApi)
  app.post('/player_api.php',  handlePlayerApi)
  app.get('/panel_api.php',    handlePlayerApi)
  app.post('/panel_api.php',   handlePlayerApi)
  app.get('/xtream/panel_api.php',  handlePlayerApi)
  app.post('/xtream/panel_api.php', handlePlayerApi)

  // ── User-based get.php — M3U output ──────────────────────────────────────
  app.get('/xtream/get.php', async (req, res) => {
    const u    = req.query.username || ''
    const p    = req.query.password || ''
    const user = await lookupUser(u, p)
    if (!user) return res.status(401).send('Unauthorized')

    const base = getBaseUrl(req)
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="playlist.m3u"`)
    res.send(buildM3UForUser(user, base))
  })

  app.get('/get.php', async (req, res) => {
    const u = req.query.username || ''; const p = req.query.password || ''
    const user = await lookupUser(u, p)
    if (!user) return res.status(401).send('Unauthorized')
    const base = getBaseUrl(req)
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
    res.send(buildM3UForUser(user, base))
  })

  // ── User-based xmltv.php ──────────────────────────────────────────────────
  app.get('/xtream/xmltv.php', async (req, res) => {
    const u    = req.query.username || ''
    const p    = req.query.password || ''
    const user = await lookupUser(u, p)
    if (!user) return res.status(401).send('Unauthorized')
    if (!existsSync(GUIDE_XML)) return res.status(404).send('No EPG data yet')
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.sendFile(resolve(GUIDE_XML))
  })

  app.get('/xmltv.php', async (req, res) => {
    const u = req.query.username || ''; const p = req.query.password || ''
    const user = await lookupUser(u, p)
    if (!user) return res.status(401).send('Unauthorized')
    if (!existsSync(GUIDE_XML)) return res.status(404).send('No EPG data yet')
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.sendFile(resolve(GUIDE_XML))
  })

  // ── API: server info for Settings page ───────────────────────────────────
  app.get('/api/xtream/server', (req, res) => {
    const base = getBaseUrl(req)

    // Detect host LAN IP — check env var first (set in docker-compose), then host.docker.internal
    const port = new URL(base).port || '3005'
    const hostIp = process.env.HOST_IP || null
    const lanBase = hostIp ? `http://${hostIp}:${port}` : null

    res.json({
      player_api: `${base}/xtream/player_api.php`,
      get_php:    `${base}/xtream/get.php`,
      xmltv:      `${base}/xtream/xmltv.php`,
      stream_url: `${base}/xtream/{username}/{password}/{stream_id}`,
      lan_base:   lanBase,
      lan_player_api: lanBase ? `${lanBase}/xtream/player_api.php` : null,
    })
  })

  // ── Legacy per-playlist credentials (Settings page) ──────────────────────
  app.get('/api/xtream/:pid/credentials', (req, res) => {
    const playlist = getPlaylist(req.params.pid)
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
    res.json({
      ...getCreds(req.params.pid),
      base_url: `${getBaseUrl(req)}/xtream/${req.params.pid}`,
    })
  })

  app.put('/api/xtream/:pid/credentials', (req, res) => {
    const { username, password } = req.body
    if (!username || !password) return res.status(400).json({ error: 'username and password required' })
    setSetting(`xtream_${req.params.pid}_user`, username)
    setSetting(`xtream_${req.params.pid}_pass`, password)
    res.json({ ok: true })
  })

  // ── API: list all Xtream devices (legacy, for Settings display) ───────────
  app.get('/api/xtream/devices', (req, res) => {
    const base      = getBaseUrl(req)
    const playlists = db.prepare('SELECT id, name FROM playlists ORDER BY id').all()
    res.json(playlists.map(p => {
      const creds = getCreds(p.id)
      return {
        playlist_id:   p.id,
        playlist_name: p.name,
        username:      creds.username,
        password:      creds.password,
        player_api:    `${base}/xtream/player_api.php`,
        get_php:       `${base}/xtream/get.php`,
        xmltv:         `${base}/xtream/xmltv.php`,
      }
    }))
  })

  // ── VOD Stream URL: /movie/:user/:pass/:channelId.ts ─────────────────────
  app.get('/movie/:user/:pass/:channelId', async (req, res) => {
    const { user: u, pass: p, channelId: rawId } = req.params
    const channelId = rawId.replace(/\.ts$/, '')

    console.log(`[xtream] VOD stream request: /movie/${u}/${p}/${rawId} (id: ${channelId})`)

    const user = await lookupUser(decodeURIComponent(u), decodeURIComponent(p))
    if (!user) return res.status(401).send('Unauthorized')

    const active = getActiveCons(user.username)
    if (user.max_connections > 0 && active >= user.max_connections) {
      return res.status(429).send(`Stream limit reached (${user.max_connections} max)`)
    }

    const row = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
    if (!row) return res.status(404).send('Channel not found')

    if (user.vod_playlist_id && Number(row.playlist_id) !== Number(user.vod_playlist_id)) {
      return res.status(403).send('Forbidden')
    }

    console.log(`[xtream] Streaming VOD ${channelId}: ${row.tvg_name}`)

    const { connectVodClient } = await import('./vod-streamer.js')
    await connectVodClient(
      channelId,
      row.url,
      row.tvg_name,
      req,
      res,
      user.username,
    )
  })

  // ── Series Stream URL: /series/:user/:pass/:channelId.mkv ─────────────────
  app.get('/series/:user/:pass/:channelId', async (req, res) => {
    const { user: u, pass: p, channelId: rawId } = req.params
    const channelId = rawId.replace(/\.mkv$/, '')

    console.log(`[xtream] Series stream request: /series/${u}/${p}/${rawId} (id: ${channelId})`)

    const user = await lookupUser(decodeURIComponent(u), decodeURIComponent(p))
    if (!user) return res.status(401).send('Unauthorized')

    const active = getActiveCons(user.username)
    if (user.max_connections > 0 && active >= user.max_connections) {
      return res.status(429).send(`Stream limit reached (${user.max_connections} max)`)
    }

    const row = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
    if (!row) return res.status(404).send('Channel not found')

    if (user.vod_playlist_id && Number(row.playlist_id) !== Number(user.vod_playlist_id)) {
      return res.status(403).send('Forbidden')
    }

    console.log(`[xtream] Streaming Series ${channelId}: ${row.tvg_name}`)

    const { connectVodClient } = await import('./vod-streamer.js')
    await connectVodClient(
      channelId,
      row.url,
      row.tvg_name,
      req,
      res,
      user.username,
    )
  })

  // ── Stream URL: /xtream/:user/:pass/:channelId ────────────────────────────
  app.get('/xtream/:user/:pass/:channelId', async (req, res) => {
    const { user: u, pass: p, channelId } = req.params
    const user = await lookupUser(decodeURIComponent(u), decodeURIComponent(p))
    if (!user) return res.status(401).send('Unauthorized')

    const active = getActiveCons(user.username)
    if (user.max_connections > 0 && active >= user.max_connections) {
      return res.status(429).send(`Stream limit reached (${user.max_connections} max)`)
    }

    const row = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
    if (!row) return res.status(404).send('Channel not found')

    if (user.playlist_id && Number(row.playlist_id) !== Number(user.playlist_id)) {
      return res.status(403).send('Forbidden')
    }

    const { connectClient } = await import('./streamer.js')
    await connectClient(
      channelId,
      row.url,
      row.tvg_name,
      res,
      row.source_id || null,
      user.username,
    )
  })
}
