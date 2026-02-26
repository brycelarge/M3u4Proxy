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
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { GUIDE_XML } from './epgGrab.js'
import { verifyPassword } from './auth.js'

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

function buildVodCategories(channels) {
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

function buildVodStreams(channels, base, user) {
  const cats   = buildVodCategories(channels)
  const catMap = new Map(cats.map(c => [c.category_name, c.category_id]))
  const streamBase = user
    ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
    : null

  return channels.map((ch, idx) => ({
    num:              idx + 1,
    name:             ch.tvg_name,
    stream_type:      'movie',
    stream_id:        ch.id,
    stream_icon:      ch.tvg_logo ? `${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}` : '',
    added:            '0',
    is_adult:         '0',
    category_id:      catMap.get(ch.group_title || 'Uncategorized') || '1',
    category_ids:     [catMap.get(ch.group_title || 'Uncategorized') || '1'],
    container_extension: 'ts',
    direct_source:    streamBase ? `${streamBase}/${ch.id}` : ch.url,
    custom_sid:       streamBase ? `${streamBase}/${ch.id}` : '',
  }))
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

    // Get channels from all assigned VOD playlists
    let vodChans = []
    try {
      const vodPlaylistIds = JSON.parse(user.vod_playlist_ids || '[]')
      if (vodPlaylistIds.length > 0) {
        for (const id of vodPlaylistIds) {
          vodChans.push(...getVodChannels(id))
        }
      } else if (user.vod_playlist_id) {
        // Fallback to old single playlist
        vodChans = getVodChannels(user.vod_playlist_id)
      }
    } catch {
      if (user.vod_playlist_id) {
        vodChans = getVodChannels(user.vod_playlist_id)
      }
    }

    switch (action) {
      case 'get_live_categories':
        return res.json(buildCategories(liveChans))

      case 'get_live_streams': {
        let streams = buildStreams(liveChans, base, epgMap, user)
        const catId = req.query.category_id || req.body?.category_id
        if (catId) streams = streams.filter(s => s.category_id === String(catId))
        return res.json(streams)
      }

      case 'get_vod_categories':
        return res.json(buildVodCategories(vodChans))

      case 'get_vod_streams': {
        let streams = buildVodStreams(vodChans, base, user)
        const catId = req.query.category_id || req.body?.category_id
        if (catId) streams = streams.filter(s => s.category_id === String(catId))
        return res.json(streams)
      }

      case 'get_vod_info': {
        const vodId = req.query.vod_id || req.body?.vod_id
        const ch = vodId ? vodChans.find(c => String(c.id) === String(vodId)) : null
        if (!ch) return res.json({ info: {}, movie_data: {} })
        const streamBase = user
          ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
          : null

        // Try to get enriched metadata from NFO
        const { getVodMetadata } = await import('./nfo-parser.js')
        const nfoData = getVodMetadata(ch.id)

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
        return res.json(buildVodCategories(vodChans))

      case 'get_series':
        return res.json([])

      case 'get_series_info':
        return res.json({ info: {}, episodes: {}, seasons: [] })

      case 'get_short_epg':
      case 'get_simple_data_table':
        return res.json({ epg_listings: [] })

      case 'get_epg': {
        // GSE Smart IPTV uses this to get VOD info
        const streamId = req.query.stream_id || req.body?.stream_id
        const ch = streamId ? vodChans.find(c => String(c.id) === String(streamId)) : null
        if (!ch) {
          console.log(`[xtream] get_epg: channel ${streamId} not found`)
          return res.json({ epg_listings: [] })
        }

        const streamBase = user
          ? `${base}/xtream/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
          : null
        const movieBase = user
          ? `${base}/movie/${encodeURIComponent(user.username)}/${encodeURIComponent(user.password).replace(/%24/g, '$')}`
          : null

        const response = {
          epg_listings: [{
            id: ch.id,
            title: ch.tvg_name,
            description: '',
            start: '',
            end: '',
            channel_id: ch.id,
            stream_url: streamBase ? `${streamBase}/${ch.id}.ts` : ch.url,
            movie_url: movieBase ? `${movieBase}/${ch.id}.ts` : ch.url,
            stream_id: ch.id,
            category_id: '1',
            stream_icon: ch.tvg_logo ? `${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}` : ''
          }]
        }

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
