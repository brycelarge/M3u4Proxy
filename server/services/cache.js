// Simple LRU cache for channel queries (5min TTL)
const channelCache = new Map()
const CACHE_TTL = 5 * 60 * 1000

export function getCached(key) {
  const entry = channelCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    channelCache.delete(key)
    return null
  }
  return entry.data
}

export function setCache(key, data) {
  channelCache.set(key, { data, ts: Date.now() })
  if (channelCache.size > 100) {
    const first = channelCache.keys().next().value
    channelCache.delete(first)
  }
}

export function clearCache() {
  channelCache.clear()
}
