import express from 'express'
import db from '../db.js'

const router = express.Router()

// ── Diagnostics ───────────────────────────────────────────────────────────────
router.get('/diagnostics/ip', async (req, res) => {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    // Use ipapi.co for full geolocation data
    const { stdout } = await execFileAsync('curl', ['-s', '--max-time', '10', 'https://ipapi.co/json/'])
    const data = JSON.parse(stdout)
    res.json({
      ip: data.ip,
      country: data.country_name,
      city: data.city,
      org: data.org,
      raw: data
    })
  } catch (e) {
    // Fallback to simple IP if geolocation fails
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync('curl', ['-s', '--max-time', '5', 'https://api.ipify.org?format=json'])
      const { ip } = JSON.parse(stdout)
      res.json({ ip, country: null, city: null, org: null })
    } catch (fallbackErr) {
      res.status(500).json({ error: e.message })
    }
  }
})

router.get('/diagnostics/speedtest', async (req, res) => {
  const TEST_URL = 'https://speed.cloudflare.com/__down?bytes=25000000' // 25MB
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const start = Date.now()
    await execFileAsync('curl', ['-s', '-o', '/dev/null', TEST_URL])
    const elapsed = (Date.now() - start) / 1000
    const mbps = ((25 * 8) / elapsed).toFixed(2)
    res.json({ mbps: parseFloat(mbps), seconds: elapsed.toFixed(2) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/diagnostics/dead-channels', (req, res) => {
  const playlist_id = req.query.playlist_id || null
  const rows = playlist_id
    ? db.prepare('SELECT * FROM failed_streams WHERE playlist_id = ? ORDER BY fail_count DESC, last_failed DESC LIMIT 500').all(playlist_id)
    : db.prepare('SELECT * FROM failed_streams ORDER BY fail_count DESC, last_failed DESC LIMIT 500').all()
  const total = db.prepare('SELECT COUNT(*) as c FROM failed_streams').get().c
  res.json({ total, rows })
})

router.delete('/diagnostics/dead-channels', (req, res) => {
  const playlist_id = req.query.playlist_id || null
  if (playlist_id) {
    db.prepare('DELETE FROM failed_streams WHERE playlist_id = ?').run(playlist_id)
  } else {
    db.prepare('DELETE FROM failed_streams').run()
  }
  res.json({ ok: true })
})

router.get('/diagnostics/vpn', async (req, res) => {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    // Check if tun0 interface exists and is UP
    let vpnActive = false
    try {
      const { stdout: linkStdout } = await execFileAsync('ip', ['link', 'show', 'tun0'])
      vpnActive = linkStdout.includes('state UP') || linkStdout.includes('UP')
    } catch (e) {
      // tun0 doesn't exist
      vpnActive = false
    }

    // Check if default route goes via tun0
    let defaultViaTun = false
    let gateway = null
    try {
      const { stdout: routeStdout } = await execFileAsync('ip', ['route', 'show', 'default'])
      const match = routeStdout.match(/via\s+(\S+)/)
      gateway = match ? match[1] : null
      defaultViaTun = routeStdout.includes('tun0') || routeStdout.includes('dev tun')
    } catch (e) {
      // No default route
    }

    res.json({
      vpnActive,
      defaultViaTun,
      gateway,
      raw: { vpnActive, defaultViaTun, gateway }
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
