import express from 'express'
import db from '../db.js'
import { invalidatePlaylistXmltvCache } from '../services/xmltvCache.js'

const router = express.Router()

// Delete a single channel from a playlist
router.delete('/playlist-channels/:id', (req, res) => {
  const row = db.prepare('SELECT playlist_id FROM playlist_channels WHERE id = ?').get(req.params.id)
  const r = db.prepare('DELETE FROM playlist_channels WHERE id = ?').run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Channel not found' })
  if (row?.playlist_id) invalidatePlaylistXmltvCache(row.playlist_id)
  res.json({ ok: true })
})

// Patch custom_logo on a playlist channel
router.patch('/playlist-channels/:id/custom-logo', (req, res) => {
  const { custom_logo } = req.body
  if (custom_logo === undefined) return res.status(400).json({ error: 'custom_logo required' })
  const row = db.prepare('SELECT playlist_id FROM playlist_channels WHERE id = ?').get(req.params.id)
  db.prepare('UPDATE playlist_channels SET custom_logo = ? WHERE id = ?').run(custom_logo || null, req.params.id)
  if (row?.playlist_id) invalidatePlaylistXmltvCache(row.playlist_id)
  res.json({ ok: true })
})

// Patch custom_tvg_id on a playlist channel (used when channel has no tvg_id)
router.patch('/playlist-channels/:id/custom-tvg-id', (req, res) => {
  const { custom_tvg_id } = req.body
  if (custom_tvg_id === undefined) return res.status(400).json({ error: 'custom_tvg_id required' })
  const row = db.prepare('SELECT playlist_id FROM playlist_channels WHERE id = ?').get(req.params.id)
  const result = db.prepare('UPDATE playlist_channels SET custom_tvg_id = ? WHERE id = ?').run(custom_tvg_id || '', req.params.id)
  console.log(`[epg] Set custom_tvg_id="${custom_tvg_id}" for playlist_channel id=${req.params.id}, rows affected: ${result.changes}`)
  if (row?.playlist_id) invalidatePlaylistXmltvCache(row.playlist_id)
  res.json({ ok: true, changes: result.changes })
})

export default router
