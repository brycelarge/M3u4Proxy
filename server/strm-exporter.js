/**
 * Smart STRM Exporter for VOD Playlists
 *
 * Creates .strm files with metadata sidecars (.m3u4.json) for Jellyfin/Plex integration
 * Handles renames, updates, and deletions intelligently
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, statSync, rmdirSync } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'
import Database from 'better-sqlite3'

const STRM_BASE_DIR = process.env.STRM_EXPORT_DIR || '/data/vod-strm'
const METADATA_EXT = '.m3u4prox.json'

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

  const map = new Map() // normalizedName -> { strmFile, metadataFile, metadata, relativePath }

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

      const metadataPath = fullPath
      const strmFile = file.replace(METADATA_EXT, '')
      const strmPath = join(dir, strmFile)

      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))

        if (existsSync(strmPath)) {
          // Use normalized_name as key for matching across provider changes
          const key = metadata.normalizedName || metadata.channelId
          map.set(key, {
            strmFile,
            metadataFile: file,
            metadata,
            relativePath: relativePath || null,
            fullStrmPath: strmPath,
            fullMetadataPath: metadataPath
          })
        } else {
          // Orphaned metadata file - delete it
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

export async function exportVodToStrm(playlistId, baseUrl, username, password) {
  console.log(`[strm] Starting export for playlist ${playlistId}`)

  const db = new Database(process.env.DB_PATH || '/data/db/m3u-manager.db')

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
    // Query source_channels directly using stored group selections
    console.log(`[strm] Using stored group selections to query fresh data from source_channels`)
    const { sourceId, groups } = groupSelections

    for (const [groupName, sel] of Object.entries(groups)) {
      if (!sel || (Array.isArray(sel) && sel.length === 0)) continue

      let rows = []
      if (sel === '__all__') {
        if (sourceId === null || sourceId === undefined) {
          // All sources mode — match by group_title suffix
          const parts = groupName.split(' › ')
          const gt = parts.length > 1 ? parts[parts.length - 1] : groupName
          rows = db.prepare('SELECT *, id as channel_id FROM source_channels WHERE group_title = ?').all(gt)
        } else {
          rows = db.prepare('SELECT *, id as channel_id FROM source_channels WHERE source_id = ? AND group_title = ?').all(sourceId, groupName)
        }
      } else {
        // Array of specific channel IDs - but for STRM export, we want all channels in the group
        // So we'll get the group name from the first channel and query all channels in that group
        if (Array.isArray(sel) && sel.length > 0) {
          const firstCh = db.prepare('SELECT group_title, source_id FROM source_channels WHERE id = ?').get(sel[0])
          if (firstCh) {
            rows = db.prepare('SELECT *, id as channel_id FROM source_channels WHERE source_id = ? AND group_title = ?').all(firstCh.source_id, firstCh.group_title)
          }
        }
      }

      // Add meta and normalized_name (already in source_channels)
      channels.push(...rows)
    }

    console.log(`[strm] Found ${channels.length} channels from selected groups in source_channels`)
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
        sc.normalized_name,
        pc.id as channel_id
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
  const processed = new Set()
  let stats = { created: 0, updated: 0, deleted: 0, errors: 0, skipped: 0, directory: strmDir }
  const errorList = []
  const skippedList = []

  // Build deduplicated dataset first
  // For series: use full tvg_name (includes S01E01) to keep all episodes
  // For movies: use normalized_name to remove duplicates across categories
  const uniqueContent = new Map()

  for (const channel of channels) {
    const isSeriesGroup = (channel.group_title || '').startsWith('Series:')
    const seriesInfo = parseSeriesInfo(channel.tvg_name || '')

    // For series episodes, use full name to keep each episode unique
    // For movies, use normalized name to deduplicate across categories
    const matchKey = (isSeriesGroup && seriesInfo.isSeries)
      ? channel.tvg_name
      : (channel.normalized_name || String(channel.id))

    if (!uniqueContent.has(matchKey)) {
      uniqueContent.set(matchKey, channel)
    } else {
      skippedList.push({
        name: channel.tvg_name,
        group: channel.group_title,
        reason: 'Duplicate'
      })
      stats.skipped++
      if (process.env.DEBUG) {
        console.log(`[strm] Skipping duplicate: "${channel.tvg_name}" (already have "${uniqueContent.get(matchKey).tvg_name}")`)
      }
    }
  }

  console.log(`[strm] Processing ${uniqueContent.size} unique items (${stats.skipped} duplicates skipped)`)

  // Build a set of all normalized names in the NEW dataset
  const newContentKeys = new Set(uniqueContent.keys())

  // Now process the deduplicated dataset
  for (const [matchKey, channel] of uniqueContent.entries()) {
    const channelId = String(channel.id)

    const proxyUrl = `${baseUrl}/stream/${channel.id}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const seriesInfo = parseSeriesInfo(channel.tvg_name || '')

    // Check if this is a series based on group_title prefix OR filename pattern
    const isSeriesGroup = (channel.group_title || '').startsWith('Series:')

    // Skip series without proper season/episode info
    if (isSeriesGroup && !seriesInfo.isSeries) {
      if (process.env.DEBUG) {
        console.log(`[strm] Skipping series without S01E01 pattern: "${channel.tvg_name}"`)
      }
      skippedList.push({
        name: channel.tvg_name,
        group: channel.group_title,
        reason: 'No S01E01 pattern'
      })
      stats.skipped++
      continue
    }

    // Determine target directory and track if it's a new folder
    let targetDir = strmDir
    let isNewFolder = false

    if (seriesInfo.isSeries) {
      // Series: Create Series/Season folders (with year only if meta exists and has year)
      const meta = channel.meta ? (typeof channel.meta === 'string' ? JSON.parse(channel.meta) : channel.meta) : null
      const year = meta ? (meta.releaseDate || meta.release_date || meta.year || '') : ''

      const baseName = seriesInfo.seriesName
      const folderWithoutYear = sanitizeFilename(baseName)
      const folderWithYear = year && meta ? sanitizeFilename(`${baseName} (${year})`) : null
      const seasonFolder = `Season ${String(seriesInfo.season).padStart(2, '0')}`

      // Check which series folder exists (prefer existing folder to avoid duplicates)
      const pathWithoutYear = join(strmDir, folderWithoutYear, seasonFolder)
      const pathWithYear = folderWithYear ? join(strmDir, folderWithYear, seasonFolder) : null

      if (existsSync(join(strmDir, folderWithoutYear))) {
        // Use existing series folder without year
        targetDir = pathWithoutYear
      } else if (folderWithYear && existsSync(join(strmDir, folderWithYear))) {
        // Use existing series folder with year
        targetDir = pathWithYear
      } else {
        // Create new folder (with year if we have metadata)
        targetDir = (year && meta) ? pathWithYear : pathWithoutYear
      }

      // Create target directory if it doesn't exist (handles new series AND new seasons)
      if (!existsSync(targetDir)) {
        isNewFolder = !existsSync(dirname(targetDir)) // Only mark as new if series folder is new
        mkdirSync(targetDir, { recursive: true })
        console.log(`[strm] Created directory: ${targetDir}`)
      }
    } else {
      // Movies: Create individual folder per movie
      const meta = channel.meta ? (typeof channel.meta === 'string' ? JSON.parse(channel.meta) : channel.meta) : null
      let year = extractYear(channel.tvg_name || '')

      // If no year in name, try metadata
      if (!year && meta) {
        year = meta.releaseDate || meta.release_date || meta.year || null
      }

      const baseName = (channel.tvg_name || 'Unknown').replace(/\(\d{4}\)/, '').trim()
      const movieFolder = year ? sanitizeFilename(`${baseName} (${year})`) : sanitizeFilename(baseName)
      targetDir = join(strmDir, movieFolder)

      // Create movie directory
      if (!existsSync(targetDir)) {
        isNewFolder = true
        mkdirSync(targetDir, { recursive: true })
      }
    }

    const filename = buildFilename(channel)
    const metadataFilename = filename.replace('.strm', METADATA_EXT)
    const strmPath = join(targetDir, filename)
    const metadataPath = join(targetDir, metadataFilename)

    const metadata = buildMetadata(channel, playlistId, proxyUrl)
    const nfoContent = buildNfoContent(channel, seriesInfo)

    // Determine NFO path and whether to create it
    // For series: tvshow.nfo goes in series root folder (not season folder)
    // For movies: movie.nfo goes in movie folder
    let nfoPath = null
    let shouldCreateNfo = false

    if (seriesInfo.isSeries) {
      // Series: tvshow.nfo in series root folder
      const seriesRootDir = dirname(targetDir) // Go up from season folder to series folder
      nfoPath = join(seriesRootDir, 'tvshow.nfo')
      // Only create if it doesn't exist (never overwrite Jellyfin's enriched data)
      shouldCreateNfo = !existsSync(nfoPath)
    } else {
      // Movie: movie.nfo in movie folder
      nfoPath = join(targetDir, 'movie.nfo')
      // Only create if it doesn't exist (never overwrite Jellyfin's enriched data)
      shouldCreateNfo = !existsSync(nfoPath)
    }
    const existingEntry = existing.get(matchKey)

    try {
      if (existingEntry) {
        // Channel exists - check if update needed
        const oldStrmPath = existingEntry.fullStrmPath
        const oldMetadataPath = existingEntry.fullMetadataPath

        // Log if we matched by normalized name (provider switch)
        if (existingEntry.metadata.channelId !== channelId && channel.normalized_name) {
          console.log(`[strm] Provider switch detected: "${channel.tvg_name}" (old ID: ${existingEntry.metadata.channelId} → new ID: ${channelId})`)
        }

        // Check if filename or path changed (user renamed, title changed, or moved to season folder)
        if (oldStrmPath !== strmPath) {
          console.log(`[strm] Moving/Renaming: ${existingEntry.strmFile} → ${filename}`)
          unlinkSync(oldStrmPath)
          unlinkSync(oldMetadataPath)
          writeFileSync(strmPath, proxyUrl, 'utf8')
          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
          // Only write NFO if new folder or NFO doesn't exist
          if (shouldCreateNfo) {
            writeFileSync(nfoPath, nfoContent, 'utf8')
          }
          stats.updated++
        } else {
          // Check if URL changed
          const oldUrl = readFileSync(oldStrmPath, 'utf8').trim()
          if (oldUrl !== proxyUrl) {
            console.log(`[strm] Updating URL for: ${filename}`)
            writeFileSync(strmPath, proxyUrl, 'utf8')
            writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
            stats.updated++
          }
        }
      } else {
        // New channel - create files (NFO only if new folder or doesn't exist)
        console.log(`[strm] Creating: ${filename}`)
        writeFileSync(strmPath, proxyUrl, 'utf8')
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
        if (shouldCreateNfo) {
          writeFileSync(nfoPath, nfoContent, 'utf8')
        }
        stats.created++
      }
    } catch (e) {
      console.error(`[strm] Error processing ${channel.tvg_name}:`, e.message)
      errorList.push({ name: channel.tvg_name, error: e.message })
      stats.errors++
    }
  }

  // Delete files that exist on disk but are NOT in the new dataset
  // This handles: removed content, provider switches where content doesn't exist
  const deletedDirs = new Set()
  for (const [existingKey, entry] of existing.entries()) {
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

  // Clean up empty directories (movies, seasons, series)
  for (const dir of deletedDirs) {
    try {
      // Check if directory is empty
      const files = readdirSync(dir)
      if (files.length === 0) {
        rmdirSync(dir)
        console.log(`[strm] Removed empty directory: ${dir}`)

        // Also check parent directory (for series folders after removing last season)
        const parentDir = dirname(dir)
        if (parentDir !== strmDir && existsSync(parentDir)) {
          const parentFiles = readdirSync(parentDir)
          if (parentFiles.length === 0) {
            rmdirSync(parentDir)
            console.log(`[strm] Removed empty parent directory: ${parentDir}`)
          }
        }
      }
    } catch (e) {
      // Ignore errors - directory might not be empty or already deleted
    }
  }

  // Clean up orphaned folders (folders without any .m3u4prox.json metadata files)
  // This handles content from old exports before metadata tracking was added
  function hasMetadataInTree(dirPath) {
    const items = readdirSync(dirPath)
    for (const item of items) {
      const itemPath = join(dirPath, item)
      const stat = statSync(itemPath)

      if (stat.isFile() && item.endsWith(METADATA_EXT)) {
        return true
      }
      if (stat.isDirectory()) {
        if (hasMetadataInTree(itemPath)) {
          return true
        }
      }
    }
    return false
  }

  function deleteRecursive(dirPath) {
    const items = readdirSync(dirPath)
    for (const item of items) {
      const itemPath = join(dirPath, item)
      const stat = statSync(itemPath)

      if (stat.isDirectory()) {
        deleteRecursive(itemPath)
        rmdirSync(itemPath)
      } else {
        unlinkSync(itemPath)
      }
    }
  }

  try {
    const allItems = readdirSync(strmDir)
    for (const item of allItems) {
      const itemPath = join(strmDir, item)
      if (!statSync(itemPath).isDirectory()) continue

      // Check if folder tree has any metadata files (recursively)
      const hasMetadata = hasMetadataInTree(itemPath)

      if (!hasMetadata) {
        // Folder has no metadata anywhere in tree - it's orphaned from old export
        console.log(`[strm] Removing orphaned folder (no metadata): ${item}`)
        deleteRecursive(itemPath)
        rmdirSync(itemPath)
        stats.deleted++
      }
    }
  } catch (e) {
    console.error(`[strm] Error cleaning orphaned folders:`, e.message)
  }

  db.close()

  console.log(`[strm] Export complete:`, stats)

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
