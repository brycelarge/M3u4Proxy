/**
 * HDHomeRun network tuner simulation — one virtual device per playlist
 *
 * Per-playlist endpoints (add each as a separate tuner in Plex/Emby/Jellyfin):
 *   GET /hdhr/:playlistId/discover.json
 *   GET /hdhr/:playlistId/device.xml
 *   GET /hdhr/:playlistId/lineup_status.json
 *   GET /hdhr/:playlistId/lineup.json
 *   GET /hdhr/:playlistId/lineup.m3u
 *
 * Root endpoints (legacy / primary playlist fallback):
 *   GET /discover.json  →  first playlist or hdhr_playlist_id setting
 *   GET /lineup.json
 *   GET /lineup.m3u
 */

import { createHash } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import db from './db.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.headers.host
  return `${proto}://${host}`
}

function getPlaylistChannels(playlistId) {
  return db.prepare(
    'SELECT * FROM playlist_channels WHERE playlist_id = ? ORDER BY sort_order, id'
  ).all(playlistId)
}

// Stable 8-char device ID derived from playlist ID — same across restarts
function deviceIdForPlaylist(playlistId) {
  return createHash('md5').update(`hdhr-playlist-${playlistId}`).digest('hex').slice(0, 8).toUpperCase()
}

function getTunerCount() {
  const setting = Number(getSetting('hdhr_tuner_count', '4'))
  const sources = db.prepare('SELECT max_streams FROM sources WHERE max_streams > 0 AND category != ?').all('epg')
  if (sources.length) {
    const total = sources.reduce((s, r) => s + r.max_streams, 0)
    return Math.min(setting, total)
  }
  return setting
}

// ── Per-playlist response builders ───────────────────────────────────────────
function buildDiscover(base, playlist, tunerCount) {
  const deviceId = deviceIdForPlaylist(playlist.id)
  return {
    FriendlyName:    `M3u4Proxy — ${playlist.name}`,
    Manufacturer:    'Silicondust',
    ModelNumber:     'HDTC-2US',
    FirmwareName:    'hdhomerun4_atsc',
    FirmwareVersion: '20200101',
    DeviceID:        deviceId,
    DeviceAuth:      '',
    BaseURL:         `${base}/hdhr/${playlist.id}`,
    LineupURL:       `${base}/hdhr/${playlist.id}/lineup.json`,
    TunerCount:      tunerCount,
  }
}

function buildDeviceXml(base, playlist) {
  const deviceId = deviceIdForPlaylist(playlist.id)
  return `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${base}/hdhr/${playlist.id}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>M3u4Proxy — ${playlist.name}</friendlyName>
    <manufacturer>Silicondust</manufacturer>
    <manufacturerURL>https://github.com/brycelarge/m3u-manager</manufacturerURL>
    <modelDescription>M3u4Proxy IPTV Tuner</modelDescription>
    <modelName>HDTC-2US</modelName>
    <modelNumber>HDTC-2US</modelNumber>
    <serialNumber>${deviceId}</serialNumber>
    <UDN>uuid:${deviceId}</UDN>
    <serviceList/>
  </device>
</root>`
}

function buildLineupJson(base, playlistId) {
  const channels = getPlaylistChannels(playlistId)
  const epgRows  = db.prepare('SELECT * FROM epg_mappings').all()
  const epgMap   = new Map(epgRows.map(r => [r.source_tvg_id, r.target_tvg_id]))
  return channels.map((ch, idx) => {
    const tvgId    = ch.custom_tvg_id || ch.tvg_id || ''
    const epgId    = epgMap.get(tvgId) || tvgId
    const entry = {
      GuideNumber:  ch.sort_order > 0 ? String(ch.sort_order) : String(idx + 1),
      GuideName:    ch.tvg_name,
      URL:          `${base}/stream/${ch.id}`,
      HD:           1,
      Favorite:     0,
    }
    if (epgId) entry.EpgChannelId = epgId
    return entry
  })
}

