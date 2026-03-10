/**
 * Smart STRM Exporter for VOD Playlists
 *
 * Creates .strm files with metadata sidecars (.m3u4.json) for Jellyfin/Plex integration
 * Handles renames, updates, and deletions intelligently
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, statSync, rmdirSync } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'
import Database from 'better-sqlite3'
import { getVodSettings } from './routes/settings.js'
import { xml2json } from 'xml-js'

const STRM_BASE_DIR = process.env.STRM_EXPORT_DIR || '/data/vod-strm'
const METADATA_EXT = '.m3u4prox.json'
const EVENT_LOOP_YIELD_INTERVAL = 250

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve))
}

// Helper to check if a folder is managed by m3u4prox (has our marker file)
function isManagedFolder(dirPath) {
  return existsSync(join(dirPath, METADATA_EXT))
}

// Helper to safely delete a directory only if it's managed by us and empty
function safeDeleteManagedDir(dirPath, deletedDirs) {
  try {
    if (!isManagedFolder(dirPath)) {
      return false
    }

    const files = readdirSync(dirPath).filter(f => f !== METADATA_EXT && !f.startsWith('.'))
    if (files.length === 0) {
      // Remove marker file first
      try {
        unlinkSync(join(dirPath, METADATA_EXT))
      } catch (e) {
        // Ignore if marker doesn't exist
      }
      rmdirSync(dirPath)
      console.log(`[strm] Removed managed empty directory: ${dirPath}`)
      deletedDirs.add(dirPath)
      return true
    }
  } catch (e) {
    // Ignore errors
  }
  return false
}

function persistBlockedTitles(db, titles) {
  const normalizedTitles = [...new Set(
    titles
      .map(title => String(title || '').trim())
      .filter(Boolean)
  )]

  if (normalizedTitles.length === 0) {
    return 0
  }

  const existingRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('vod_blocked_titles')
  let existingTitles = []

  if (existingRow?.value) {
    try {
      const parsed = JSON.parse(existingRow.value)
      existingTitles = Array.isArray(parsed) ? parsed : []
    } catch {
      existingTitles = []
    }
  }

  const blockedByLower = new Map(existingTitles.map(title => [String(title).trim().toLowerCase(), String(title).trim()]))
  let addedCount = 0

  for (const title of normalizedTitles) {
    const key = title.toLowerCase()
    if (!blockedByLower.has(key)) {
      blockedByLower.set(key, title)
      addedCount++
    }
  }

  if (addedCount === 0) {
    return 0
  }

  const mergedTitles = Array.from(blockedByLower.values()).sort((a, b) => a.localeCompare(b))
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vod_blocked_titles', JSON.stringify(mergedTitles))

  return addedCount
}

function normalizeLanguageValue(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const languageAliases = new Map([
    ['en', 'eng'],
    ['eng', 'eng'],
    ['english', 'eng'],
    ['us english', 'eng'],
    ['uk english', 'eng'],
    ['es', 'spa'],
    ['spa', 'spa'],
    ['spanish', 'spa'],
    ['español', 'spa'],
    ['fr', 'fre'],
    ['fre', 'fre'],
    ['fra', 'fre'],
    ['french', 'fre'],
    ['de', 'ger'],
    ['ger', 'ger'],
    ['deu', 'ger'],
    ['german', 'ger'],
    ['it', 'ita'],
    ['ita', 'ita'],
    ['italian', 'ita'],
    ['pt', 'por'],
    ['por', 'por'],
    ['portuguese', 'por'],
    ['pt br', 'por'],
    ['pt-br', 'por'],
    ['brazilian portuguese', 'por'],
    ['ru', 'rus'],
    ['rus', 'rus'],
    ['russian', 'rus'],
    ['nl', 'dut'],
    ['dut', 'dut'],
    ['nld', 'dut'],
    ['dutch', 'dut'],
    ['tr', 'tur'],
    ['tur', 'tur'],
    ['turkish', 'tur'],
    ['ar', 'ara'],
    ['ara', 'ara'],
    ['arabic', 'ara'],
    ['hi', 'hin'],
    ['hin', 'hin'],
    ['hindi', 'hin'],
    ['ja', 'jpn'],
    ['jpn', 'jpn'],
    ['japanese', 'jpn'],
    ['ko', 'kor'],
    ['kor', 'kor'],
    ['korean', 'kor'],
    ['zh', 'chi'],
    ['chi', 'chi'],
    ['zho', 'chi'],
    ['chinese', 'chi']
  ])

  return languageAliases.get(normalized) || normalized
}

// Parse NFO file to extract language information
function parseNfoLanguages(nfoPath) {
  try {
    const content = readFileSync(nfoPath, 'utf-8')
    const jsonStr = xml2json(content, { compact: true, spaces: 2 })
    const result = JSON.parse(jsonStr)

    const languages = []

    // Extract from fileinfo/streamdetails (common in both movie and tvshow NFOs)
    const fileinfo = result.movie?.fileinfo || result.tvshow?.fileinfo || result.episodedetails?.fileinfo
    if (fileinfo?.streamdetails) {
      const audio = fileinfo.streamdetails.audio
      if (audio) {
        const audioStreams = Array.isArray(audio) ? audio : [audio]
        for (const stream of audioStreams) {
          const lang = stream.language?._text || stream.language
          if (lang) {
            languages.push(normalizeLanguageValue(lang))
          }
        }
      }
    }

    // Also check for language field directly
    const langField = result.movie?.language?._text || result.tvshow?.language?._text
    if (langField) {
      languages.push(normalizeLanguageValue(langField))
    }

    return [...new Set(languages)]
  } catch (e) {
    return []
  }
}

function parseNfoGenres(nfoPath) {
  try {
    const content = readFileSync(nfoPath, 'utf-8')
    const jsonStr = xml2json(content, { compact: true, spaces: 2 })
    const result = JSON.parse(jsonStr)

    const rawGenres = result.movie?.genre || result.tvshow?.genre || result.episodedetails?.genre
    if (!rawGenres) return []

    const values = Array.isArray(rawGenres) ? rawGenres : [rawGenres]
    const genres = new Map()
    const normalizeGenre = (value) => String(value)
      .replace(/\s+/g, ' ')
      .trim()
    for (const value of values) {
      const text = value?._text || value
      if (!text) continue
      for (const genre of String(text).split(/[\/,]/).map(v => normalizeGenre(v)).filter(Boolean)) {
        genres.set(genre.toLowerCase(), genre)
      }
    }

    return Array.from(genres.values())
  } catch (e) {
    return []
  }
}

// Check if series/movie passes configured NFO-based language/genre filters
function checkNfoFilters(folderPath, vodSettings) {
  try {
    const languageFilterEnabled = vodSettings.vod_language_filter_mode && vodSettings.vod_language_filter_mode !== 'disabled' && Array.isArray(vodSettings.vod_allowed_languages) && vodSettings.vod_allowed_languages.length > 0
    const genreFilterEnabled = vodSettings.vod_genre_filter_mode && vodSettings.vod_genre_filter_mode !== 'disabled' && Array.isArray(vodSettings.vod_allowed_genres) && vodSettings.vod_allowed_genres.length > 0

    if (!languageFilterEnabled && !genreFilterEnabled) {
      return { allowed: true, reason: 'All VOD filters disabled' }
    }

    // Check for tvshow.nfo (series) or movie.nfo (movie)
    const tvshowNfo = join(folderPath, 'tvshow.nfo')
    const movieNfo = join(folderPath, 'movie.nfo')

    let nfoPath = null
    let contentType = null

    if (existsSync(tvshowNfo)) {
      nfoPath = tvshowNfo
      contentType = 'series'
    } else if (existsSync(movieNfo)) {
      nfoPath = movieNfo
      contentType = 'movie'
    }

    if (!nfoPath) {
      return { allowed: true, reason: 'No NFO file found', contentType: 'unknown', languages: [], genres: [] }
    }

    const languages = parseNfoLanguages(nfoPath)
    const genres = parseNfoGenres(nfoPath)

    if (languageFilterEnabled) {
      if (languages.length > 0) {
        const allowedLanguageSet = new Set(vodSettings.vod_allowed_languages.map(l => normalizeLanguageValue(l)))
        const hasAllowedLang = languages.some(lang => allowedLanguageSet.has(lang))
        if (!hasAllowedLang) {
          return { allowed: false, reason: `Languages not in allowed list: ${languages.join(', ')}`, contentType, languages, genres }
        }
      }
    }

    if (genreFilterEnabled) {
      if (genres.length > 0) {
        const allowedGenreSet = new Set(vodSettings.vod_allowed_genres.map(g => g.toLowerCase()))
        const hasAllowedGenre = genres.some(genre => allowedGenreSet.has(genre.toLowerCase()))
        if (!hasAllowedGenre) {
          return { allowed: false, reason: `Genres not in allowed list: ${genres.join(', ')}`, contentType, languages, genres }
        }
      }
    }

    return { allowed: true, reason: 'Passed VOD filters', contentType, languages, genres }
  } catch (e) {
    return { allowed: true, reason: 'Error checking NFO', error: e.message }
  }
}

function getPlaylistStrmDir(playlistName) {
  const sanitized = playlistName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return join(STRM_BASE_DIR, sanitized)
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*']/g, '') // Remove invalid chars including apostrophes
    .replace(/\s+/g, ' ')           // Normalize spaces
    .trim()
}

function extractYear(name) {
  const match = name.match(/\((\d{4})\)/)
  return match ? match[1] : null
}

function parseSeriesInfo(name) {
  // Try to parse season/episode from various formats:
  // S01E01, s01e01, 1x01, Season 1 Episode 1, etc.
  const patterns = [
    /[Ss](\d{1,2})[Ee](\d{1,2})/,           // S01E01, s01e01
    /[Ss]eason\s*(\d{1,2})\s*[Ee]pisode\s*(\d{1,2})/i, // Season 1 Episode 1
    /(\d{1,2})x(\d{1,2})/,                   // 1x01
  ]

  for (const pattern of patterns) {
    const match = name.match(pattern)
    if (match) {
      return {
        isSeries: true,
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10),
        // Extract series name (everything before the season/episode marker)
        seriesName: name.substring(0, match.index).trim()
      }
    }
  }

  return { isSeries: false }
}

function buildFilename(channel) {
  const name = channel.tvg_name || 'Unknown'
  const seriesInfo = parseSeriesInfo(name)

  if (seriesInfo.isSeries) {
    // For series: "Episode Name.strm" (will be in season folder)
    return sanitizeFilename(name) + '.strm'
  }

  // For movies: try to extract year from name or metadata
  let year = extractYear(name)

  // If no year in name, try to get from metadata
  if (!year && channel.meta) {
    const meta = typeof channel.meta === 'string' ? JSON.parse(channel.meta) : channel.meta
    year = meta.releaseDate || meta.release_date || meta.year || null
  }

  // Build filename with year if available
  const baseName = name.replace(/\(\d{4}\)/, '').trim() // Remove existing year if present
  const filename = year ? `${baseName} (${year})` : baseName

  return sanitizeFilename(filename) + '.strm'
}

function buildMetadata(channel, playlistId, proxyUrl) {
  return {
    channelId: String(channel.id),
    playlistId: String(playlistId),
    tvgName: channel.tvg_name,
    tvgLogo: channel.tvg_logo || null,
    groupTitle: channel.group_title || null,
    upstreamUrl: channel.url,
    proxyUrl: proxyUrl,
    normalizedName: channel.normalized_name || null,
    tvgId: channel.tvg_id || null,
    meta: channel.meta || null,
    lastUpdated: new Date().toISOString(),
  }
}

function buildNfoContent(channel, seriesInfo) {
  const meta = channel.meta ? (typeof channel.meta === 'string' ? JSON.parse(channel.meta) : channel.meta) : {}
  const tmdbId = meta.tmdb_id || channel.tvg_id || ''
  const year = meta.releaseDate || meta.release_date || meta.year || ''
  const plot = meta.plot || ''
  const rating = meta.rating || ''
  const genre = meta.genre || ''
  const cast = meta.cast ? (typeof meta.cast === 'string' ? JSON.parse(meta.cast) : meta.cast) : []
  const director = meta.director || ''

  if (seriesInfo && seriesInfo.isSeries) {
    // Episode NFO
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${escapeXml(channel.tvg_name)}</title>
  ${tmdbId ? `<tmdbid>${escapeXml(tmdbId)}</tmdbid>` : ''}
  ${year ? `<year>${escapeXml(year)}</year>` : ''}
  <season>${seriesInfo.season}</season>
  <episode>${seriesInfo.episode}</episode>
  ${plot ? `<plot>${escapeXml(plot)}</plot>` : ''}
  ${rating ? `<rating>${escapeXml(rating)}</rating>` : ''}
  ${genre ? `<genre>${escapeXml(genre)}</genre>` : ''}
  ${channel.tvg_logo ? `<thumb>${escapeXml(channel.tvg_logo)}</thumb>` : ''}
  ${director ? `<director>${escapeXml(director)}</director>` : ''}
  ${cast.map(actor => `<actor><name>${escapeXml(actor)}</name></actor>`).join('\n  ')}
</episodedetails>`
  } else {
    // Movie NFO
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>${escapeXml(channel.tvg_name)}</title>
  ${tmdbId ? `<tmdbid>${escapeXml(tmdbId)}</tmdbid>` : ''}
  ${year ? `<year>${escapeXml(year)}</year>` : ''}
  ${plot ? `<plot>${escapeXml(plot)}</plot>` : ''}
  ${rating ? `<rating>${escapeXml(rating)}</rating>` : ''}
  ${genre ? `<genre>${escapeXml(genre)}</genre>` : ''}
  ${channel.tvg_logo ? `<thumb>${escapeXml(channel.tvg_logo)}</thumb>` : ''}
  ${director ? `<director>${escapeXml(director)}</director>` : ''}
  ${cast.map(actor => `<actor><name>${escapeXml(actor)}</name></actor>`).join('\n  ')}
</movie>`
  }
}

function escapeXml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function scanExistingFiles(strmDir) {
  if (!existsSync(strmDir)) {
    mkdirSync(strmDir, { recursive: true })
    return new Map()
  }

  console.log(`[strm] Scanning directory: ${strmDir}`)
  const map = new Map() // normalizedName -> { strmFile, metadataFile, metadata, relativePath }
  let metadataCount = 0

  function scanDirectory(dir, relativePath = '') {
    const files = readdirSync(dir)

    for (const file of files) {
      const fullPath = join(dir, file)
      const relPath = relativePath ? join(relativePath, file) : file

      // Check if it's a directory (series/season folder)
      if (statSync(fullPath).isDirectory()) {
        scanDirectory(fullPath, relPath)
        continue
      }

      if (!file.endsWith(METADATA_EXT)) continue

      metadataCount++
      const metadataPath = fullPath
      const strmFile = file.replace(METADATA_EXT, '.strm')
      const strmPath = join(dir, strmFile)

      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))

        if (existsSync(strmPath)) {
          // Use normalized_name as key for matching across provider changes
          // Handle both camelCase (old) and snake_case (new) formats
          const key = metadata.normalizedName || metadata.normalized_name || metadata.channelId
          map.set(key, {
            strmFile,
            metadataFile: file,
            metadata,
            relativePath: relativePath || null,
            fullStrmPath: strmPath,
            fullMetadataPath: metadataPath
          })
        } else {
          unlinkSync(metadataPath)
        }
      } catch (e) {
        console.error(`[strm] Failed to read metadata ${file}:`, e.message)
      }
    }
  }

  scanDirectory(strmDir)
  return map
}

export async function exportVodToStrm(playlistId, baseUrl, username, password, options = {}) {
  const { deleteOrphans = true } = options
  console.log(`[strm] Starting export for playlist ${playlistId} (deleteOrphans: ${deleteOrphans})`)
  let processedLoopItems = 0

  async function maybeYield() {
    processedLoopItems++
    if (processedLoopItems % EVENT_LOOP_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
    }
  }

  const dbPath = process.env.DB_PATH || join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'db', 'm3u-manager.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId)
  if (!playlist) {
    throw new Error(`Playlist ${playlistId} not found`)
  }

  // Parse stored group selections
  let groupSelections = null
  if (playlist.group_selections) {
    try {
      groupSelections = JSON.parse(playlist.group_selections)
    } catch (e) {
      console.error(`[strm] Failed to parse group_selections:`, e.message)
    }
  }

  let channels = []

  if (groupSelections && groupSelections.groups) {
    // Query playlist_channels with source_channels metadata
    console.log(`[strm] Using stored group selections to query playlist_channels`)
    const { sourceId, groups } = groupSelections

    for (const [groupName, sel] of Object.entries(groups)) {
      if (!sel || (Array.isArray(sel) && sel.length === 0)) continue

      let rows = []
      if (sel === '__all__') {
        if (sourceId === null || sourceId === undefined) {
          // All sources mode — match by group_title suffix
          const parts = groupName.split(' › ')
          const gt = parts.length > 1 ? parts[parts.length - 1] : groupName
          rows = db.prepare(`
            SELECT pc.*, sc.meta, sc.normalized_name
            FROM playlist_channels pc
            LEFT JOIN source_channels sc ON sc.url = pc.url
            WHERE pc.playlist_id = ? AND pc.group_title = ?
          `).all(playlistId, gt)
        } else {
          rows = db.prepare(`
            SELECT pc.*, sc.meta, sc.normalized_name
            FROM playlist_channels pc
            LEFT JOIN source_channels sc ON sc.url = pc.url
            WHERE pc.playlist_id = ? AND pc.group_title = ?
          `).all(playlistId, groupName)
        }
      } else {
        // Array of specific channel IDs
        if (Array.isArray(sel) && sel.length > 0) {
          const firstCh = db.prepare('SELECT group_title FROM playlist_channels WHERE id = ? AND playlist_id = ?').get(sel[0], playlistId)
          if (firstCh) {
            rows = db.prepare(`
              SELECT pc.*, sc.meta, sc.normalized_name
              FROM playlist_channels pc
              LEFT JOIN source_channels sc ON sc.url = pc.url
              WHERE pc.playlist_id = ? AND pc.group_title = ?
            `).all(playlistId, firstCh.group_title)
          }
        }
      }

      channels.push(...rows)
    }

    console.log(`[strm] Found ${channels.length} channels from selected groups in playlist_channels`)
  } else {
    // Fallback: use playlist_channels (old behavior)
    console.log(`[strm] No group selections stored, falling back to playlist_channels`)
    const sampleChannels = db.prepare(`
      SELECT group_title FROM playlist_channels
      WHERE playlist_id = ?
      LIMIT 10
    `).all(playlistId)

    const hasMovies = sampleChannels.some(ch => ch.group_title?.startsWith('Movie:'))
    const hasSeries = sampleChannels.some(ch => ch.group_title?.startsWith('Series:'))
    const contentType = hasSeries ? 'series' : (hasMovies ? 'movies' : 'series')
    const prefix = contentType === 'series' ? 'Series' : 'Movie'

    channels = db.prepare(`
      SELECT
        pc.*,
        sc.meta,
        sc.normalized_name
      FROM playlist_channels pc
      LEFT JOIN source_channels sc ON pc.source_id = sc.source_id AND pc.url = sc.url
      WHERE pc.playlist_id = ?
        AND pc.group_title LIKE '${prefix}:%'
      ORDER BY pc.tvg_name
    `).all(playlistId)
  }

  if (channels.length === 0) {
    console.log(`[strm] No VOD channels found in playlist ${playlistId}`)
    db.close()
    return { created: 0, updated: 0, deleted: 0, errors: 0 }
  }

  const strmDir = getPlaylistStrmDir(playlist.name)
  console.log(`[strm] Using directory: ${strmDir}`)

  const existing = scanExistingFiles(strmDir)
  console.log(`[strm] Found ${existing.size} existing STRM files`)
  const processed = new Set()
  let stats = { created: 0, updated: 0, deleted: 0, errors: 0, skipped: 0, filtered: 0, directory: strmDir }
  const errorList = []
  const skippedList = []
  const titlesToBlock = new Set()
  const blockedSeriesKeys = new Set()
  const blockedMovieKeys = new Set()

  // Load VOD settings for filtering
  const vodSettings = getVodSettings()

  // Build deduplicated dataset grouped by series/movie level (not episode)
  // For filtering purposes, we need to group episodes by series
  const seriesGroups = new Map() // seriesName -> { episodes: [], folderPath: null }
  const movieItems = new Map() // normalized_name -> channel

  for (const channel of channels) {
    await maybeYield()
    const isSeriesGroup = (channel.group_title || '').startsWith('Series:')
    const seriesInfo = parseSeriesInfo(channel.tvg_name || '')

    if (isSeriesGroup && seriesInfo.isSeries) {
      // Group by series name (not individual episode)
      const seriesKey = seriesInfo.seriesName.toLowerCase().trim()
      if (!seriesGroups.has(seriesKey)) {
        seriesGroups.set(seriesKey, {
          seriesName: seriesInfo.seriesName,
          episodes: [],
          folderPath: null,
          year: null
        })
      }
      seriesGroups.get(seriesKey).episodes.push(channel)

      // Extract year from metadata if available
      if (channel.meta) {
        const meta = typeof channel.meta === 'string' ? JSON.parse(channel.meta) : channel.meta
        if (meta.releaseDate || meta.release_date || meta.year) {
          seriesGroups.get(seriesKey).year = meta.releaseDate || meta.release_date || meta.year
        }
      }
    } else {
      // Movies are handled individually
      const matchKey = channel.normalized_name || String(channel.id) || channel.url
      if (!movieItems.has(matchKey)) {
        movieItems.set(matchKey, channel)
      } else {
        skippedList.push({
          name: channel.tvg_name,
          group: channel.group_title,
          reason: `Duplicate movie (key: ${matchKey})`
        })
        stats.skipped++
      }
    }
  }

  // Check VOD blocked titles filter at series/movie level
  if (vodSettings.vod_blocked_titles?.length > 0) {
    // Filter blocked series
    for (const [seriesKey, seriesData] of seriesGroups.entries()) {
      await maybeYield()
      const nameLower = seriesData.seriesName.toLowerCase()
      const isBlocked = vodSettings.vod_blocked_titles.some(blocked =>
        blocked && nameLower.includes(blocked.toLowerCase())
      )
      if (isBlocked) {
        skippedList.push({
          name: seriesData.seriesName,
          group: 'Series',
          reason: 'Series blocked by title filter'
        })
        stats.filtered += seriesData.episodes.length
        blockedSeriesKeys.add(seriesKey)
        seriesGroups.delete(seriesKey)
      }
    }

    // Filter blocked movies
    for (const [movieKey, channel] of movieItems.entries()) {
      await maybeYield()
      const nameLower = (channel.tvg_name || '').toLowerCase()
      const isBlocked = vodSettings.vod_blocked_titles.some(blocked =>
        blocked && nameLower.includes(blocked.toLowerCase())
      )
      if (isBlocked) {
        skippedList.push({
          name: channel.tvg_name,
          group: channel.group_title,
          reason: 'Movie blocked by title filter'
        })
        stats.filtered++
        blockedMovieKeys.add(movieKey)
        movieItems.delete(movieKey)
      }
    }
  }

  // Determine folder paths for series and check NFO language before processing
  const seriesToProcess = new Map()
  const seriesToSkip = new Map()

  for (const [seriesKey, seriesData] of seriesGroups.entries()) {
    await maybeYield()
    const meta = seriesData.episodes[0].meta ?
      (typeof seriesData.episodes[0].meta === 'string' ? JSON.parse(seriesData.episodes[0].meta) : seriesData.episodes[0].meta) : null
    const year = seriesData.year || (meta ? (meta.releaseDate || meta.release_date || meta.year || '') : '')

    const baseName = seriesData.seriesName
    const folderWithoutYear = sanitizeFilename(baseName)
    const folderWithYear = year ? sanitizeFilename(`${baseName} (${year})`) : null

    // Determine which folder to use
    let seriesFolder = folderWithoutYear
    if (folderWithYear && existsSync(join(strmDir, folderWithYear))) {
      seriesFolder = folderWithYear
    } else if (existsSync(join(strmDir, folderWithoutYear))) {
      seriesFolder = folderWithoutYear
    } else if (folderWithYear && meta) {
      seriesFolder = folderWithYear
    }

    const seriesRootDir = join(strmDir, seriesFolder)
    seriesData.folderPath = seriesRootDir

    // Check NFO language at series level (before processing any episodes)
    const langCheck = checkNfoFilters(seriesRootDir, vodSettings)

    if (!langCheck.allowed) {
      titlesToBlock.add(seriesData.seriesName)
      skippedList.push({
        name: seriesData.seriesName,
        group: 'Series',
        reason: `Series filtered: ${langCheck.reason}`
      })
      stats.filtered += seriesData.episodes.length
      seriesToSkip.set(seriesKey, seriesData)

      // If deleteOrphans is enabled, mark this series for deletion
      if (deleteOrphans && existsSync(seriesRootDir)) {
        console.log(`[strm] Series "${seriesData.seriesName}" will be removed due to VOD filters`)
        seriesToSkip.set(seriesKey, { ...seriesData, delete: true })
      }
      continue
    }

    seriesToProcess.set(seriesKey, seriesData)
  }

  // Check NFO language for movies
  const moviesToProcess = new Map()

  for (const [movieKey, channel] of movieItems.entries()) {
    await maybeYield()
    const meta = channel.meta ? (typeof channel.meta === 'string' ? JSON.parse(channel.meta) : channel.meta) : null
    let year = extractYear(channel.tvg_name || '')
    if (!year && meta) {
      year = meta.releaseDate || meta.release_date || meta.year || null
    }

    const baseName = (channel.tvg_name || 'Unknown').replace(/\(\d{4}\)/, '').trim()
    const movieFolder = year ? sanitizeFilename(`${baseName} (${year})`) : sanitizeFilename(baseName)
    const movieDir = join(strmDir, movieFolder)

    // Check NFO language at movie level
    const langCheck = checkNfoFilters(movieDir, vodSettings)

    if (!langCheck.allowed) {
      titlesToBlock.add(channel.tvg_name)
      skippedList.push({
        name: channel.tvg_name,
        group: channel.group_title,
        reason: `Movie filtered: ${langCheck.reason}`
      })
      stats.filtered++

      // If deleteOrphans is enabled, mark for deletion
      if (deleteOrphans && existsSync(movieDir)) {
        console.log(`[strm] Movie "${channel.tvg_name}" will be removed due to VOD filters`)
        moviesToProcess.set(movieKey, { channel, movieDir, delete: true })
      }
      continue
    }

    moviesToProcess.set(movieKey, { channel, movieDir })
  }

  if (deleteOrphans) {
    for (const blockedSeriesKey of blockedSeriesKeys) {
      await maybeYield()
      const existingSeries = Array.from(existing.values()).filter(entry => entry.isSeries && entry.normalizedName === blockedSeriesKey)
      let seriesRootDir = null
      let seriesName = blockedSeriesKey

      if (existingSeries.length > 0) {
        seriesRootDir = dirname(dirname(existingSeries[0].fullStrmPath))
        seriesName = existingSeries[0].seriesName || blockedSeriesKey
      } else {
        const blockedSeries = channels.find(channel => {
          const isSeriesGroup = (channel.group_title || '').startsWith('Series:')
          const seriesInfo = parseSeriesInfo(channel.tvg_name || '')
          return isSeriesGroup && seriesInfo.isSeries && seriesInfo.seriesName.toLowerCase().trim() === blockedSeriesKey
        })

        if (!blockedSeries) continue

        const meta = blockedSeries.meta ? (typeof blockedSeries.meta === 'string' ? JSON.parse(blockedSeries.meta) : blockedSeries.meta) : null
        const year = meta ? (meta.releaseDate || meta.release_date || meta.year || '') : ''
        const folderWithoutYear = sanitizeFilename(parseSeriesInfo(blockedSeries.tvg_name || '').seriesName)
        const folderWithYear = year ? sanitizeFilename(`${parseSeriesInfo(blockedSeries.tvg_name || '').seriesName} (${year})`) : null
        seriesRootDir = folderWithYear && existsSync(join(strmDir, folderWithYear))
          ? join(strmDir, folderWithYear)
          : join(strmDir, folderWithoutYear)
        seriesName = parseSeriesInfo(blockedSeries.tvg_name || '').seriesName
      }

      if (!seriesRootDir || !existsSync(seriesRootDir)) continue

      console.log(`[strm] Series "${seriesName}" will be removed due to blocked title filter`)
      seriesToSkip.set(blockedSeriesKey, {
        seriesName,
        episodes: [],
        folderPath: seriesRootDir,
        delete: true
      })
    }

    for (const blockedMovieKey of blockedMovieKeys) {
      await maybeYield()
      const existingMovie = existing.get(blockedMovieKey)
      let movieDir = null
      let movieTitle = blockedMovieKey

      if (existingMovie) {
        movieDir = dirname(existingMovie.fullStrmPath)
        movieTitle = existingMovie.title || blockedMovieKey
      } else {
        const blockedMovie = channels.find(channel => {
          const matchKey = channel.normalized_name || String(channel.id) || channel.url
          return matchKey === blockedMovieKey
        })

        if (!blockedMovie) continue

        const meta = blockedMovie.meta ? (typeof blockedMovie.meta === 'string' ? JSON.parse(blockedMovie.meta) : blockedMovie.meta) : null
        let year = extractYear(blockedMovie.tvg_name || '')
        if (!year && meta) {
          year = meta.releaseDate || meta.release_date || meta.year || null
        }

        const baseName = (blockedMovie.tvg_name || 'Unknown').replace(/\(\d{4}\)/, '').trim()
        const movieFolder = year ? sanitizeFilename(`${baseName} (${year})`) : sanitizeFilename(baseName)
        movieDir = join(strmDir, movieFolder)
        movieTitle = blockedMovie.tvg_name || blockedMovieKey
      }

      if (!movieDir || !existsSync(movieDir)) continue

      console.log(`[strm] Movie "${movieTitle}" will be removed due to blocked title filter`)
      moviesToProcess.set(blockedMovieKey, {
        channel: { tvg_name: movieTitle },
        movieDir,
        delete: true
      })
    }
  }

  console.log(`[strm] Processing ${seriesToProcess.size} series (${seriesToSkip.size} filtered), ${moviesToProcess.size} movies (${stats.skipped} duplicates, ${movieItems.size - moviesToProcess.size} filtered)`)

  // Build a set of all keys in the NEW dataset (for orphan detection)
  // Use the same key format as existing metadata files (normalized_name from channel)
  const newContentKeys = new Set()
  for (const seriesData of seriesToProcess.values()) {
    await maybeYield()
    for (const ep of seriesData.episodes) {
      await maybeYield()
      // Match the key format from scanExistingFiles: metadata.normalizedName || metadata.normalized_name || metadata.channelId
      const key = ep.normalized_name || String(ep.id)
      newContentKeys.add(key)
    }
  }
  for (const { channel } of moviesToProcess.values()) {
    // Match the key format used in scanExistingFiles: metadata.normalizedName || metadata.normalized_name || metadata.channelId
    // Since buildMetadata writes normalizedName (camelCase), use that
    const key = channel.normalized_name || String(channel.id)
    newContentKeys.add(key)
  }

  // Delete series marked for removal (language filtered with deleteOrphans=true)
  for (const [seriesKey, seriesData] of seriesToSkip.entries()) {
    await maybeYield()
    if (seriesData.delete && existsSync(seriesData.folderPath)) {
      console.log(`[strm] Deleting filtered series: ${seriesData.seriesName}`)
      // Delete all contents recursively
      const deleteRecursive = (dir) => {
        if (!existsSync(dir)) return
        const files = readdirSync(dir)

        for (const file of files) {
          const fullPath = join(dir, file)
          if (statSync(fullPath).isDirectory()) {
            deleteRecursive(fullPath)
          } else {
            unlinkSync(fullPath)
          }
        }
        // Only delete if managed
        if (isManagedFolder(dir)) {
          try {
            rmdirSync(dir)
            console.log(`[strm] Deleted series directory: ${dir}`)
            stats.deleted++
          } catch (e) {
            console.warn(`[strm] Could not delete directory: ${dir} - ${e.message}`)
          }
        } else {
          console.log(`[strm] Skipping unmanaged directory: ${dir}`)
        }
      }
      deleteRecursive(seriesData.folderPath)
    }
  }

  // Process series episodes
  for (const [seriesKey, seriesData] of seriesToProcess.entries()) {
    await maybeYield()
    const seriesRootDir = seriesData.folderPath
    const meta = seriesData.episodes[0].meta ?
      (typeof seriesData.episodes[0].meta === 'string' ? JSON.parse(seriesData.episodes[0].meta) : seriesData.episodes[0].meta) : null

    // Ensure series root directory exists
    if (!existsSync(seriesRootDir)) {
      mkdirSync(seriesRootDir, { recursive: true })
    }

    // Create marker file in series root folder
    const seriesMarkerPath = join(seriesRootDir, METADATA_EXT)
    if (!existsSync(seriesMarkerPath)) {
      const seriesMetadata = {
        type: 'series',
        name: seriesData.seriesName,
        year: seriesData.year,
        episodeCount: seriesData.episodes.length,
        lastUpdated: new Date().toISOString()
      }
      writeFileSync(seriesMarkerPath, JSON.stringify(seriesMetadata, null, 2), 'utf8')
    }

    // Create/update tvshow.nfo
    const tvshowNfoPath = join(seriesRootDir, 'tvshow.nfo')
    const year = seriesData.year || ''
    const plot = meta?.plot || ''
    const tvshowNfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>${escapeXml(seriesData.seriesName)}</title>
  ${year ? `<year>${escapeXml(year)}</year>` : ''}
  ${plot ? `<plot>${escapeXml(plot)}</plot>` : ''}
  <episode>${seriesData.episodes.length}</episode>
</tvshow>`
    writeFileSync(tvshowNfoPath, tvshowNfo, 'utf8')

    // Process each episode
    for (const channel of seriesData.episodes) {
      await maybeYield()
      const seriesInfo = parseSeriesInfo(channel.tvg_name || '')
      if (!seriesInfo.isSeries) continue

      const seasonFolder = `Season ${String(seriesInfo.season).padStart(2, '0')}`
      const seasonDir = join(seriesRootDir, seasonFolder)

      // Create season directory
      if (!existsSync(seasonDir)) {
        mkdirSync(seasonDir, { recursive: true })
      }

      // Force .ts extension for VOD URLs
      let channelUrl = channel.url
      if (channelUrl && !channelUrl.endsWith('.ts')) {
        channelUrl = channelUrl.replace(/\.(mkv|mp4|avi|m4v)$/i, '.ts')
      }

      const proxyUrl = `${baseUrl}/stream/${channel.id}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`

      const filename = buildFilename(channel)
      const metadataFilename = filename.replace('.strm', METADATA_EXT)
      const strmPath = join(seasonDir, filename)
      const metadataPath = join(seasonDir, metadataFilename)

      const metadata = buildMetadata(channel, playlistId, proxyUrl)
      const nfoContent = buildNfoContent(channel, seriesInfo)

      // Match key format from scanExistingFiles: metadata.normalizedName || metadata.normalized_name || metadata.channelId
      const lookupKey = channel.normalized_name || String(channel.id)
      const existingEntry = existing.get(lookupKey)

      try {
        if (existingEntry) {
          const oldStrmPath = existingEntry.fullStrmPath
          const oldMetadataPath = existingEntry.fullMetadataPath
          const oldUrl = readFileSync(oldStrmPath, 'utf8').trim()

          if (oldUrl !== proxyUrl) {
            console.log(`[strm] Updating URL for: ${existingEntry.strmFile}`)
            writeFileSync(oldStrmPath, proxyUrl, 'utf8')
            writeFileSync(oldMetadataPath, JSON.stringify(metadata, null, 2), 'utf8')
            stats.updated++
          }
        } else {
          console.log(`[strm] Creating: ${filename}`)
          writeFileSync(strmPath, proxyUrl, 'utf8')
          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
          // Episode NFO in season folder
          const episodeNfoPath = join(seasonDir, filename.replace('.strm', '.nfo'))
          if (!existsSync(episodeNfoPath)) {
            writeFileSync(episodeNfoPath, nfoContent, 'utf8')
          }
          stats.created++
        }
      } catch (e) {
        console.error(`[strm] Error processing ${channel.tvg_name}:`, e.message)
        errorList.push({ name: channel.tvg_name, error: e.message })
        stats.errors++
      }
    }
  }

  // Process movies
  for (const [movieKey, movieData] of moviesToProcess.entries()) {
    await maybeYield()
    const { channel, movieDir, delete: shouldDelete } = movieData

    // Delete if marked for removal
    if (shouldDelete && existsSync(movieDir)) {
      console.log(`[strm] Deleting filtered movie: ${channel.tvg_name}`)
      const wasManagedFolder = isManagedFolder(movieDir)
      const files = readdirSync(movieDir)
      for (const file of files) {
        unlinkSync(join(movieDir, file))
      }
      if (wasManagedFolder) {
        rmdirSync(movieDir)
        console.log(`[strm] Deleted movie directory: ${movieDir}`)
        stats.deleted++
      }
      continue
    }

    // Ensure movie directory exists
    if (!existsSync(movieDir)) {
      mkdirSync(movieDir, { recursive: true })
    }

    // Force .ts extension for VOD URLs
    let channelUrl = channel.url
    if (channelUrl && !channelUrl.endsWith('.ts')) {
      channelUrl = channelUrl.replace(/\.(mkv|mp4|avi|m4v)$/i, '.ts')
    }

    const proxyUrl = `${baseUrl}/stream/${channel.id}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`

    const filename = buildFilename(channel)
    const metadataFilename = filename.replace('.strm', METADATA_EXT)
    const strmPath = join(movieDir, filename)
    const metadataPath = join(movieDir, metadataFilename)

    const metadata = buildMetadata(channel, playlistId, proxyUrl)
    const seriesInfo = parseSeriesInfo(channel.tvg_name || '')
    const nfoContent = buildNfoContent(channel, seriesInfo)

    // Create movie.nfo if doesn't exist
    const movieNfoPath = join(movieDir, 'movie.nfo')
    if (!existsSync(movieNfoPath)) {
      writeFileSync(movieNfoPath, nfoContent, 'utf8')
    }

    // Match key format from scanExistingFiles: metadata.normalizedName (camelCase)
    // The existing Map uses normalizedName from old metadata files
    const lookupKey = channel.normalized_name || String(channel.id)
    const existingEntry = existing.get(lookupKey)

    try {
      if (existingEntry) {
        const oldStrmPath = existingEntry.fullStrmPath
        const oldMetadataPath = existingEntry.fullMetadataPath
        const oldUrl = readFileSync(oldStrmPath, 'utf8').trim()

        if (oldUrl !== proxyUrl) {
          console.log(`[strm] Updating URL for: ${existingEntry.strmFile}`)
          writeFileSync(oldStrmPath, proxyUrl, 'utf8')
          writeFileSync(oldMetadataPath, JSON.stringify(metadata, null, 2), 'utf8')
          stats.updated++
        }
      } else {
        console.log(`[strm] Creating: ${filename}`)
        writeFileSync(strmPath, proxyUrl, 'utf8')
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
        stats.created++
      }
    } catch (e) {
      console.error(`[strm] Error processing ${channel.tvg_name}:`, e.message)
      errorList.push({ name: channel.tvg_name, error: e.message })
      stats.errors++
    }
  }

  // Delete orphaned files (not in new dataset)
  const deletedDirs = new Set()
  if (deleteOrphans) {
    console.log(`[strm] Checking for orphaned files to delete...`)
    for (const [existingKey, entry] of existing.entries()) {
      await maybeYield()
      if (!newContentKeys.has(existingKey)) {
        console.log(`[strm] Deleting: ${entry.strmFile} (no longer in playlist)`)
        try {
          unlinkSync(entry.fullStrmPath)
          unlinkSync(entry.fullMetadataPath)
          stats.deleted++

          // Track parent directory for cleanup
          const parentDir = dirname(entry.fullStrmPath)
          deletedDirs.add(parentDir)
        } catch (e) {
          console.error(`[strm] Error deleting ${entry.strmFile}:`, e.message)
          stats.errors++
        }
      }
    }
  } else {
    console.log(`[strm] Skipping orphan deletion (deleteOrphans=false)`)
  }

  // Clean up empty directories using safe deletion
  for (const dir of deletedDirs) {
    await maybeYield()
    safeDeleteManagedDir(dir, deletedDirs)

    // Check parent directory for series (season's parent is series root)
    const parentDir = dirname(dir)
    if (parentDir !== strmDir && existsSync(parentDir)) {
      safeDeleteManagedDir(parentDir, deletedDirs)
    }
  }

  // Clean up orphaned folders at top level
  try {
    const allItems = readdirSync(strmDir)
    for (const item of allItems) {
      await maybeYield()
      const itemPath = join(strmDir, item)
      if (!statSync(itemPath).isDirectory()) continue

      // Only delete if managed and empty
      safeDeleteManagedDir(itemPath, deletedDirs)
    }
  } catch (e) {
    console.error(`[strm] Error cleaning folders:`, e.message)
  }

  const blockedTitlesAdded = persistBlockedTitles(db, Array.from(titlesToBlock))
  if (blockedTitlesAdded > 0) {
    console.log(`[strm] Added ${blockedTitlesAdded} title(s) to VOD blocked titles`)
  }

  db.close()

  console.log(`[strm] Export complete:`, stats)

  // Rebuild NFO index to pick up newly exported NFO files
  try {
    const { rebuildNfoIndex } = await import('./nfo-index.js')
    rebuildNfoIndex()
  } catch (e) {
    console.error(`[strm] Failed to rebuild NFO index:`, e.message)
  }

  // Write skipped items to CSV file
  if (skippedList.length > 0) {
    const csvPath = join(strmDir, 'skipped-items.csv')
    const csvHeader = 'Name,Group,Reason\n'
    const csvRows = skippedList.map(item => {
      // Escape commas and quotes in CSV
      const escapeCsv = (str) => {
        if (!str) return ''
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }
      return `${escapeCsv(item.name)},${escapeCsv(item.group)},${escapeCsv(item.reason)}`
    }).join('\n')

    writeFileSync(csvPath, csvHeader + csvRows, 'utf8')
    console.log(`[strm] Wrote ${skippedList.length} skipped items to: ${csvPath}`)
  }

  // Print error summary if there were errors
  if (errorList.length > 0) {
    console.log(`\n[strm] Error Summary (${errorList.length} errors):`)
    const errorGroups = new Map()

    // Group errors by error message
    for (const { name, error } of errorList) {
      if (!errorGroups.has(error)) {
        errorGroups.set(error, [])
      }
      errorGroups.get(error).push(name)
    }

    // Print grouped errors
    for (const [error, names] of errorGroups) {
      console.log(`\n  ${error} (${names.length} occurrences)`)
      // Show first 5 examples
      const examples = names.slice(0, 5)
      for (const name of examples) {
        console.log(`    - ${name}`)
      }
      if (names.length > 5) {
        console.log(`    ... and ${names.length - 5} more`)
      }
    }
  }

  return stats
}

export function getStrmExportStats() {
  if (!existsSync(STRM_DIR)) {
    return { totalFiles: 0, totalSize: 0, lastExport: null }
  }

  const files = readdirSync(STRM_DIR)
  const strmFiles = files.filter(f => f.endsWith('.strm'))

  let lastExport = null
  for (const file of files) {
    if (file.endsWith(METADATA_EXT)) {
      try {
        const metadata = JSON.parse(readFileSync(join(STRM_DIR, file), 'utf8'))
        const updated = new Date(metadata.lastUpdated)
        if (!lastExport || updated > lastExport) {
          lastExport = updated
        }
      } catch (e) {
        // Ignore
      }
    }
  }

  return {
    totalFiles: strmFiles.length,
    exportDir: STRM_DIR,
    lastExport: lastExport ? lastExport.toISOString() : null,
  }
}
