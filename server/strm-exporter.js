/**
 * Smart STRM Exporter for VOD Playlists
 *
 * Creates .strm files with metadata sidecars (.m3u4.json) for Jellyfin/Plex integration
 * Handles renames, updates, and deletions intelligently
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
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
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
    .replace(/\s+/g, ' ')          // Normalize spaces
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

  const year = extractYear(name)
  if (year) {
    return sanitizeFilename(name) + '.strm'
  }

  return sanitizeFilename(name) + '.strm'
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
    lastUpdated: new Date().toISOString(),
  }
}

function scanExistingFiles(strmDir) {
  if (!existsSync(strmDir)) {
    mkdirSync(strmDir, { recursive: true })
    return new Map()
  }

  const map = new Map() // channelId -> { strmFile, metadataFile, metadata, relativePath }

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
          map.set(metadata.channelId, {
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

  const channels = db.prepare(`
    SELECT * FROM playlist_channels
    WHERE playlist_id = ?
    ORDER BY tvg_name
  `).all(playlistId)

  if (channels.length === 0) {
    console.log(`[strm] No VOD channels found in playlist ${playlistId}`)
    db.close()
    return { created: 0, updated: 0, deleted: 0, errors: 0 }
  }

  const strmDir = getPlaylistStrmDir(playlist.name)
  console.log(`[strm] Using directory: ${strmDir}`)

  const existing = scanExistingFiles(strmDir)
  const processed = new Set()
  let stats = { created: 0, updated: 0, deleted: 0, errors: 0, directory: strmDir }

  // Process each channel
  for (const channel of channels) {
    const channelId = String(channel.id)
    processed.add(channelId)

    const proxyUrl = `${baseUrl}/stream/${channel.id}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const seriesInfo = parseSeriesInfo(channel.tvg_name || '')

    // Determine target directory (with season folder for series)
    let targetDir = strmDir
    if (seriesInfo.isSeries) {
      const seriesFolder = sanitizeFilename(seriesInfo.seriesName)
      const seasonFolder = `Season ${String(seriesInfo.season).padStart(2, '0')}`
      targetDir = join(strmDir, seriesFolder, seasonFolder)

      // Create series/season directory structure
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true })
        console.log(`[strm] Created directory: ${targetDir}`)
      }
    }

    const filename = buildFilename(channel)
    const metadataFilename = filename.replace('.strm', METADATA_EXT)
    const strmPath = join(targetDir, filename)
    const metadataPath = join(targetDir, metadataFilename)

    const metadata = buildMetadata(channel, playlistId, proxyUrl)
    const existingEntry = existing.get(channelId)

    try {
      if (existingEntry) {
        // Channel exists - check if update needed
        const oldStrmPath = existingEntry.fullStrmPath
        const oldMetadataPath = existingEntry.fullMetadataPath

        // Check if filename or path changed (user renamed, title changed, or moved to season folder)
        if (oldStrmPath !== strmPath) {
          console.log(`[strm] Moving/Renaming: ${existingEntry.strmFile} → ${filename}`)
          unlinkSync(oldStrmPath)
          unlinkSync(oldMetadataPath)
          writeFileSync(strmPath, proxyUrl, 'utf8')
          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
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
        // New channel - create files
        console.log(`[strm] Creating: ${filename}`)
        writeFileSync(strmPath, proxyUrl, 'utf8')
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
        stats.created++
      }
    } catch (e) {
      console.error(`[strm] Error processing ${channel.tvg_name}:`, e.message)
      stats.errors++
    }
  }

  // Delete files for channels no longer in playlist
  for (const [channelId, entry] of existing.entries()) {
    if (!processed.has(channelId)) {
      console.log(`[strm] Deleting removed channel: ${entry.strmFile}`)
      try {
        unlinkSync(entry.fullStrmPath)
        unlinkSync(entry.fullMetadataPath)
        stats.deleted++
      } catch (e) {
        console.error(`[strm] Error deleting ${entry.strmFile}:`, e.message)
        stats.errors++
      }
    }
  }

  db.close()

  console.log(`[strm] Export complete:`, stats)
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
