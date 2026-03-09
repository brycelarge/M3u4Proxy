import express from 'express'
import path from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import db from '../db.js'
import { getBufferSeconds } from '../streamer.js'

const router = express.Router()

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
  const bufferSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxy_buffer_seconds')
  const remuxSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('remux_live_tv')

  const bufferSeconds = bufferSetting ? parseFloat(bufferSetting.value) : getBufferSeconds()
  const remuxLiveTv = remuxSetting ? remuxSetting.value === 'true' : false

  res.json({ bufferSeconds, remuxLiveTv })
})

router.put('/proxy-settings', (req, res) => {
  const { bufferSeconds, remuxLiveTv } = req.body

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

    const bufferSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxy_buffer_seconds')
    const remuxSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('remux_live_tv')

    res.json({
      ok: true,
      bufferSeconds: bufferSetting ? parseFloat(bufferSetting.value) : getBufferSeconds(),
      remuxLiveTv: remuxSetting ? remuxSetting.value === 'true' : false
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
