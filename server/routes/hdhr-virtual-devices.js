import express from 'express'
import db from '../db.js'
import { startDeviceServer, restartDeviceServer, stopDeviceServer } from '../hdhr.js'

const router = express.Router()

// ── HDHomeRun virtual device management ───────────────────────────────────────
router.get('/hdhr/virtual-devices', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, p.name AS playlist_name
    FROM hdhr_devices d
    LEFT JOIN playlists p ON p.id = d.playlist_id
    ORDER BY d.port
  `).all()

  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const hostname = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0]

  res.json(rows.map(d => {
    const deviceBase = `${proto}://${hostname}:${d.port}`
    const appBase = `${proto}://${hostname}`
    const xmltvUrl = d.playlist_id ? `${appBase}:${process.env.PORT || 3005}/api/playlists/${d.playlist_id}/xmltv` : null

    return {
      ...d,
      plex_url: deviceBase,
      discover_url: `${deviceBase}/discover.json`,
      lineup_url: `${deviceBase}/lineup.json`,
      m3u_url: `${deviceBase}/lineup.m3u`,
      xmltv_url: xmltvUrl,
    }
  }))
})

router.post('/hdhr/virtual-devices', async (req, res) => {
  const { name, playlist_id, port, tuner_count, active } = req.body
  if (!port) return res.status(400).json({ error: 'port required' })

  const existing = db.prepare('SELECT id FROM hdhr_devices WHERE port = ?').get(port)
  if (existing) return res.status(409).json({ error: `Port ${port} is already in use` })

  try {
    const result = db.prepare(
      'INSERT INTO hdhr_devices (name, playlist_id, port, tuner_count, active) VALUES (?, ?, ?, ?, ?)'
    ).run(name || 'M3U Tuner', playlist_id || null, Number(port), Number(tuner_count) || 4, active === false ? 0 : 1)

    await startDeviceServer(result.lastInsertRowid)
    res.json({ ok: true, id: result.lastInsertRowid })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/hdhr/virtual-devices/:id', async (req, res) => {
  const { name, playlist_id, port, tuner_count, active } = req.body
  const existing = db.prepare('SELECT * FROM hdhr_devices WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Device not found' })

  const portConflict = db.prepare('SELECT id FROM hdhr_devices WHERE port = ? AND id != ?').get(port, req.params.id)
  if (portConflict) return res.status(409).json({ error: `Port ${port} is already in use` })

  try {
    db.prepare(
      'UPDATE hdhr_devices SET name=?, playlist_id=?, port=?, tuner_count=?, active=? WHERE id=?'
    ).run(name || 'M3U Tuner', playlist_id || null, Number(port), Number(tuner_count) || 4, active === false ? 0 : 1, req.params.id)

    await restartDeviceServer(Number(req.params.id))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.delete('/hdhr/virtual-devices/:id', async (req, res) => {
  try {
    await stopDeviceServer(Number(req.params.id))
    db.prepare('DELETE FROM hdhr_devices WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
