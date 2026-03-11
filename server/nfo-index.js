/**
 * Fast NFO Index Builder
 *
 * Scans /data/vod-strm ONCE and builds a Map of channelId -> NFO data
 * Much faster than per-channel recursive scans
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseNfoFile } from './nfo-parser.js'

const STRM_BASE_DIR = process.env.STRM_EXPORT_DIR || '/data/vod-strm'
const METADATA_EXT = '.m3u4prox.json'

let nfoIndexCache = null
let nfoTitleIndexCache = null // Map<normalizedTitle, nfoData>
let nfoIndexTimestamp = 0
// No TTL - cache persists in memory until explicit rebuild (startup or STRM export)

// Normalize title for matching
function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').trim()
}

/**
 * Build NFO index by scanning vod-strm once
 * Returns Map<channelId, nfoData>
 */
export function buildNfoIndex() {
  const index = new Map()
  const titleIndex = new Map()

  if (!existsSync(STRM_BASE_DIR)) {
    console.log(`[nfo-index] STRM base dir does not exist: ${STRM_BASE_DIR}`)
    nfoIndexCache = index
    nfoTitleIndexCache = titleIndex
    nfoIndexTimestamp = Date.now()
    return index
  }

  console.log(`[nfo-index] Building NFO index from ${STRM_BASE_DIR}`)
  const startTime = Date.now()
  let metadataCount = 0
  let nfoCount = 0

  function scanDir(dirPath) {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })

      // First pass: find all metadata files and their NFOs
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(METADATA_EXT)) {
          try {
            const metadataPath = join(dirPath, entry.name)
            const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
            const channelId = metadata.channelId

            if (!channelId) continue

            metadataCount++

            // Check for NFO files in priority order
            const baseFilename = entry.name.replace(METADATA_EXT, '')
            const nfoOptions = [
              join(dirPath, `${baseFilename}.nfo`),  // Episode-specific NFO
              join(dirPath, 'movie.nfo'),             // Movie NFO
              join(dirPath, 'tvshow.nfo'),            // Series root NFO
              join(dirPath, 'season.nfo')             // Season NFO
            ]

            for (const nfoPath of nfoOptions) {
              if (existsSync(nfoPath)) {
                const nfoData = parseNfoFile(nfoPath)
                if (nfoData) {
                  index.set(String(channelId), nfoData)

                  // Also index by title for TMDB enrichment lookups
                  if (nfoData.title) {
                    const normalizedTitle = normalizeTitle(nfoData.title)
                    titleIndex.set(normalizedTitle, nfoData)
                  }

                  nfoCount++
                  break
                }
              }
            }
          } catch (e) {
            // Skip invalid metadata files
          }
        }
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scanDir(join(dirPath, entry.name))
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }
  }

  scanDir(STRM_BASE_DIR)

  const elapsed = Date.now() - startTime
  console.log(`[nfo-index] Built index: ${nfoCount} NFOs from ${metadataCount} metadata files in ${elapsed}ms`)
  console.log(`[nfo-index] Title index: ${titleIndex.size} unique titles`)

  // Cache the built indexes
  nfoIndexCache = index
  nfoTitleIndexCache = titleIndex
  nfoIndexTimestamp = Date.now()

  return index
}

/**
 * Get NFO data for a channel ID using cached index
 * Rebuilds index only if missing (cache persists until explicit rebuild)
 */
export function getNfoFromIndex(channelId) {
  // Rebuild index only if missing
  if (!nfoIndexCache) {
    buildNfoIndex()
  }

  return nfoIndexCache.get(String(channelId)) || null
}

/**
 * Force rebuild of NFO index
 */
export function rebuildNfoIndex() {
  nfoIndexCache = buildNfoIndex()
  nfoIndexTimestamp = Date.now()
  return nfoIndexCache
}

/**
 * Get NFO data by title (for TMDB enrichment)
 * Uses cached title index for fast lookups
 */
export function getNfoByTitle(title) {
  const now = Date.now()

  // Rebuild index if cache is stale or missing
  if (!nfoTitleIndexCache || (now - nfoIndexTimestamp) > CACHE_TTL_MS) {
    buildNfoIndex()
  }

  const normalizedTitle = normalizeTitle(title)
  return nfoTitleIndexCache?.get(normalizedTitle) || null
}

/**
 * Get the full in-memory title index (Map<normalizedTitle, nfoData>)
 * Returns null if index hasn't been built yet
 */
export function getNfoTitleIndex() {
  return nfoTitleIndexCache
}

/**
 * Get current index stats
 */
export function getNfoIndexStats() {
  return {
    cached: !!nfoIndexCache,
    size: nfoIndexCache?.size || 0,
    titleIndexSize: nfoTitleIndexCache?.size || 0,
    age: nfoIndexCache ? Date.now() - nfoIndexTimestamp : 0,
    persistent: true // Cache persists until explicit rebuild
  }
}
