import express from 'express'
import { randomBytes } from 'node:crypto'
import db from '../db.js'
import { hashPassword } from '../auth.js'

const router = express.Router()

// Admin login
router.post('/admin/login', (req, res) => {
  const { password } = req.body
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin'
  if (password !== adminPassword) return res.status(401).json({ error: 'Invalid password' })

  // Create session
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
  db.prepare('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt)

  res.json({ token })
})

// Logout
router.post('/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token']
  if (token) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
  }
  res.json({ ok: true })
})

// Verify session
router.get('/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token']
  if (!token) return res.status(401).json({ valid: false })

  const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token)
  if (!session) return res.status(401).json({ valid: false })

  res.json({ valid: true })
})

// ── User Management ───────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.*, p.name AS playlist_name, vp.name AS vod_playlist_name
    FROM users u
    LEFT JOIN playlists p ON u.playlist_id = p.id
    LEFT JOIN playlists vp ON u.vod_playlist_id = vp.id
    ORDER BY u.username
  `).all()
  res.json(users)
})

router.post('/users', async (req, res) => {
  const { username, password, playlist_ids, vod_playlist_ids, max_connections, expires_at, active, notes } = req.body
  if (!username || !password) return res.status(400).json({ error: 'username and password required' })
  try {
    const hashed = await hashPassword(password)
    // Support multiple playlists by storing as JSON or first ID (legacy compat)
    // For now, we'll just take the first ID if array is provided
    const playlistId = Array.isArray(playlist_ids) ? playlist_ids[0] : playlist_ids
    const vodPlaylistId = Array.isArray(vod_playlist_ids) ? vod_playlist_ids[0] : vod_playlist_ids

    const result = db.prepare(
      'INSERT INTO users (username, password, playlist_id, vod_playlist_id, max_connections, expires_at, active, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(username, hashed, playlistId, vodPlaylistId, Number(max_connections) || 1, expires_at, active ? 1 : 0, notes)
    res.json({ id: result.lastInsertRowid })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/users/:id', async (req, res) => {
  const { username, password, playlist_ids, vod_playlist_ids, max_connections, expires_at, active, notes } = req.body
  if (!username) return res.status(400).json({ error: 'username required' })
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'User not found' })

  try {
    let hashed = existing.password
    if (password) hashed = await hashPassword(password)

    const playlistId = Array.isArray(playlist_ids) ? playlist_ids[0] : playlist_ids
    const vodPlaylistId = Array.isArray(vod_playlist_ids) ? vod_playlist_ids[0] : vod_playlist_ids

    db.prepare(
      'UPDATE users SET username=?, password=?, playlist_id=?, vod_playlist_id=?, max_connections=?, expires_at=?, active=?, notes=? WHERE id=?'
    ).run(username, hashed, playlistId, vodPlaylistId, Number(max_connections) || 1, expires_at, active ? 1 : 0, notes, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.delete('/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

export default router
