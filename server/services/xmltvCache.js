const playlistXmltvCache = new Map()

function getEntry(playlistId) {
  if (!playlistXmltvCache.has(playlistId)) {
    playlistXmltvCache.set(playlistId, {
      key: null,
      xml: null,
      gzip: null,
      createdAt: null,
      sourceIds: [],
    })
  }

  return playlistXmltvCache.get(playlistId)
}

export function getPlaylistXmltvCache(playlistId, key, compress = false) {
  const entry = playlistXmltvCache.get(Number(playlistId))
  if (!entry || entry.key !== key) return null
  return compress ? entry.gzip : entry.xml
}

export function setPlaylistXmltvCache(playlistId, key, xml, gzip, sourceIds = []) {
  const entry = getEntry(Number(playlistId))
  entry.key = key
  entry.xml = xml
  entry.gzip = gzip
  entry.createdAt = new Date().toISOString()
  entry.sourceIds = [...new Set(sourceIds.map(Number).filter(Number.isFinite))]
}

export function getPlaylistXmltvCacheMeta(playlistId) {
  const entry = playlistXmltvCache.get(Number(playlistId))
  if (!entry) return null
  return {
    key: entry.key,
    createdAt: entry.createdAt,
    sourceIds: [...entry.sourceIds],
  }
}

export function invalidatePlaylistXmltvCache(playlistId) {
  playlistXmltvCache.delete(Number(playlistId))
}

export function invalidateAllPlaylistXmltvCache() {
  playlistXmltvCache.clear()
}

export function invalidatePlaylistsForSource(sourceId) {
  const targetId = Number(sourceId)
  if (!Number.isFinite(targetId)) {
    invalidateAllPlaylistXmltvCache()
    return
  }

  for (const [playlistId, entry] of playlistXmltvCache.entries()) {
    if (entry.sourceIds.includes(targetId)) {
      playlistXmltvCache.delete(playlistId)
    }
  }
}
