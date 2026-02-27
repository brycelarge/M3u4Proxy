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
    console.log(`[nfo] STRM base dir does not exist: ${STRM_BASE_DIR}`)
    return null
  }

  console.log(`[nfo] Searching for channel ${channelId} in ${STRM_BASE_DIR}`)

  // Get channel info from database to match by name if metadata files don't exist
  const db = new Database(process.env.DB_PATH || '/data/db/m3u-manager.db')
  const channel = db.prepare('SELECT tvg_name, group_title FROM playlist_channels WHERE id = ?').get(channelId)
  db.close()

  if (!channel) {
    console.log(`[nfo] Channel ${channelId} not found in database`)
    return null
  }

  // Recursive function to search directories
  function searchDir(dirPath) {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })

      // First check for .m3u4prox.json metadata files in this directory
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(METADATA_EXT)) {
          try {
            const metadataPath = join(dirPath, entry.name)
            const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))

            if (metadata.channelId === String(channelId)) {
              // Found metadata file - check for NFO files in priority order:
              // 1. [episode filename].nfo (Jellyfin creates this for each episode)
              // 2. movie.nfo (Jellyfin standard for movies)
              // 3. tvshow.nfo (Jellyfin standard for series root)
              // 4. season.nfo (Jellyfin creates this in season folders)
              const baseFilename = entry.name.replace(METADATA_EXT, '')
              const nfoOptions = [
                join(dirPath, `${baseFilename}.nfo`),  // Episode-specific NFO
                join(dirPath, 'movie.nfo'),             // Movie NFO
                join(dirPath, 'tvshow.nfo'),            // Series root NFO
                join(dirPath, 'season.nfo')             // Season NFO
              ]

              for (const nfoPath of nfoOptions) {
                if (existsSync(nfoPath)) {
                  console.log(`[nfo] Found NFO via metadata: ${nfoPath}`)
                  return parseNfoFile(nfoPath)
                }
              }
            }
          } catch (e) {
            // Skip invalid metadata files
          }
        }
      }

      // If no metadata file found, try to match by directory name
      if (channel && channel.group_title) {
        const dirName = dirPath.split('/').pop()

        // For movies: match directory name with channel name (minus year)
        if (channel.group_title.startsWith('Movie:')) {
          const movieNfoPath = join(dirPath, 'movie.nfo')
          if (existsSync(movieNfoPath)) {
            const channelName = channel.tvg_name.replace(/\s*\(\d{4}\)/, '').trim()
            if (dirName.toLowerCase().includes(channelName.toLowerCase()) ||
                channelName.toLowerCase().includes(dirName.toLowerCase())) {
              console.log(`[nfo] Found NFO by directory match: ${movieNfoPath}`)
              return parseNfoFile(movieNfoPath)
            }
          }
        }

        // For series: match directory name with series name (before S01E01)
        if (channel.group_title.startsWith('Series:')) {
          const tvshowNfoPath = join(dirPath, 'tvshow.nfo')
          if (existsSync(tvshowNfoPath)) {
            // Extract series name from channel name (before S01E01 pattern)
            const seriesName = channel.tvg_name.replace(/\s*S\d{2}E\d{2}.*$/, '').replace(/\s*\(\d{4}\)/, '').trim()
            if (dirName.toLowerCase().includes(seriesName.toLowerCase()) ||
                seriesName.toLowerCase().includes(dirName.toLowerCase())) {
              console.log(`[nfo] Found NFO by directory match: ${tvshowNfoPath}`)
              return parseNfoFile(tvshowNfoPath)
            }
          }
        }
      }

      // Search subdirectories recursively
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const result = searchDir(join(dirPath, entry.name))
          if (result) return result
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }

    return null
  }

  return searchDir(STRM_BASE_DIR)
}
