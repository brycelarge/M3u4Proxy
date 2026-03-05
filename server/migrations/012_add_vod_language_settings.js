export function up(db) {
  console.log('[Migration] Adding VOD language filter settings...')
  
  // Add VOD language filter settings with defaults
  const settings = [
    { key: 'vod_allowed_languages', value: '["eng"]' },
    { key: 'vod_language_filter_mode', value: 'disabled' },
    { key: 'vod_blocked_titles', value: '[]' }
  ]
  
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const { key, value } of settings) {
    insert.run(key, value)
  }
  
  console.log('[Migration] ✓ Added VOD language filter settings')
}

export function down(db) {
  console.log('[Migration] Removing VOD language filter settings...')
  
  const keys = ['vod_allowed_languages', 'vod_language_filter_mode', 'vod_blocked_titles']
  const del = db.prepare('DELETE FROM settings WHERE key = ?')
  for (const key of keys) {
    del.run(key)
  }
  
  console.log('[Migration] ✓ Removed VOD language filter settings')
}
