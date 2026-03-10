import db from './db.js'

const settingsCache = new Map()
const selectSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?')
const selectSettingsByPrefixStmt = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?')
const upsertSettingStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')

let hydrated = false

function hydrateSettingsCache() {
  if (hydrated) return
  const rows = db.prepare('SELECT key, value FROM settings').all()
  for (const row of rows) {
    settingsCache.set(row.key, row.value)
  }
  hydrated = true
}

export function getSettingValue(key, fallback = null) {
  hydrateSettingsCache()
  return settingsCache.has(key) ? settingsCache.get(key) : fallback
}

export function getSettingsByPrefix(prefix) {
  hydrateSettingsCache()
  const result = {}
  for (const [key, value] of settingsCache.entries()) {
    if (key.startsWith(prefix)) {
      result[key] = value
    }
  }
  return result
}

export function setSettingValue(key, value) {
  const normalizedValue = value === null || value === undefined ? null : String(value)
  if (normalizedValue === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    settingsCache.delete(key)
    return null
  }

  upsertSettingStmt.run(key, normalizedValue)
  settingsCache.set(key, normalizedValue)
  hydrated = true
  return normalizedValue
}

export function setSettingsValues(obj) {
  const entries = Object.entries(obj)
  if (entries.length === 0) return

  const save = db.transaction((items) => {
    for (const [key, value] of items) {
      const normalizedValue = value === null || value === undefined ? null : String(value)
      if (normalizedValue === null) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(key)
      } else {
        upsertSettingStmt.run(key, normalizedValue)
      }
    }
  })

  save(entries)

  hydrateSettingsCache()
  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      settingsCache.delete(key)
    } else {
      settingsCache.set(key, String(value))
    }
  }
}

export function refreshSettingValue(key) {
  const row = selectSettingStmt.get(key)
  if (row) {
    settingsCache.set(key, row.value)
    hydrated = true
    return row.value
  }
  settingsCache.delete(key)
  hydrated = true
  return null
}

export function refreshSettingsByPrefix(prefix) {
  hydrateSettingsCache()
  for (const key of [...settingsCache.keys()]) {
    if (key.startsWith(prefix)) {
      settingsCache.delete(key)
    }
  }

  const rows = selectSettingsByPrefixStmt.all(`${prefix}%`)
  for (const row of rows) {
    settingsCache.set(row.key, row.value)
  }

  return rows
}
