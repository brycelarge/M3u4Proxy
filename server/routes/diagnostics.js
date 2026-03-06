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

    // Check if default route goes via tun0 (including split tunnel routes)
    let defaultViaTun = false
    let gateway = null
    try {
      const { stdout: routeStdout } = await execFileAsync('ip', ['route', 'show'])

      // Method 1: Default route via tun0
      const defaultRouteMatch = routeStdout.match(/default\s+via\s+(\S+)\s+dev\s+(\S+)/)
      if (defaultRouteMatch) {
        gateway = defaultRouteMatch[1]
        if (defaultRouteMatch[2] === 'tun0') {
          defaultViaTun = true
        }
      }

      // Method 2: Split tunnel routes (0.0.0.0/1 and 128.0.0.0/1 via tun0)
      // NordVPN and others use this instead of replacing default route
      const hasSplit0 = /0\.0\.0\.0\/1.*dev\s+tun0/.test(routeStdout)
      const hasSplit128 = /128\.0\.0\.0\/1.*dev\s+tun0/.test(routeStdout)

      if (hasSplit0 && hasSplit128) {
        defaultViaTun = true
        if (!gateway) {
          const splitGateway = routeStdout.match(/0\.0\.0\.0\/1\s+via\s+(\S+)/)
          if (splitGateway) gateway = splitGateway[1]
        }
      }
    } catch (e) {
      // No routes
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