function buildLineupM3u(base, playlistId) {
  const channels = getPlaylistChannels(playlistId)
  const epgRows  = db.prepare('SELECT * FROM epg_mappings').all()
  const epgMap   = new Map(epgRows.map(r => [r.source_tvg_id, r.target_tvg_id]))
  const lines    = [`#EXTM3U url-tvg="${base}/guide.xml"`]
  channels.forEach((ch, idx) => {
    const tvgId = epgMap.get(ch.tvg_id) || ch.custom_tvg_id || ch.tvg_id || ''
    const chno  = ch.sort_order > 0 ? ch.sort_order : idx + 1
    const logo  = ch.tvg_logo ? ` tvg-logo="${base}/api/logo?url=${encodeURIComponent(ch.tvg_logo)}"` : ''
    const group = ch.group_title ? ` group-title="${ch.group_title}"` : ''
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${ch.tvg_name}" tvg-chno="${chno}"${logo}${group},${ch.tvg_name}`)
    lines.push(`${base}/stream/${ch.id}`)
  })
  return lines.join('\n')
}

// ── Per-device port server management ────────────────────────────────────────
const deviceServers = new Map() // deviceId → http.Server

function buildDeviceApp(device) {
  const sub = express()
  const pid = device.playlist_id

  sub.get('/discover.json', (req, res) => {
    const base = `http://${req.headers.host}`
    const playlist = pid ? db.prepare('SELECT * FROM playlists WHERE id = ?').get(pid) : null
    if (!playlist) {
      return res.json({
        FriendlyName: device.name, Manufacturer: 'Silicondust',
        ModelNumber: 'HDTC-2US', FirmwareName: 'hdhomerun4_atsc',
        FirmwareVersion: '20200101', DeviceID: createHash('md5').update(`hdhr-device-${device.id}`).digest('hex').slice(0, 8).toUpperCase(),
        DeviceAuth: '', BaseURL: base, LineupURL: `${base}/lineup.json`, TunerCount: device.tuner_count,
      })
    }
    res.json({
      ...buildDiscover(base, playlist, device.tuner_count),
      FriendlyName: device.name || `M3u4Proxy — ${playlist.name}`,
    })
  })

  sub.get('/device.xml', (req, res) => {
    const base = `http://${req.headers.host}`
    const playlist = pid ? db.prepare('SELECT * FROM playlists WHERE id = ?').get(pid) : null
    if (!playlist) return res.status(404).end()
    res.setHeader('Content-Type', 'application/xml')
    res.send(buildDeviceXml(base, playlist))
  })

  sub.get('/lineup_status.json', (req, res) => {
    const channels = pid ? getPlaylistChannels(pid) : []
    res.json({ ScanInProgress: 0, ScanPossible: 0, Source: 'Cable', SourceList: ['Cable'], ChannelScanSize: channels.length })
  })

  sub.get('/lineup.json', (req, res) => {
    if (!pid) return res.json([])
    const base = `http://${req.headers.host}`
    res.json(buildLineupJson(base, pid))
  })

  sub.get('/lineup.m3u', (req, res) => {
    if (!pid) { res.setHeader('Content-Type', 'application/x-mpegurl'); return res.send('#EXTM3U\n') }
    const base = `http://${req.headers.host}`
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
    res.send(buildLineupM3u(base, pid))
  })

  sub.post('/lineup.post', (req, res) => res.json({}))
  sub.get('/lineup.post',  (req, res) => res.json({}))

  return sub
}

export function startDeviceServer(deviceId) {
  return new Promise((resolve, reject) => {
    const device = db.prepare('SELECT * FROM hdhr_devices WHERE id = ?').get(deviceId)
    if (!device || !device.active) return resolve()
    if (deviceServers.has(deviceId)) return resolve() // already running

    const subApp = buildDeviceApp(device)
    const server = http.createServer(subApp)
    server.listen(device.port, () => {
      console.log(`[hdhr] Device "${device.name}" listening on port ${device.port}`)
      deviceServers.set(deviceId, server)
      resolve()
    })
    server.on('error', (e) => {
      console.error(`[hdhr] Failed to start device ${deviceId} on port ${device.port}:`, e.message)
      reject(e)
    })
  })
}

export function stopDeviceServer(deviceId) {
  return new Promise((resolve) => {
    const server = deviceServers.get(deviceId)
    if (!server) return resolve()
    server.close(() => {
      deviceServers.delete(deviceId)
      resolve()
    })
  })
}

export async function restartDeviceServer(deviceId) {
  await stopDeviceServer(deviceId)
  await startDeviceServer(deviceId)
}

