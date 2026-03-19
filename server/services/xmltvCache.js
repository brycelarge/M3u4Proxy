import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import path from 'node:path'

const DATA_DIR = process.env.DATA_DIR || '/data'
const XMLTV_CACHE_DIR = path.join(DATA_DIR, 'cache', 'xmltv')

// Ensure cache directory exists on module load
mkdirSync(XMLTV_CACHE_DIR, { recursive: true })

function getCachePaths(playlistId, key) {
  const base = path.join(XMLTV_CACHE_DIR, `xmltv_${playlistId}_${key}`)
  return {
    xml: `${base}.xml`,
    gz: `${base}.xml.gz`,
    meta: `${base}.meta.json`,
    xmlTmp: `${base}.xml.tmp`,
    gzTmp: `${base}.xml.gz.tmp`,
  }
}

// Returns Buffer if cached, null if not
export function getPlaylistXmltvCache(playlistId, key, compress = false) {
  const paths = getCachePaths(Number(playlistId), key)
  const filePath = compress ? paths.gz : paths.xml
  if (!existsSync(filePath)) return null
  try {
    return readFileSync(filePath)
  } catch {
    return null
  }
}

// Returns the final file path if cached, null if not
export function getPlaylistXmltvCachePath(playlistId, key, compress = false) {
  const paths = getCachePaths(Number(playlistId), key)
  const filePath = compress ? paths.gz : paths.xml
  return existsSync(filePath) ? filePath : null
}

// Backward-compat: write xml string and/or gzip buffer to disk synchronously
export function setPlaylistXmltvCache(playlistId, key, xml, gzip, sourceIds = []) {
  const paths = getCachePaths(Number(playlistId), key)
  const cleanSourceIds = [...new Set((sourceIds || []).map(Number).filter(Number.isFinite))]
  try {
    if (xml) writeFileSync(paths.xml, xml, 'utf8')
    if (gzip) writeFileSync(paths.gz, gzip)
    const meta = { key, sourceIds: cleanSourceIds, createdAt: new Date().toISOString() }
    writeFileSync(paths.meta, JSON.stringify(meta), 'utf8')
  } catch (err) {
    console.error('[xmltvCache] setPlaylistXmltvCache error:', err)
  }
}

// Stream async generator to disk atomically, then rename to final path
// Returns the final file path
export async function streamToXmltvCache(playlistId, key, generator, compress = false, sourceIds = []) {
  const paths = getCachePaths(Number(playlistId), key)
  const tmpPath = compress ? paths.gzTmp : paths.xmlTmp
  const finalPath = compress ? paths.gz : paths.xml

  return new Promise(async (resolve, reject) => {
    const writeStream = createWriteStream(tmpPath)
    let targetStream = writeStream

    if (compress) {
      const gzip = createGzip()
      gzip.pipe(writeStream)
      targetStream = gzip
    }

    writeStream.on('error', reject)
    if (compress) targetStream.on('error', reject)

    writeStream.on('finish', () => {
      try {
        renameSync(tmpPath, finalPath)
        // Write metadata sidecar
        const cleanSourceIds = [...new Set((sourceIds || []).map(Number).filter(Number.isFinite))]
        const meta = { key, sourceIds: cleanSourceIds, createdAt: new Date().toISOString() }
        writeFileSync(paths.meta, JSON.stringify(meta), 'utf8')
        resolve(finalPath)
      } catch (err) {
        reject(err)
      }
    })

    try {
      for await (const chunk of generator) {
        if (!targetStream.write(chunk)) {
          // Backpressure: wait for drain
          await new Promise(r => targetStream.once('drain', r))
        }
      }
      targetStream.end()
    } catch (err) {
      targetStream.destroy(err)
      reject(err)
    }
  })
}

export function getPlaylistXmltvCacheMeta(playlistId) {
  // Find any meta file for this playlistId (key is unknown here, scan by prefix)
  try {
    const files = readdirSync(XMLTV_CACHE_DIR)
    const prefix = `xmltv_${Number(playlistId)}_`
    const metaFile = files.find(f => f.startsWith(prefix) && f.endsWith('.meta.json'))
    if (!metaFile) return null
    const data = JSON.parse(readFileSync(path.join(XMLTV_CACHE_DIR, metaFile), 'utf8'))
    return { key: data.key, createdAt: data.createdAt, sourceIds: data.sourceIds || [] }
  } catch {
    return null
  }
}

function deleteFileSafe(filePath) {
  try { unlinkSync(filePath) } catch {}
}

export function invalidatePlaylistXmltvCache(playlistId) {
  try {
    const files = readdirSync(XMLTV_CACHE_DIR)
    const prefix = `xmltv_${Number(playlistId)}_`
    for (const file of files) {
      if (file.startsWith(prefix)) {
        deleteFileSafe(path.join(XMLTV_CACHE_DIR, file))
      }
    }
  } catch {}
}

export function invalidateAllPlaylistXmltvCache() {
  try {
    const files = readdirSync(XMLTV_CACHE_DIR)
    for (const file of files) {
      if (file.startsWith('xmltv_')) {
        deleteFileSafe(path.join(XMLTV_CACHE_DIR, file))
      }
    }
  } catch {}
}

export function invalidatePlaylistsForSource(sourceId) {
  const targetId = Number(sourceId)
  if (!Number.isFinite(targetId)) {
    invalidateAllPlaylistXmltvCache()
    return
  }
  try {
    const files = readdirSync(XMLTV_CACHE_DIR)
    const metaFiles = files.filter(f => f.startsWith('xmltv_') && f.endsWith('.meta.json'))
    for (const metaFile of metaFiles) {
      try {
        const data = JSON.parse(readFileSync(path.join(XMLTV_CACHE_DIR, metaFile), 'utf8'))
        if ((data.sourceIds || []).includes(targetId)) {
          // Extract playlistId from filename: xmltv_{playlistId}_{key}.meta.json
          const match = metaFile.match(/^xmltv_(\d+)_/)
          if (match) invalidatePlaylistXmltvCache(Number(match[1]))
        }
      } catch {}
    }
  } catch {}
}
