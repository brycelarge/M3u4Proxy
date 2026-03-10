import express from 'express'
import path from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import db from '../db.js'
import { getBufferSeconds } from '../streamer.js'

const router = express.Router()

function getSettingValue(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
}

function getDefaultFfmpegStreamOptions() {
  return '-hide_banner -loglevel error -i {input} -map 0:v:0? -map 0:a? -map 0:s? -c copy -muxdelay 0 -muxpreload 0 -f mpegts {output}'
}

function getDefaultVlcStreamOptions() {
  return '{input} --sout #std{access=file,mux=ts,dst={output}} --intf dummy --quiet'
}

function getStreamBufferMode() {
  const mode = getSettingValue('stream_buffer_mode')
  if (mode === 'ffmpeg' || mode === 'm3u4prox' || mode === 'vlc') {
    return mode
  }

  const remuxSetting = getSettingValue('remux_live_tv')
  return remuxSetting === 'true' ? 'ffmpeg' : 'm3u4prox'
}

// ── Logo proxy / cache ────────────────────────────────────────────────────────
const LOGO_CACHE_DIR = process.env.LOGO_CACHE_DIR || '/data/logos'
mkdirSync(LOGO_CACHE_DIR, { recursive: true })

router.get('/logo', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).end()

  // Reject local file paths (Jellyfin metadata paths)
  if (url.startsWith('/') || url.startsWith('file://')) {
    return res.status(400).end()
  }

  // Derive a stable filename from the URL
  const hash = createHash('md5').update(url).digest('hex')
  const ext = url.split('?')[0].match(/\.(png|jpg|jpeg|gif|webp|svg|ico)$/i)?.[1]?.toLowerCase() || 'png'
  const file = path.join(LOGO_CACHE_DIR, `${hash}.${ext}`)

  // Serve from cache if exists
  if (existsSync(file)) {
    res.setHeader('Cache-Control', 'public, max-age=604800') // 7 days
    // Normalize jpg to jpeg for proper mime type
    const mimeExt = ext === 'jpg' ? 'jpeg' : ext
    res.setHeader('Content-Type', ext === 'svg' ? 'image/svg+xml' : `image/${mimeExt}`)
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

    // Normalize jpg to jpeg for proper mime type
    const mimeExt = ext === 'jpg' ? 'jpeg' : ext
    const ct = upstream.headers.get('content-type') || `image/${mimeExt}`
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
router.get('/proxy', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing url param' })
  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    res.status(upstream.status)
    const ct = upstream.headers.get('content-type')
    if (ct) res.setHeader('content-type', ct)
    const readable = Readable.fromWeb(upstream.body)
    readable.on('error', () => { if (!res.writableEnded) res.end() })
    res.on('close', () => readable.destroy())
    readable.pipe(res)
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message })
  }
})

// ── HDHomeRun status (settings page) ─────────────────────────────────────────
router.get('/hdhr/status', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const base = `${proto}://${host}`
  const row = db.prepare("SELECT value FROM settings WHERE key = 'hdhr_device_id'").get()
  res.json({
    discoverUrl: `${base}/discover.json`,
    lineupUrl: `${base}/lineup.json`,
    deviceId: row?.value || null,
  })
})

// ── Proxy settings ────────────────────────────────────────────────────────────
router.get('/proxy-settings', (req, res) => {
  const bufferSetting = getSettingValue('proxy_buffer_seconds')
  const streamBufferMode = getStreamBufferMode()
  const remuxSetting = getSettingValue('remux_live_tv')
  const ffmpegOptions = getSettingValue('ffmpeg_stream_options') || getDefaultFfmpegStreamOptions()
  const vlcOptions = getSettingValue('vlc_stream_options') || getDefaultVlcStreamOptions()

  const bufferSeconds = bufferSetting !== null ? parseFloat(bufferSetting) : getBufferSeconds()
  const remuxLiveTv = remuxSetting !== null ? remuxSetting === 'true' : streamBufferMode === 'ffmpeg'

  res.json({ bufferSeconds, remuxLiveTv, streamBufferMode, ffmpegOptions, vlcOptions })
})

router.put('/proxy-settings', (req, res) => {
  const { bufferSeconds, remuxLiveTv, streamBufferMode, ffmpegOptions, vlcOptions } = req.body

  try {
    if (bufferSeconds !== undefined) {
      const val = parseFloat(bufferSeconds)
      if (isNaN(val) || val < 0 || val > 30) {
        return res.status(400).json({ error: 'bufferSeconds must be 0-30' })
      }
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('proxy_buffer_seconds', String(val))
    }

    if (remuxLiveTv !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('remux_live_tv', String(remuxLiveTv))
    }

    if (streamBufferMode !== undefined) {
      if (!['ffmpeg', 'm3u4prox', 'vlc'].includes(streamBufferMode)) {
        return res.status(400).json({ error: 'streamBufferMode must be ffmpeg, m3u4prox, or vlc' })
      }
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('stream_buffer_mode', streamBufferMode)
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('remux_live_tv', String(streamBufferMode === 'ffmpeg'))
    }

    if (ffmpegOptions !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ffmpeg_stream_options', String(ffmpegOptions || '').trim() || getDefaultFfmpegStreamOptions())
    }

    if (vlcOptions !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vlc_stream_options', String(vlcOptions || '').trim() || getDefaultVlcStreamOptions())
    }

    const updatedBufferSetting = getSettingValue('proxy_buffer_seconds')
    const updatedRemuxSetting = getSettingValue('remux_live_tv')
    const updatedStreamBufferMode = getStreamBufferMode()
    const updatedFfmpegOptions = getSettingValue('ffmpeg_stream_options') || getDefaultFfmpegStreamOptions()
    const updatedVlcOptions = getSettingValue('vlc_stream_options') || getDefaultVlcStreamOptions()

    res.json({
      ok: true,
      bufferSeconds: updatedBufferSetting !== null ? parseFloat(updatedBufferSetting) : getBufferSeconds(),
      remuxLiveTv: updatedRemuxSetting !== null ? updatedRemuxSetting === 'true' : updatedStreamBufferMode === 'ffmpeg',
      streamBufferMode: updatedStreamBufferMode,
      ffmpegOptions: updatedFfmpegOptions,
      vlcOptions: updatedVlcOptions
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── NFO Image proxy (supports local files and URLs) ──────────────────────────
router.get('/proxy-image', async (req, res) => {
  const imageUrl = req.query.url
  if (!imageUrl) return res.status(400).send('Missing url parameter')

  try {
    // Check if it's a local file path (from Jellyfin STRM folder)
    if (imageUrl.startsWith('/') || imageUrl.startsWith('file://')) {
      const filePath = imageUrl.replace('file://', '')

      if (!existsSync(filePath)) {
        return res.status(404).send('Image not found')
      }

      // Determine content type from extension
      const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg'
      const mimeExt = ext === 'jpg' ? 'jpeg' : ext
      const contentType = ext === 'svg' ? 'image/svg+xml' : `image/${mimeExt}`

      res.setHeader('Cache-Control', 'public, max-age=604800') // 7 days
      res.setHeader('Content-Type', contentType)

      const { createReadStream } = await import('node:fs')
      return createReadStream(filePath).pipe(res)
    }

    // It's a remote URL - fetch and proxy it
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    })

    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch image')
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=604800')

    const readable = Readable.fromWeb(response.body)
    readable.pipe(res)
  } catch (e) {
    console.error('[proxy-image] Error:', e.message)
    res.status(500).send('Failed to proxy image')
  }
})

export default router
