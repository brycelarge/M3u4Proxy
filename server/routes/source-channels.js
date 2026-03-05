import express from 'express'
import db from '../db.js'

const router = express.Router()

// Get other source variants for a channel (by source_channel id)
router.get('/source-channels/:id/variants', (req, res) => {
  const sourceChannel = db.prepare('SELECT normalized_name, tvg_name FROM source_channels WHERE id = ?').get(req.params.id)
  if (!sourceChannel || !sourceChannel.normalized_name) {
    return res.json([])
  }

  const variants = db.prepare(`
    SELECT
      sc.id,
      sc.tvg_name,
      sc.quality,
      sc.url,
      sc.group_title,
      s.id as source_id,
      s.name as source_name
    FROM source_channels sc
    JOIN sources s ON sc.source_id = s.id
    WHERE sc.normalized_name = ?
    ORDER BY
      s.name,
      CASE sc.quality
        WHEN 'UHD' THEN 1
        WHEN 'FHD' THEN 2
        WHEN 'HD' THEN 3
        WHEN 'SD' THEN 4
        ELSE 5
      END
  `).all(sourceChannel.normalized_name)

  res.json(variants)
})

// Bulk fetch variants for multiple channels
router.post('/source-channels/bulk-variants', (req, res) => {
  const { channelIds } = req.body

  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.json([])
  }

  const results = []

  for (const channelId of channelIds) {
    const channel = db.prepare('SELECT * FROM source_channels WHERE id = ?').get(channelId)
    if (!channel || !channel.normalized_name) continue

    const variants = db.prepare(`
      SELECT sc.*
      FROM source_channels sc
      JOIN sources s ON sc.source_id = s.id
      WHERE sc.normalized_name = ?
        AND sc.source_id != ?
      ORDER BY
        COALESCE(s.priority, 999) ASC,
        CASE sc.quality
          WHEN 'UHD' THEN 1
          WHEN 'FHD' THEN 2
          WHEN 'HD' THEN 3
          WHEN 'SD' THEN 4
          ELSE 5
        END
    `).all(channel.normalized_name, channel.source_id)

    if (variants.length > 0) {
      results.push({
        channel: {
          id: channel.id,
          tvg_name: channel.tvg_name,
          group_title: channel.group_title,
          source_id: channel.source_id
        },
        variants
      })
    }
  }

  res.json(results)
})

export default router
