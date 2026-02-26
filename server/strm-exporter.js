/**
 * Smart STRM Exporter for VOD Playlists
 *
 * Creates .strm files with metadata sidecars (.m3u4.json) for Jellyfin/Plex integration
 * Handles renames, updates, and deletions intelligently
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
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

function buildFilename(channel) {
  const name = channel.tvg_name || 'Unknown'
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

  const files = readdirSync(strmDir)
  const map = new Map() // channelId -> { strmFile, metadataFile, metadata }

  for (const file of files) {
    if (!file.endsWith(METADATA_EXT)) continue

    const metadataPath = join(strmDir, file)
    const strmFile = file.replace(METADATA_EXT, '')
    const strmPath = join(strmDir, strmFile)

    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))

      if (existsSync(strmPath)) {
        map.set(metadata.channelId, {
          strmFile,
          metadataFile: file,
          metadata,
        })
      } else {
        // Orphaned metadata file - delete it
        unlinkSync(metadataPath)
      }
    } catch (e) {
      console.error(`[strm] Failed to read metadata ${file}:`, e.message)
    }
  }

  return map
}

export async function exportVodToStrm(playlistId, baseUrl, username, password) {
  console.log(`[strm] Starting export for playlist ${playlistId}`)

  const db = new Database(process.env.DB_PATH || '/data/db/m3u4prox.db')

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

    const proxyUrl = `${baseUrl}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${channel.id}`
    const filename = buildFilename(channel)
    const metadataFilename = filename.replace('.strm', METADATA_EXT)
    const strmPath = join(strmDir, filename)
    const metadataPath = join(strmDir, metadataFilename)

    const metadata = buildMetadata(channel, playlistId, proxyUrl)
    const existingEntry = existing.get(channelId)

    try {
      if (existingEntry) {
        // Channel exists - check if update needed
        const oldStrmPath = join(strmDir, existingEntry.strmFile)
        const oldMetadataPath = join(strmDir, existingEntry.metadataFile)

        // Check if filename changed (user renamed or title changed)
        if (existingEntry.strmFile !== filename) {
          console.log(`[strm] Renaming: ${existingEntry.strmFile} → ${filename}`)
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
        unlinkSync(join(strmDir, entry.strmFile))
        unlinkSync(join(strmDir, entry.metadataFile))
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
