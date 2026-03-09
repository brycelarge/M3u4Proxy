import { Router } from 'express'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const dbPath = join(__dirname, '../..', 'data', 'db', 'm3u-manager.db')
const db = new Database(dbPath)

const router = Router()

// Helper to lookup user by username/password
async function lookupUser(username, password) {
  return db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password)
}

// MAG Portal API - Favorites
router.get('/portal.php', async (req, res) => {
  const { type, action, username, password } = req.query

  // Auth check
  if (!username || !password) {
    return res.json({ js: { error: 'Authentication required' } })
  }

  const user = await lookupUser(username, password)
  if (!user) {
    return res.json({ js: { error: 'Invalid credentials' } })
  }

  // Handle favorites actions
  if (type === 'itv' || type === 'vod' || type === 'series') {
    if (action === 'set_fav') {
      const favCh = req.query.fav_ch || ''
      
      // Store favorites as comma-separated string
      const stmt = db.prepare(`
        INSERT INTO user_favorites (user_id, content_type, channel_ids, updated_at)
        VALUES (?, ?, ?, strftime('%s', 'now'))
        ON CONFLICT(user_id, content_type) 
        DO UPDATE SET channel_ids = excluded.channel_ids, updated_at = excluded.updated_at
      `)
      
      stmt.run(user.id, type, favCh)
      
      return res.json({ js: { success: true } })
    }

    if (action === 'get_fav_ids') {
      const row = db.prepare(`
        SELECT channel_ids 
        FROM user_favorites 
        WHERE user_id = ? AND content_type = ?
      `).get(user.id, type)
      
      const favIds = row?.channel_ids || ''
      
      return res.json({ js: favIds })
    }
  }

  // Default response for unsupported actions
  return res.json({ js: { error: 'Unsupported action' } })
})

export default router