export async function startAllDeviceServers() {
  const devices = db.prepare('SELECT * FROM hdhr_devices WHERE active = 1').all()
  for (const d of devices) {
    try { await startDeviceServer(d.id) } catch {}
  }
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerHdhrRoutes(app) {

  // ── Per-playlist device routes (/hdhr/:playlistId/...) ───────────────────
  app.get('/hdhr/:pid/discover.json', (req, res) => {
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.pid)
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
    res.json(buildDiscover(getBaseUrl(req), playlist, getTunerCount()))
  })

  app.get('/hdhr/:pid/device.xml', (req, res) => {
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.pid)
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
    res.setHeader('Content-Type', 'application/xml')
    res.send(buildDeviceXml(getBaseUrl(req), playlist))
  })

  app.get('/hdhr/:pid/lineup_status.json', (req, res) => {
    const channels = getPlaylistChannels(req.params.pid)
    res.json({ ScanInProgress: 0, ScanPossible: 0, Source: 'Cable', SourceList: ['Cable'], ChannelScanSize: channels.length })
  })

  app.get('/hdhr/:pid/lineup.json', (req, res) => {
    res.json(buildLineupJson(getBaseUrl(req), req.params.pid))
  })

  app.get('/hdhr/:pid/lineup.m3u', (req, res) => {
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
    res.send(buildLineupM3u(getBaseUrl(req), req.params.pid))
  })

  app.post('/hdhr/:pid/lineup.post', (req, res) => res.json({}))
  app.get('/hdhr/:pid/lineup.post',  (req, res) => res.json({}))

  // ── Root endpoints — point to primary (first) playlist ───────────────────
  function getPrimaryPlaylistId() {
    const fromSetting = getSetting('hdhr_playlist_id')
    if (fromSetting) return fromSetting
    const first = db.prepare('SELECT id FROM playlists ORDER BY id LIMIT 1').get()
    return first?.id || null
  }

  app.get('/discover.json', (req, res) => {
    const base       = getBaseUrl(req)
    const playlistId = getPrimaryPlaylistId()
    if (!playlistId) {
      return res.json({
        FriendlyName: 'M3u4Proxy', Manufacturer: 'Silicondust',
        ModelNumber: 'HDTC-2US', FirmwareName: 'hdhomerun4_atsc',
        FirmwareVersion: '20200101', DeviceID: 'AAAAAAAA', DeviceAuth: '',
        BaseURL: base, LineupURL: `${base}/lineup.json`, TunerCount: getTunerCount(),
      })
    }
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId)
    res.json(buildDiscover(base, playlist, getTunerCount()))
  })

  app.get('/device.xml', (req, res) => {
    const playlistId = getPrimaryPlaylistId()
    if (!playlistId) return res.status(404).end()
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId)
    res.setHeader('Content-Type', 'application/xml')
    res.send(buildDeviceXml(getBaseUrl(req), playlist))
  })

  app.get('/lineup_status.json', (req, res) => {
    const playlistId = getPrimaryPlaylistId()
    const channels   = playlistId ? getPlaylistChannels(playlistId) : []
    res.json({ ScanInProgress: 0, ScanPossible: 0, Source: 'Cable', SourceList: ['Cable'], ChannelScanSize: channels.length })
  })

  app.get('/lineup.json', (req, res) => {
    const playlistId = getPrimaryPlaylistId()
    if (!playlistId) return res.json([])
    res.json(buildLineupJson(getBaseUrl(req), playlistId))
  })

  app.get('/lineup.m3u', (req, res) => {
    const playlistId = getPrimaryPlaylistId()
    if (!playlistId) { res.setHeader('Content-Type', 'application/x-mpegurl'); return res.send('#EXTM3U\n') }
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
    res.send(buildLineupM3u(getBaseUrl(req), playlistId))
  })

  app.post('/lineup.post', (req, res) => res.json({}))
  app.get('/lineup.post',  (req, res) => res.json({}))

  // ── API: list all virtual devices ────────────────────────────────────────
  app.get('/api/hdhr/devices', (req, res) => {
    const base      = getBaseUrl(req)
    const playlists = db.prepare('SELECT id, name, channel_count FROM playlists ORDER BY id').all()
    res.json(playlists.map(p => ({
      playlist_id:   p.id,
      playlist_name: p.name,
      channel_count: p.channel_count || 0,
      device_id:     deviceIdForPlaylist(p.id),
      discover_url:  `${base}/hdhr/${p.id}/discover.json`,
      lineup_url:    `${base}/hdhr/${p.id}/lineup.json`,
      m3u_url:       `${base}/hdhr/${p.id}/lineup.m3u`,
    })))
  })
}
