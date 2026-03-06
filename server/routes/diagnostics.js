import express from 'express'
import db from '../db.js'

const router = express.Router()

// ── Diagnostics ───────────────────────────────────────────────────────────────
router.get('/diagnostics/ip', async (req, res) => {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    // Use ip-api.com (no HTTPS issues, more reliable)
    const { stdout } = await execFileAsync('curl', ['-s', '--max-time', '10', 'http://ip-api.com/json/'])
    const data = JSON.parse(stdout)
    res.json({
      ip: data.query,
      country: data.country,
      city: data.city,
      org: data.isp,
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

// ── VPN Config Management ──────────────────────────────────────────────────

// List available VPN configs
router.get('/diagnostics/vpn-configs', async (req, res) => {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')

    const provider = process.env.OPENVPN_PROVIDER || 'NORDVPN'
    const vpnDir = process.env.VPN_DIR || '/data/config/openvpn'
    const providerDir = path.join(vpnDir, provider.toLowerCase())
    const listFile = path.join(providerDir, 'list.txt')

    // Read current config from /tmp/.openvpn-switch-config (runtime switch) or fall back to env
    let currentConfig = process.env.OPENVPN_CONFIG || ''
    const switchConfigFile = '/tmp/.openvpn-switch-config'
    if (fs.existsSync(switchConfigFile)) {
      const switchConfig = fs.readFileSync(switchConfigFile, 'utf-8').trim()
      if (switchConfig) {
        currentConfig = switchConfig.replace(path.join(vpnDir, provider.toLowerCase()) + '/', '')
      }
    }

    if (!fs.existsSync(listFile)) {
      return res.json({ configs: [], current: currentConfig, provider })
    }

    const content = fs.readFileSync(listFile, 'utf-8')
    const configs = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && line.endsWith('.ovpn'))
      .map(config => ({
        path: config,
        name: path.basename(config, '.ovpn'),
        protocol: config.includes('tcp') ? 'tcp' : 'udp'
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    res.json({
      configs,
      current: currentConfig,
      provider,
      vpnEnabled: process.env.VPN_ENABLED === 'true'
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get current VPN config
router.get('/diagnostics/vpn-config', (req, res) => {
  res.json({
    current: process.env.OPENVPN_CONFIG || '',
    provider: process.env.OPENVPN_PROVIDER || 'CUSTOM',
    vpnEnabled: process.env.VPN_ENABLED === 'true',
    protocol: process.env.OPENVPN_PROTOCOL || 'udp'
  })
})

// Switch VPN config
router.post('/diagnostics/vpn-config', async (req, res) => {
  try {
    const { config } = req.body
    if (!config) {
      return res.status(400).json({ error: 'Config path is required' })
    }

    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const fs = await import('node:fs')
    const path = await import('node:path')

    const VPN_DIR = process.env.VPN_DIR || '/data/config/openvpn'
    const provider = process.env.OPENVPN_PROVIDER || 'NORDVPN'
    const VPCONFIG_OVERRIDE_FILE="/tmp/.openvpn-switch-config"
    // Config path from list is relative to provider dir (e.g., 'ovpn_udp/za128.nordvpn.com.udp.ovpn')
    const configFullPath = path.join(VPN_DIR, provider.toLowerCase(), config)

    // Verify config file exists
    if (!fs.existsSync(configFullPath)) {
      return res.status(400).json({
        error: `Config file not found: ${configFullPath}`,
        hint: 'Make sure the config file exists'
      })
    }

    // Write the switch-config file to /tmp for runtime switching (clears on container reboot)
    const switchConfigFile = '/tmp/.openvpn-switch-config'
    fs.writeFileSync(switchConfigFile, configFullPath, 'utf-8')

    // Trigger OpenVPN restart via signal file (s6 service will handle the kill)
    const restartSignalFile = '/tmp/.openvpn-restart-signal'
    fs.writeFileSync(restartSignalFile, Date.now().toString(), 'utf-8')

    // Small delay to ensure file is flushed
    await new Promise(resolve => setTimeout(resolve, 500))

    res.json({
      success: true,
      config,
      configPath: configFullPath,
      message: `VPN config switched to ${config}`,
      note: 'OpenVPN is restarting with new config. Wait 5-10 seconds then check VPN Status and Public IP.'
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
