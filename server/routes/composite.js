import express from 'express'
import db from '../db.js'
import { getCompositeSession, stopCompositeSession, getActiveSessions as getActiveCompositeSessions, LAYOUT_PRESETS } from '../composite-streamer.js'

const router = express.Router()

// Get all composite streams
router.get('/', (req, res) => {
  const streams = db.prepare(`
    SELECT cs.*,
      (SELECT COUNT(*) FROM composite_stream_sources WHERE composite_stream_id = cs.id) as source_count
    FROM composite_streams cs
    ORDER BY cs.created_at DESC
  `).all()
  res.json(streams)
})

// Get layout presets (must be before /:id route)
router.get('/presets', (req, res) => {
  res.json(LAYOUT_PRESETS)
})

// Get active sessions status
router.get('/sessions/active', (req, res) => {
  res.json(getActiveCompositeSessions())
})

// Get single composite stream with sources
router.get('/:id', (req, res) => {
  const stream = db.prepare('SELECT * FROM composite_streams WHERE id = ?').get(req.params.id)
  if (!stream) return res.status(404).json({ error: 'Composite stream not found' })

  const sources = db.prepare(`
    SELECT css.*, pc.tvg_name, pc.tvg_logo, pc.group_title
    FROM composite_stream_sources css
    JOIN playlist_channels pc ON css.source_channel_id = pc.id
    WHERE css.composite_stream_id = ?
    ORDER BY css.role
  `).all(req.params.id)

  res.json({ ...stream, sources })
})

// Create composite stream
router.post('/', (req, res) => {
  const { name, description, layout_config, audio_config, sources } = req.body

  if (!name || !layout_config || !sources || sources.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    const insert = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO composite_streams (name, description, layout_config, audio_config)
        VALUES (?, ?, ?, ?)
      `).run(name, description || '', JSON.stringify(layout_config), JSON.stringify(audio_config || {}))

      const compositeId = result.lastInsertRowid

      const insertSource = db.prepare(`
        INSERT INTO composite_stream_sources
        (composite_stream_id, source_channel_id, role, position_x, position_y, width, height)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (const source of sources) {
        insertSource.run(
          compositeId,
          source.channelId,
          source.role,
          source.position?.x || 0,
          source.position?.y || 0,
          source.position?.w || 0,
          source.position?.h || 0
        )
      }

      return compositeId
    })

    const compositeId = insert()
    res.json({ id: compositeId, ok: true })
  } catch (error) {
    console.error('[composite] Create failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// Update composite stream
router.put('/:id', (req, res) => {
  const { name, description, layout_config, audio_config, sources, active } = req.body
  const compositeId = req.params.id

  try {
    const update = db.transaction(() => {
      db.prepare(`
        UPDATE composite_streams
        SET name = ?, description = ?, layout_config = ?, audio_config = ?, active = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        name,
        description || '',
        JSON.stringify(layout_config),
        JSON.stringify(audio_config || {}),
        active !== undefined ? (active ? 1 : 0) : 1,
        compositeId
      )

      if (sources) {
        db.prepare('DELETE FROM composite_stream_sources WHERE composite_stream_id = ?').run(compositeId)

        const insertSource = db.prepare(`
          INSERT INTO composite_stream_sources
          (composite_stream_id, source_channel_id, role, position_x, position_y, width, height)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)

        for (const source of sources) {
          insertSource.run(
            compositeId,
            source.channelId,
            source.role,
            source.position?.x || 0,
            source.position?.y || 0,
            source.position?.w || 0,
            source.position?.h || 0
          )
        }
      }
    })

    update()
    res.json({ ok: true })
  } catch (error) {
    console.error('[composite] Update failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete composite stream
router.delete('/:id', async (req, res) => {
  try {
    await stopCompositeSession(parseInt(req.params.id))
    db.prepare('DELETE FROM composite_streams WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  } catch (error) {
    console.error('[composite] Delete failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get composite stream HLS playlist URL
router.get('/:id/stream', async (req, res) => {
  try {
    const compositeId = parseInt(req.params.id)
    const session = await getCompositeSession(compositeId, db, req.username)

    const clientId = `${req.ip}-${Date.now()}`
    session.addClient(clientId)

    req.on('close', () => session.removeClient(clientId))

    const playlistUrl = `/composite-stream/${compositeId}/playlist.m3u8`
    res.json({ url: playlistUrl, status: session.getStatus() })
  } catch (error) {
    console.error('[composite] Stream start failed:', error)
    res.status(500).json({ error: error.message })
  }
})

// Stop a composite session
router.post('/:id/stop', async (req, res) => {
  try {
    await stopCompositeSession(parseInt(req.params.id))
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

export default router
