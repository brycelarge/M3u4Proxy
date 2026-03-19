import express from 'express'
import db from '../db.js'

const router = express.Router()

router.get('/', (req, res) => {
  const period = req.query.period || 'day'

  let rows

  if (period === 'week') {
    rows = db.prepare(`
      SELECT
        strftime('%Y-W%W', date) AS week,
        SUM(bytes_in)  AS bytes_in,
        SUM(bytes_out) AS bytes_out
      FROM stream_stats_daily
      WHERE date >= date('now', '-28 days')
      GROUP BY strftime('%Y-W%W', date)
      ORDER BY week ASC
    `).all()
  } else if (period === 'month') {
    rows = db.prepare(`
      SELECT
        strftime('%Y-%m', date) AS month,
        SUM(bytes_in)  AS bytes_in,
        SUM(bytes_out) AS bytes_out
      FROM stream_stats_daily
      WHERE date >= date('now', '-365 days')
      GROUP BY strftime('%Y-%m', date)
      ORDER BY month ASC
    `).all()
  } else {
    rows = db.prepare(`
      SELECT
        date,
        SUM(bytes_in)  AS bytes_in,
        SUM(bytes_out) AS bytes_out
      FROM stream_stats_daily
      WHERE date >= date('now', '-7 days')
      GROUP BY date
      ORDER BY date ASC
    `).all()
  }

  res.json(rows)
})

export default router
