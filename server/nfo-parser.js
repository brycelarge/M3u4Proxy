/**
 * NFO Parser for Jellyfin Metadata
 *
 * Reads .nfo files created by Jellyfin and extracts metadata
 * for enriching Xtream API responses and M3U playlists
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const STRM_BASE_DIR = process.env.STRM_EXPORT_DIR || '/data/vod-strm'

function parseNfoXml(xmlContent) {
  const metadata = {
    title: null,
    originalTitle: null,
    plot: null,
    rating: null,
    year: null,
    releaseDate: null,
    runtime: null,
    genre: [],
    director: [],
    actor: [],
    tmdbId: null,
    imdbId: null,
    poster: null,
    fanart: null,
  }

  // Simple XML parsing - extract values between tags
  const extractTag = (tag) => {
    const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')
    const match = xmlContent.match(regex)
    return match ? match[1].trim() : null
  }

  const extractAllTags = (tag) => {
    const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi')
    const matches = [...xmlContent.matchAll(regex)]
    return matches.map(m => m[1].trim()).filter(Boolean)
  }

  const extractNestedTag = (parentTag, childTag) => {
    const parentRegex = new RegExp(`<${parentTag}>(.*?)</${parentTag}>`, 'gis')
    const results = []
    const parentMatches = [...xmlContent.matchAll(parentRegex)]

    for (const parentMatch of parentMatches) {
      const childRegex = new RegExp(`<${childTag}>([^<]*)</${childTag}>`, 'i')
      const childMatch = parentMatch[1].match(childRegex)
      if (childMatch) {
        results.push(childMatch[1].trim())
      }
    }
    return results
  }

  metadata.title = extractTag('title')
  metadata.originalTitle = extractTag('originaltitle') || extractTag('sorttitle')
  metadata.plot = extractTag('plot') || extractTag('outline')
  metadata.rating = extractTag('rating')
  metadata.year = extractTag('year')
  metadata.releaseDate = extractTag('releasedate') || extractTag('premiered')
  metadata.runtime = extractTag('runtime')
  metadata.genre = extractAllTags('genre')
  metadata.director = extractNestedTag('director', 'name')
  metadata.actor = extractNestedTag('actor', 'name')
  metadata.tmdbId = extractTag('tmdbid') || extractTag('tmdb')
  metadata.imdbId = extractTag('imdbid') || extractTag('imdb')
  metadata.poster = extractTag('thumb') || extractTag('poster')
  metadata.fanart = extractTag('fanart')

  return metadata
}

export function parseNfoFile(nfoPath) {
  if (!existsSync(nfoPath)) {
    return null
  }

  try {
    const xmlContent = readFileSync(nfoPath, 'utf8')
    return parseNfoXml(xmlContent)
  } catch (e) {
    console.error(`[nfo] Failed to parse ${nfoPath}:`, e.message)
    return null
  }
}

export function findNfoForChannel(channelId) {
  const METADATA_EXT = '.m3u4prox.json'

  if (!existsSync(STRM_BASE_DIR)) {
    return null
  }

  // Scan all playlist subdirectories
  const playlistDirs = readdirSync(STRM_BASE_DIR).filter(name => {
    const fullPath = join(STRM_BASE_DIR, name)
    return statSync(fullPath).isDirectory()
  })

  for (const playlistDir of playlistDirs) {
    const dirPath = join(STRM_BASE_DIR, playlistDir)
    const files = readdirSync(dirPath)

    // Find the .m3u4prox.json file for this channelId
    for (const file of files) {
      if (!file.endsWith(METADATA_EXT)) continue

      try {
        const metadataPath = join(dirPath, file)
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))

        if (metadata.channelId === String(channelId)) {
          // Found the metadata file - look for corresponding .nfo
          const nfoFile = file.replace(METADATA_EXT, '.nfo')
          const nfoPath = join(dirPath, nfoFile)

          if (existsSync(nfoPath)) {
            return parseNfoFile(nfoPath)
          }
        }
      } catch (e) {
        // Skip invalid metadata files
      }
    }
  }

  return null
}

export async function syncNfoToDatabase() {
  const db = new Database(process.env.DB_PATH || '/data/db/m3u4prox.db')

  // Create metadata table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS vod_metadata (
      channel_id INTEGER PRIMARY KEY,
      title TEXT,
      original_title TEXT,
      plot TEXT,
      rating REAL,
      year INTEGER,
      release_date TEXT,
      runtime INTEGER,
      genre TEXT,
      director TEXT,
      actor TEXT,
      tmdb_id TEXT,
      imdb_id TEXT,
      poster TEXT,
      fanart TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  const METADATA_EXT = '.m3u4prox.json'

  if (!existsSync(STRM_BASE_DIR)) {
    console.log('[nfo] STRM base directory does not exist')
    return { synced: 0, errors: 0 }
  }

  let synced = 0
  let errors = 0

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO vod_metadata (
      channel_id, title, original_title, plot, rating, year, release_date,
      runtime, genre, director, actor, tmdb_id, imdb_id, poster, fanart
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // Scan all playlist subdirectories
  const playlistDirs = readdirSync(STRM_BASE_DIR).filter(name => {
    const fullPath = join(STRM_BASE_DIR, name)
    try {
      return statSync(fullPath).isDirectory()
    } catch (e) {
      return false
    }
  })

  for (const playlistDir of playlistDirs) {
    const dirPath = join(STRM_BASE_DIR, playlistDir)
    console.log(`[nfo] Scanning playlist directory: ${playlistDir}`)

    const files = readdirSync(dirPath)

    for (const file of files) {
      if (!file.endsWith(METADATA_EXT)) continue

      try {
        const metadataPath = join(dirPath, file)
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))

        const nfoFile = file.replace(METADATA_EXT, '.nfo')
        const nfoPath = join(dirPath, nfoFile)

        if (existsSync(nfoPath)) {
          const nfoData = parseNfoFile(nfoPath)

          if (nfoData) {
            upsert.run(
              metadata.channelId,
              nfoData.title,
              nfoData.originalTitle,
              nfoData.plot,
              nfoData.rating ? parseFloat(nfoData.rating) : null,
              nfoData.year ? parseInt(nfoData.year) : null,
              nfoData.releaseDate,
              nfoData.runtime ? parseInt(nfoData.runtime) : null,
              nfoData.genre.join(', '),
              nfoData.director.join(', '),
              nfoData.actor.join(', '),
              nfoData.tmdbId,
              nfoData.imdbId,
              nfoData.poster,
              nfoData.fanart
            )
            synced++
            console.log(`[nfo] Synced metadata for channel ${metadata.channelId}: ${nfoData.title}`)
          }
        }
      } catch (e) {
        console.error(`[nfo] Error processing ${file}:`, e.message)
        errors++
      }
    }
  }

  db.close()
  console.log(`[nfo] Sync complete: ${synced} synced, ${errors} errors`)
  return { synced, errors }
}

export function getVodMetadata(channelId) {
  const db = new Database(process.env.DB_PATH || '/data/db/m3u4prox.db')
  const row = db.prepare('SELECT * FROM vod_metadata WHERE channel_id = ?').get(channelId)
  db.close()
  return row
}

export function getAllVodMetadata() {
  const db = new Database(process.env.DB_PATH || '/data/db/m3u4prox.db')
  const rows = db.prepare('SELECT * FROM vod_metadata').all()
  db.close()
  return rows
}
