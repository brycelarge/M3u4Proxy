import { readFileSync, existsSync } from 'node:fs'
import db from '../db.js'
import { GUIDE_XML } from '../epgGrab.js'
import { fetchAndParseM3U, fetchXtreamChannels, shouldSkipByRules } from '../m3uBuilder.js'
import { clearCache } from './cache.js'
import { getVodSettings } from '../routes/settings.js'
import { invalidateAllPlaylistXmltvCache, invalidatePlaylistsForSource } from './xmltvCache.js'

const DEFAULT_DETECTED_GENRES = ['Action', 'Comedy', 'Drama', 'Documentary', 'Horror', 'Romance', 'Sci-Fi', 'Thriller']
const EVENT_LOOP_YIELD_INTERVAL = 250

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve))
}

function normalizeVodGenres(value) {
  if (!value) return []

  const normalizeGenre = (genreValue) => {
    if (!genreValue) return null
    const genre = String(genreValue)
      .replace(/^(Movie|Series):\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    return genre || null
  }

  const values = Array.isArray(value) ? value : [value]
  const genres = new Map()

  for (const item of values) {
    for (const genre of String(item).split(/[\/,]/).map(v => normalizeGenre(v)).filter(Boolean)) {
      genres.set(genre.toLowerCase(), genre)
    }
  }

  return Array.from(genres.values())
}

// Helper to check if a channel should be filtered by VOD settings
function shouldFilterVodChannel(channelName, genres, vodSettings) {
  if (!channelName) return false

  const nameLower = channelName.toLowerCase()

  // Check blocked titles
  if (vodSettings.vod_blocked_titles?.length > 0) {
    for (const blocked of vodSettings.vod_blocked_titles) {
      if (blocked && nameLower.includes(blocked.toLowerCase())) {
        return true
      }
    }
  }

  if (
    Array.isArray(genres) &&
    genres.length > 0 &&
    vodSettings.vod_genre_filter_mode &&
    vodSettings.vod_genre_filter_mode !== 'disabled' &&
    Array.isArray(vodSettings.vod_allowed_genres) &&
    vodSettings.vod_allowed_genres.length > 0
  ) {
    const allowedGenres = new Set(vodSettings.vod_allowed_genres.map(value => String(value).toLowerCase()))
    const hasDisallowedGenre = genres.some(genre => !allowedGenres.has(String(genre).toLowerCase()))
    if (hasDisallowedGenre) {
      return true
    }
  }

  return false
}

function extractVodGenres(channel, contentType) {
  if (contentType !== 'movie' && contentType !== 'series' && contentType !== 'vod') return []

  const meta = channel?.meta && typeof channel.meta === 'object' ? channel.meta : null
  const metaGenre = meta?.genre || meta?.genres || meta?.category_name || meta?.category
  const groupTitle = String(channel?.group_title || '')

  if (contentType === 'vod' && !/^Movie:\s*|^Series:\s*/i.test(groupTitle)) {
    return []
  }

  if (Array.isArray(metaGenre)) {
    for (const item of metaGenre) {
      const parsed = normalizeVodGenres(item)
      if (parsed.length > 0) return parsed
    }
  }

  if (typeof metaGenre === 'string') {
    const parsed = normalizeVodGenres(metaGenre)
    if (parsed.length > 0) return parsed
  }

  return normalizeVodGenres(groupTitle)
}

async function buildPreparedChannelArrays(channelArrays, cleanupRules, skipRules, vodSettings, sourceName) {
  const detectedGenres = new Set(DEFAULT_DETECTED_GENRES)
  const preparedChannelArrays = []
  let processedCount = 0

  for (const { contentType, channels: channelList } of channelArrays) {
    const seenUrls = new Map()
    const preparedChannels = []

    for (const ch of channelList) {
      processedCount++
      if (processedCount % EVENT_LOOP_YIELD_INTERVAL === 0) {
        await yieldToEventLoop()
      }

      const isLiveTv = contentType === 'live'
      let channelName = ch.tvg_name || ''

      for (const rule of cleanupRules) {
        try {
          if (rule.useRegex) {
            const regex = new RegExp(rule.find, rule.flags || 'gi')
            channelName = channelName.replace(regex, rule.replace || '')
          } else {
            const regex = new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
            channelName = channelName.replace(regex, rule.replace || '')
          }
        } catch (e) {
          console.error(`[source] Cleanup rule failed for "${sourceName}":`, e.message)
        }
      }

      if (shouldSkipByRules(channelName, skipRules)) {
        if (process.env.DEBUG) {
          console.log(`[source] Skipping "${channelName}" - matched skip rule`)
        }
        continue
      }

      const genres = extractVodGenres(ch, contentType)

      if (!isLiveTv && shouldFilterVodChannel(channelName, genres, vodSettings)) {
        if (process.env.DEBUG) {
          console.log(`[source] Filtering VOD "${channelName}" (${genres.join(', ') || 'no genre'}) by VOD settings`)
        }
        continue
      }

      for (const genre of genres) {
        detectedGenres.add(genre)
      }

      const { cleanedName, quality } = extractQuality(channelName.trim())
      const normalizedName = normalizeChannelName(cleanedName)

      if (isLiveTv && seenUrls.has(ch.url)) {
        if (process.env.DEBUG) {
          console.log(`[source] Skipping duplicate URL: "${cleanedName}" (same as "${seenUrls.get(ch.url)}")`)
        }
        continue
      }

      if (isLiveTv) {
        seenUrls.set(ch.url, cleanedName)
      }

      preparedChannels.push({
        contentType,
        tvgId: ch.tvg_id || '',
        cleanedName,
        tvgLogo: ch.tvg_logo || '',
        groupTitle: ch.group_title || 'Ungrouped',
        url: ch.url,
        rawExtinf: ch.raw_extinf || '',
        quality,
        normalizedName,
        metaJson: ch.meta ? JSON.stringify(ch.meta) : null,
      })
    }

    preparedChannelArrays.push({ contentType, channels: preparedChannels })
  }

  return {
    preparedChannelArrays,
    detectedGenres: Array.from(detectedGenres).sort((a, b) => a.localeCompare(b)),
  }
}

export async function refreshSourceCache(sourceId) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source) throw new Error('Source not found')

  // EPG source — read guide.xml from disk (our own output) or fetch remote URL
  if (source.category === 'epg') {
    let content
    // If the URL points to ourselves, read from disk directly to avoid circular HTTP
    const selfHosts = ['localhost', '127.0.0.1', '0.0.0.0']
    let isLocal = false
    try { isLocal = selfHosts.some(h => new URL(source.url).hostname === h) } catch {}

    if (isLocal) {
      if (!existsSync(GUIDE_XML)) {
        throw new Error('guide.xml not yet generated — run an EPG grab first from the EPG Scraper page')
      }
      content = readFileSync(GUIDE_XML, 'utf8')
    } else {
      const resp = await fetch(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; M3UManager/1.0)' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching EPG from ${source.url}`)
      content = await resp.text()
    }

    const channelCount = (content.match(/<channel /g) || []).length
    db.prepare(`
      INSERT INTO epg_cache (source_id, content, channel_count, last_fetched)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(source_id) DO UPDATE SET
        content = excluded.content,
        channel_count = excluded.channel_count,
        last_fetched = excluded.last_fetched
    `).run(source.id, content, channelCount)
    db.prepare("UPDATE sources SET last_fetched = datetime('now') WHERE id = ?").run(source.id)
    console.log(`[source] Refreshed EPG "${source.name}" — ${channelCount} channels`)

    // Extract all programmes and insert into epg_programmes for fast lookup
    const { parseProgBlock } = await import('../epgEnrich.js')
    db.transaction(() => {
      db.prepare('DELETE FROM epg_programmes WHERE source_id = ?').run(source.id)
      
      const insertProg = db.prepare(`
        INSERT INTO epg_programmes (source_id, channel_id, start, stop, title, desc, icon, episode_num, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      
      let currentPos = 0
      let progCount = 0
      while (true) {
        const startIdx = content.indexOf('<programme ', currentPos)
        if (startIdx === -1) break
        
        const endIdx = content.indexOf('</programme>', startIdx)
        if (endIdx === -1) break
        
        currentPos = endIdx + 12
        
        const raw = content.substring(startIdx, currentPos)
        const prog = parseProgBlock(raw)
        
        if (prog && prog.channel) {
          insertProg.run(
            source.id,
            prog.channel,
            prog.start || '',
            prog.stop || '',
            prog.title || null,
            prog.desc || null,
            prog.icon || null,
            prog.episode || null,
            raw
          )
          progCount++
        }
      }
      console.log(`[source] Parsed and stored ${progCount} programmes into epg_programmes`)
    })()

    invalidatePlaylistsForSource(source.id)

    // Clear channel cache to prevent stale group/channel data
    clearCache()

    // Note: Enrichment is now only run manually or after cron grab completes (not after every source refresh)
    return channelCount
  }

  // Playlist source — fetch channels and store to source_channels
  // Load cleanup rules for this source
  let cleanupRules = []
  try {
    if (source.cleanup_rules) {
      cleanupRules = JSON.parse(source.cleanup_rules).filter(r => r.enabled)
    }
  } catch (e) {
    console.error(`[source] Failed to parse cleanup_rules for "${source.name}":`, e.message)
  }

  // Load skip rules for this source
  let skipRules = []
  try {
    if (source.skip_rules) {
      skipRules = JSON.parse(source.skip_rules).filter(r => r.enabled)
    }
  } catch (e) {
    console.error(`[source] Failed to parse skip_rules for "${source.name}":`, e.message)
  }

  let channels
  let isXtream = false
  let refreshedContentTypes = { live: false, movies: false, series: false }

  if (source.type === 'xtream') {
    // For Xtream sources, use refresh options from global scheduler or default to all
    const refreshOptions = global.currentRefreshOptions || {
      refreshLive: true,
      refreshMovies: true,
      refreshSeries: true
    }

    channels = await fetchXtreamChannels(source.url, source.username, source.password, skipRules, refreshOptions)
    isXtream = true

    // Track which content types were refreshed
    refreshedContentTypes.live = refreshOptions.refreshLive
    refreshedContentTypes.movies = refreshOptions.refreshMovies
    refreshedContentTypes.series = refreshOptions.refreshSeries
  } else {
    // M3U sources: fetch all content, treat as live TV
    channels = await fetchAndParseM3U(source.url)
    refreshedContentTypes.live = true
  }

  let channelArrays = []
  if (isXtream) {
    channelArrays = [
      { contentType: 'live', channels: channels.live || [] },
      { contentType: 'movie', channels: channels.movie || [] },
      { contentType: 'series', channels: channels.series || [] }
    ]
  } else {
    channelArrays = [{ contentType: 'live', channels: channels }]
  }

  const vodSettings = getVodSettings()
  const { preparedChannelArrays, detectedGenres } = await buildPreparedChannelArrays(channelArrays, cleanupRules, skipRules, vodSettings, source.name)

  const insert = db.prepare(
    `INSERT INTO source_channels (source_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, quality, normalized_name, meta, content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, url) DO UPDATE SET
       tvg_id = excluded.tvg_id,
       tvg_name = excluded.tvg_name,
       tvg_logo = excluded.tvg_logo,
       group_title = excluded.group_title,
       raw_extinf = excluded.raw_extinf,
       quality = excluded.quality,
       normalized_name = excluded.normalized_name,
       meta = excluded.meta,
       content_type = excluded.content_type`
  )
  const update = db.prepare(
    'UPDATE source_channels SET tvg_id = ?, tvg_name = ?, tvg_logo = ?, group_title = ?, raw_extinf = ?, quality = ?, normalized_name = ?, meta = ?, content_type = ? WHERE source_id = ? AND url = ?'
  )
  const renamePlaylistChannels = db.prepare('UPDATE playlist_channels SET tvg_name = ? WHERE url = ?')
  const replace = db.transaction((sid, preparedArrays, refreshedContentTypes = { live: true, movies: true, series: true }, detectedGenreValues = DEFAULT_DETECTED_GENRES) => {
    // No longer delete VOD content - UPDATE by URL to preserve IDs for all content types

    // Track all URLs by content type for stale deletion
    const allLiveTvUrls = new Set()
    const allMovieUrls = new Set()
    const allSeriesUrls = new Set()

    for (const { contentType, channels: channelList } of preparedArrays) {
      for (const ch of channelList) {
        if (contentType === 'live') {
          allLiveTvUrls.add(ch.url)
        } else if (contentType === 'movie') {
          allMovieUrls.add(ch.url)
        } else if (contentType === 'series') {
          allSeriesUrls.add(ch.url)
        }

        const result = update.run(
          ch.tvgId,
          ch.cleanedName,
          ch.tvgLogo,
          ch.groupTitle,
          ch.rawExtinf,
          ch.quality,
          ch.normalizedName,
          ch.metaJson,
          contentType,
          sid,
          ch.url
        )

        // If no existing channel, INSERT new one
        if (result.changes === 0) {
          insert.run(
            sid,
            ch.tvgId,
            ch.cleanedName,
            ch.tvgLogo,
            ch.groupTitle,
            ch.url,
            ch.rawExtinf,
            ch.quality,
            ch.normalizedName,
            ch.metaJson,
            contentType
          )
        }

        // Update playlist_channels with cleaned name for channels with this URL
        const updated = renamePlaylistChannels.run(ch.cleanedName, ch.url)
        if (updated.changes > 0 && process.env.DEBUG) {
          console.log(`[source] Updated ${updated.changes} playlist channel(s) to "${ch.cleanedName}"`)
        }
      }
    }

    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('vod_detected_genres', JSON.stringify(detectedGenreValues))

    // Delete stale channels (channels that no longer exist in the source)
    // Live TV channels
    if (allLiveTvUrls.size > 0) {
      const currentUrls = Array.from(allLiveTvUrls)
      const placeholders = currentUrls.map(() => '?').join(',')
      const deleteStale = db.prepare(`
        DELETE FROM source_channels
        WHERE source_id = ?
        AND content_type = 'live'
        AND url NOT IN (${placeholders})
      `)
      const result = deleteStale.run(sid, ...currentUrls)
      if (result.changes > 0) {
        console.log(`[source] Deleted ${result.changes} stale Live TV channels`)
      }
    }

    // Movie channels - only delete if we actually refreshed movies
    if (refreshedContentTypes.movies) {
      let result
      if (allMovieUrls.size > 0) {
        const currentUrls = Array.from(allMovieUrls)
        const placeholders = currentUrls.map(() => '?').join(',')
        const deleteStale = db.prepare(`
          DELETE FROM source_channels
          WHERE source_id = ?
          AND content_type = 'movie'
          AND url NOT IN (${placeholders})
        `)
        result = deleteStale.run(sid, ...currentUrls)
      } else {
        const deleteAll = db.prepare(`
          DELETE FROM source_channels
          WHERE source_id = ?
          AND content_type = 'movie'
        `)
        result = deleteAll.run(sid)
      }
      if (result.changes > 0) {
        console.log(`[source] Deleted ${result.changes} stale movie channels`)
      }
    } else if (!refreshedContentTypes.movies) {
      console.log(`[source] Skipping stale movie deletion - movies were not refreshed`)
    }

    // Series channels - only delete if we actually refreshed series
    if (refreshedContentTypes.series) {
      let result
      if (allSeriesUrls.size > 0) {
        const currentUrls = Array.from(allSeriesUrls)
        const placeholders = currentUrls.map(() => '?').join(',')
        const deleteStale = db.prepare(`
          DELETE FROM source_channels
          WHERE source_id = ?
          AND content_type = 'series'
          AND url NOT IN (${placeholders})
        `)
        result = deleteStale.run(sid, ...currentUrls)
      } else {
        const deleteAll = db.prepare(`
          DELETE FROM source_channels
          WHERE source_id = ?
          AND content_type = 'series'
        `)
        result = deleteAll.run(sid)
      }
      if (result.changes > 0) {
        console.log(`[source] Deleted ${result.changes} stale series channels`)
      }
    } else if (!refreshedContentTypes.series) {
      console.log(`[source] Skipping stale series deletion - series were not refreshed`)
    }

    // Sync playlists that use this source
    const playlists = db.prepare(`
      SELECT DISTINCT pc.playlist_id, p.playlist_type
      FROM playlist_channels pc
      JOIN playlists p ON pc.playlist_id = p.id
      WHERE pc.source_id = ?
    `).all(sid)

    for (const { playlist_id, playlist_type } of playlists) {
      if (playlist_type === 'vod') {
        // VOD playlists: Match by URL, update existing, add new, delete stale
        const existing = db.prepare('SELECT * FROM playlist_channels WHERE playlist_id = ? AND source_id = ?')
          .all(playlist_id, sid)

        // Load VOD settings for filtering
        const vodSettings = getVodSettings()

        // Determine content filter based on playlist name
        const playlist = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlist_id)
        const playlistName = (playlist?.name || '').toLowerCase()
        let contentFilter = ''

        if (playlistName.includes('series') || playlistName.includes('tv')) {
          contentFilter = "AND group_title LIKE 'Series:%'"
        } else if (playlistName.includes('movie') || playlistName.includes('film')) {
          contentFilter = "AND group_title LIKE 'Movie:%'"
        } else {
          // Default: include both
          contentFilter = "AND (group_title LIKE 'Series:%' OR group_title LIKE 'Movie:%')"
        }

        const sourceUrlMap = new Map()
        const sourceChannels = db.prepare(`
          SELECT * FROM source_channels
          WHERE source_id = ?
          ${contentFilter}
        `).all(sid)

        // Filter channels by blocked titles
        let filteredCount = 0
        for (const ch of sourceChannels) {
          const genres = extractVodGenres({ group_title: ch.group_title, meta: ch.meta ? JSON.parse(ch.meta) : null }, ch.content_type)
          if (shouldFilterVodChannel(ch.tvg_name, genres, vodSettings)) {
            filteredCount++
            continue
          }
          sourceUrlMap.set(ch.url, ch)
        }

        if (filteredCount > 0) {
          console.log(`[source] Filtered ${filteredCount} channels by VOD blocked titles for playlist ${playlist_id}`)
        }

        const updateStmt = db.prepare(
          'UPDATE playlist_channels SET tvg_name = ?, tvg_logo = ?, group_title = ?, raw_extinf = ?, content_type = ? WHERE id = ?'
        )
        const deleteStmt = db.prepare('DELETE FROM playlist_channels WHERE id = ?')
        const insertStmt = db.prepare(
          'INSERT INTO playlist_channels (playlist_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, custom_tvg_id, sort_order, source_id, epg_source_id, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )

        let updatedCount = 0
        let deletedCount = 0
        const existingUrls = new Set()

        // Update existing channels
        for (const ch of existing) {
          existingUrls.add(ch.url)
          const sourceChannel = sourceUrlMap.get(ch.url)

          if (sourceChannel) {
            // Update with new data (no customizations to preserve for VOD)
            updateStmt.run(
              sourceChannel.tvg_name,
              sourceChannel.tvg_logo || '',
              sourceChannel.group_title || '',
              sourceChannel.raw_extinf || '',
              sourceChannel.content_type || 'movie',
              ch.id
            )
            updatedCount++
          } else {
            // Channel no longer in source - delete
            deleteStmt.run(ch.id)
            deletedCount++
          }
        }

        // Add new channels not in playlist
        let addedCount = 0
        let maxSortOrder = existing.length > 0 ? Math.max(...existing.map(e => e.sort_order || 0)) : 0

        for (const [url, ch] of sourceUrlMap) {
          if (!existingUrls.has(url)) {
            insertStmt.run(
              playlist_id,
              ch.tvg_id || '',
              ch.tvg_name,
              ch.tvg_logo || '',
              ch.group_title || '',
              ch.url,
              ch.raw_extinf || '',
              '',
              ++maxSortOrder,
              ch.source_id,
              null,
              ch.content_type || 'movie'
            )
            addedCount++
          }
        }

        if (updatedCount > 0 || deletedCount > 0 || addedCount > 0) {
          console.log(`[source] Synced VOD playlist ${playlist_id}: +${addedCount} added, ~${updatedCount} updated, -${deletedCount} deleted`)
        }
      } else if (playlist_type === 'live') {
        // Live TV playlists: Update existing, delete stale, add new (preserve custom overrides)
        const existing = db.prepare('SELECT * FROM playlist_channels WHERE playlist_id = ? AND source_id = ?')
          .all(playlist_id, sid)

        const sourceUrlMap = new Map()
        const sourceChannels = db.prepare(`
          SELECT * FROM source_channels
          WHERE source_id = ?
          AND group_title NOT LIKE 'Series:%'
          AND group_title NOT LIKE 'Movie:%'
        `).all(sid)

        for (const ch of sourceChannels) {
          sourceUrlMap.set(ch.url, ch)
        }

        const updateStmt = db.prepare(
          'UPDATE playlist_channels SET tvg_name = ?, tvg_logo = ?, raw_extinf = ?, content_type = ? WHERE id = ?'
        )
        const deleteStmt = db.prepare('DELETE FROM playlist_channels WHERE id = ?')
        const insertStmt = db.prepare(
          'INSERT INTO playlist_channels (playlist_id, tvg_id, tvg_name, tvg_logo, group_title, url, raw_extinf, custom_tvg_id, sort_order, source_id, epg_source_id, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )

        let updatedCount = 0
        let deletedCount = 0
        const existingUrls = new Set()

        // Update existing channels
        for (const ch of existing) {
          existingUrls.add(ch.url)
          const sourceChannel = sourceUrlMap.get(ch.url)

          if (sourceChannel) {
            // Update with new data, preserve custom fields
            updateStmt.run(
              sourceChannel.tvg_name,
              sourceChannel.tvg_logo || '',
              sourceChannel.raw_extinf || '',
              sourceChannel.content_type || 'live',
              ch.id
            )
            updatedCount++
          } else {
            // Channel no longer in source - delete
            deleteStmt.run(ch.id)
            deletedCount++
          }
        }

        // Live playlists: DO NOT auto-add new channels from source
        // Only update existing selections and delete stale ones
        // User must manually add channels via Channel Browser

        if (updatedCount > 0 || deletedCount > 0) {
          console.log(`[source] Synced Live playlist ${playlist_id}: ~${updatedCount} updated, -${deletedCount} deleted`)
        }
      }
    }

    // Update last_fetched timestamps for content types that were refreshed
    const updates = []
    if (refreshedContentTypes.live) updates.push("last_live_fetch = datetime('now')")
    if (refreshedContentTypes.movies) updates.push("last_movie_fetch = datetime('now')")
    if (refreshedContentTypes.series) updates.push("last_series_fetch = datetime('now')")

    if (updates.length > 0) {
      db.prepare(`UPDATE sources SET ${updates.join(', ')}, last_fetched = datetime('now') WHERE id = ?`).run(sid)
    }
  })
  replace(source.id, preparedChannelArrays, refreshedContentTypes, detectedGenres)

  // Calculate total channel count
  const totalCount = isXtream
    ? (channels.live?.length || 0) + (channels.movies?.length || 0) + (channels.series?.length || 0)
    : channels.length

  console.log(`[source] Refreshed "${source.name}" — ${totalCount} channels`)

  // Clear channel cache to prevent stale group/channel data
  clearCache()
  invalidateAllPlaylistXmltvCache()

  return totalCount
}

/**
 * Normalize channel name for grouping (lowercase, no spaces, no special chars)
 */
function normalizeChannelName(name) {
  let normalized = name.toLowerCase()

  // Remove quality indicators
  normalized = normalized.replace(/\b(hd|fhd|uhd|4k|sd|hevc|h\.?265)\b/gi, '')

  // Remove all non-alphanumeric characters
  normalized = normalized.replace(/[^a-z0-9]/g, '')

  return normalized
}

/**
 * Extract quality from channel name and return cleaned name + quality
 * Detects: HD, FHD, UHD, 4K, SD, 720p, 1080p, 2160p, etc.
 */
function extractQuality(name) {
  const qualityPatterns = [
    { regex: /\b(UHD|4K|2160p)\b/i, quality: 'UHD' },
    { regex: /\b(FHD|1080p)\b/i, quality: 'FHD' },
    { regex: /\b(HD|720p)\b/i, quality: 'HD' },
    { regex: /\bSD\b/i, quality: 'SD' },
  ]

  let quality = ''
  let cleanedName = name

  for (const { regex, quality: q } of qualityPatterns) {
    if (regex.test(name)) {
      quality = q
      // Remove the quality tag from the name
      cleanedName = name.replace(regex, '').trim()
      // Clean up multiple spaces and trim
      cleanedName = cleanedName.replace(/\s+/g, ' ').trim()
      break
    }
  }

  return { cleanedName, quality }
}
