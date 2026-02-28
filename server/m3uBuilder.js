import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Build M3U content from playlist channels, applying EPG mappings.
 * @param {Array} channels - playlist_channels rows
 * @param {Map} epgMap - source_tvg_id -> target_tvg_id
 * @returns {string}
 */
/**
 * Remove quality suffix from channel name (HD, FHD, UHD, SD, 4K, etc.)
 */
function cleanChannelName(name) {
  return name
    .replace(/\s+(UHD|4K|2160p)(\s*\*)?$/i, '')
    .replace(/\s+(FHD|1080p)(\s*\*)?$/i, '')
    .replace(/\s+(HD|720p)(\s*\*)?$/i, '')
    .replace(/\s+(SD|480p)(\s*\*)?$/i, '')
    .replace(/\s+\*$/, '') // Remove trailing asterisk
    .trim()
}

/**
 * Build M3U content from playlist channels.
 * @param {Array}  channels  - playlist_channels rows
 * @param {Map}    epgMap    - source_tvg_id -> target_tvg_id
 * @param {Object} opts
 * @param {string} [opts.baseUrl]    - if set, rewrite stream URLs through /stream/:id proxy
 * @param {string} [opts.catchupSrc] - catchup-source template (e.g. "Xtream")
 * @param {number} [opts.catchupDays] - days of catchup (default 7)
 * @param {Map}    [opts.vodMetadata] - Map of channelId -> NFO metadata for VOD enrichment
 */
export function buildM3U(channels, epgMap = new Map(), opts = {}) {
  const { baseUrl, catchupSrc, catchupDays = 7, vodMetadata } = opts
  const lines = ['#EXTM3U url-tvg="' + (opts.epgUrl || '') + '"']
  for (const ch of channels) {
    const cleanName = cleanChannelName(ch.tvg_name)

    // Try to get enriched metadata from NFO for VOD channels
    const nfoData = vodMetadata?.get(String(ch.id))
    const displayName = nfoData?.title || cleanName
    const tvgId  = ch.custom_tvg_id || epgMap.get(ch.tvg_id) || ch.tvg_id || ''

    // Use NFO poster if available, otherwise use channel logo
    let rawLogo = ch.custom_logo || ch.tvg_logo || ''
    if (nfoData?.poster && baseUrl) {
      rawLogo = `${baseUrl}/api/proxy-image?url=${encodeURIComponent(nfoData.poster)}`
    }

    const logo   = rawLogo ? ` tvg-logo="${rawLogo}"` : ''
    const group  = (nfoData?.genre || ch.group_title) ? ` group-title="${nfoData?.genre || ch.group_title}"` : ''
    const chno   = ch.sort_order > 0 ? ` tvg-chno="${ch.sort_order}"` : ''
    const catchup = catchupSrc
      ? ` catchup="default" catchup-source="${catchupSrc}" catchup-days="${catchupDays}"`
      : ''
    const streamUrl = baseUrl ? `${baseUrl}/stream/${ch.id}` : ch.url
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${displayName}"${chno}${logo}${group}${catchup},${displayName}`)
    lines.push(streamUrl)
  }
  return lines.join('\n')
}

/**
 * Write M3U to disk at the given output path.
 * Creates parent directories if needed.
 */
export function writeM3U(outputPath, content) {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, content, 'utf8')
}

/**
 * Check if a name should be skipped based on skip rules
 */
export function shouldSkipByRules(name, skipRules) {
  for (const rule of skipRules) {
    try {
      if (rule.useRegex) {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(name)) {
          return true
        }
      } else {
        if (name.toLowerCase().includes(rule.pattern.toLowerCase())) {
          return true
        }
      }
    } catch (e) {
      console.error(`[skip] Rule failed:`, e.message)
    }
  }
  return false
}

/**
 * Fetch and parse an M3U URL, returning raw channel objects.
 */
export async function fetchAndParseM3U(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  const text = await res.text()
  return parseM3UText(text)
}

/**
 * Fetch channels from Xtream Codes API.
 * Fetches Live TV, VOD (movies), and Series in parallel.
 */
export async function fetchXtreamChannels(url, username, password, skipRules = []) {
  const base = url.replace(/\/$/, '')

  // Fetch all three content types in parallel
  const [liveChannels, vodChannels, seriesChannels] = await Promise.all([
    fetchLiveStreams(base, username, password).catch(() => []),
    fetchVodStreams(base, username, password).catch(() => []),
    fetchSeriesStreams(base, username, password, skipRules).catch(() => [])
  ])

  // Return separated by content type so caller can handle each independently
  return {
    live: liveChannels,
    movie: vodChannels,
    series: seriesChannels
  }
}

/**
 * Fetch Live TV streams from Xtream API
 */
async function fetchLiveStreams(base, username, password) {
  const apiUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_live_streams`
  const catUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_live_categories`

  const [streamsRes, catsRes] = await Promise.all([fetch(apiUrl), fetch(catUrl)])
  if (!streamsRes.ok) throw new Error(`Xtream API error: ${streamsRes.status}`)

  const streams = await streamsRes.json()
  const cats = catsRes.ok ? await catsRes.json() : []
  const catMap = Object.fromEntries(cats.map(c => [c.category_id, c.category_name]))

  return streams.map(s => ({
    tvg_id:      s.epg_channel_id || '',
    tvg_name:    s.name,
    tvg_logo:    s.stream_icon || '',
    group_title: catMap[s.category_id] || 'Ungrouped',
    url:         `${base}/live/${username}/${password}/${s.stream_id}.ts`,
    raw_extinf:  `#EXTINF:-1 tvg-id="${s.epg_channel_id || ''}" tvg-name="${s.name}" tvg-logo="${s.stream_icon || ''}" group-title="${catMap[s.category_id] || 'Ungrouped'}",${s.name}`,
  }))
}

/**
 * Fetch VOD (movie) streams from Xtream API
 */
async function fetchVodStreams(base, username, password) {
  const apiUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_vod_streams`
  const catUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_vod_categories`

  const [streamsRes, catsRes] = await Promise.all([fetch(apiUrl), fetch(catUrl)])
  if (!streamsRes.ok) throw new Error(`Xtream VOD API error: ${streamsRes.status}`)

  const streams = await streamsRes.json()
  const cats = catsRes.ok ? await catsRes.json() : []
  const catMap = Object.fromEntries(cats.map(c => [c.category_id, c.category_name]))

  return streams.map(s => {
    const groupTitle = catMap[s.category_id] || 'Ungrouped'
    const prefixedGroup = groupTitle !== 'Ungrouped' ? `Movie: ${groupTitle}` : groupTitle

    // Only store metadata if it has useful fields (tmdb_id, imdb_id, year, releaseDate)
    const hasUsefulMeta = s.tmdb_id || s.imdb_id || s.year || s.releaseDate

    return {
      tvg_id:      s.tmdb_id || '',
      tvg_name:    s.name || s.title || 'Unknown',
      tvg_logo:    s.stream_icon || s.cover || '',
      group_title: prefixedGroup,
      url:         `${base}/movie/${username}/${password}/${s.stream_id}.mkv`,
      meta:        hasUsefulMeta ? s : null, // Only store if has useful data
      raw_extinf:  `#EXTINF:-1 tvg-id="${s.tmdb_id || ''}" tvg-name="${s.name || s.title || 'Unknown'}" tvg-logo="${s.stream_icon || s.cover || ''}" group-title="${prefixedGroup}",${s.name || s.title || 'Unknown'}`,
    }
  })
}

/**
 * Fetch Series streams from Xtream API and expand each series into individual episodes.
 */
async function fetchSeriesStreams(base, username, password, skipRules = []) {
  const apiUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_series`
  const catUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_series_categories`

  const [streamsRes, catsRes] = await Promise.all([fetch(apiUrl), fetch(catUrl)])
  if (!streamsRes.ok) throw new Error(`Xtream Series API error: ${streamsRes.status}`)

  const allSeries = await streamsRes.json()
  const cats = catsRes.ok ? await catsRes.json() : []
  const catMap = Object.fromEntries(cats.map(c => [c.category_id, c.category_name]))

  // Apply skip rules to filter out unwanted series BEFORE fetching episodes
  let series = allSeries
  let skippedCount = 0

  if (skipRules.length > 0) {
    series = allSeries.filter(s => {
      const seriesName = s.name || ''
      if (shouldSkipByRules(seriesName, skipRules)) {
        skippedCount++
        return false
      }
      return true
    })

    if (skippedCount > 0) {
      console.log(`[xtream] Skipped ${skippedCount} series based on skip rules (${series.length} remaining)`)
    }
  }

  // Export categories to CSV for investigation
  try {
    const { writeFileSync } = await import('node:fs')
    const csvHeader = 'Category ID,Category Name,Series Count\n'
    const categoryCounts = new Map()

    // Count series per category
    for (const s of series) {
      const catName = catMap[s.category_id] || 'Unknown'
      categoryCounts.set(catName, (categoryCounts.get(catName) || 0) + 1)
    }

    const csvRows = cats.map(c => {
      const count = categoryCounts.get(c.category_name) || 0
      return `${c.category_id},"${c.category_name.replace(/"/g, '""')}",${count}`
    }).join('\n')

    const csvPath = '/data/xtream-series-categories.csv'
    writeFileSync(csvPath, csvHeader + csvRows, 'utf8')
    console.log(`[xtream] Exported ${cats.length} categories to ${csvPath}`)
  } catch (e) {
    console.error(`[xtream] Failed to export categories CSV:`, e.message)
  }

  // Debug: Check what get_series returns
  if (series.length > 0) {
    console.log(`[xtream] DEBUG: First series object:`, JSON.stringify(series[0], null, 2))
  }

  console.log(`[xtream] Found ${cats.length} categories with ${series.length} total series`)
  console.log(`[xtream] Fetching episodes for ${series.length} series...`)

  const seriesToProcess = series

  const allEpisodes = []
  const skippedData = [] // Track skipped series/episodes for CSV export
  const apiErrors = [] // Track API errors
  const BATCH_SIZE = 3 // Process 3 series in parallel (avoid rate limiting)
  const DELAY_BETWEEN_BATCHES = 1000 // 1 second delay between batches

  // Process series in batches for better performance
  for (let i = 0; i < seriesToProcess.length; i += BATCH_SIZE) {
    const batch = seriesToProcess.slice(i, i + BATCH_SIZE)

    const batchPromises = batch.map(async (s) => {
      try {
        const infoUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_series_info&series_id=${s.series_id}`

        // Retry up to 3 times on failure
        let infoRes
        let retries = 0
        while (retries < 3) {
          infoRes = await fetch(infoUrl)
          if (infoRes.ok) break
          retries++
          if (retries < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000 * retries)) // Exponential backoff
          }
        }

        if (!infoRes.ok) {
          apiErrors.push({ series_id: s.series_id, name: s.name, status: infoRes.status })
          if (apiErrors.length <= 5) {
            console.log(`[xtream] API error for "${s.name}" (${s.series_id}): HTTP ${infoRes.status}`)
          }
          return []
        }

        const info = await infoRes.json()

        // Debug: Log full API response for Breaking Bad
        if (s.name && s.name.toLowerCase().includes('breaking bad')) {
          console.log(`[xtream] DEBUG: ===== BREAKING BAD FULL API RESPONSE =====`)
          console.log(`[xtream] DEBUG: Series info:`, JSON.stringify(info.info || {}, null, 2))
          console.log(`[xtream] DEBUG: Seasons:`, JSON.stringify(info.seasons || [], null, 2))
          console.log(`[xtream] DEBUG: Episodes keys:`, Object.keys(info.episodes || {}))
          console.log(`[xtream] DEBUG: Season 1 episodes (first 3):`, JSON.stringify(Object.entries(info.episodes || {})[0]?.[1]?.slice(0, 3), null, 2))
          console.log(`[xtream] DEBUG: ==========================================`)
        }

        // Skip series with no episodes or no seasons
        if (!info.episodes || Object.keys(info.episodes).length === 0) {
          if (skippedData.length < 10) {
            console.log(`[xtream] Skipping series "${s.name}" (${catMap[s.category_id]}) - no episodes`)
          }
          skippedData.push({
            series_id: s.series_id,
            series_name: s.name,
            category: catMap[s.category_id] || 'Ungrouped',
            reason: 'No episodes data from provider',
            season: '',
            episode: ''
          })
          return []
        }

        // Debug: Log episode info for first series
        if (i === 0 && batch.indexOf(s) === 0) {
          console.log(`[xtream] DEBUG: Series "${s.name}" (ID: ${s.series_id})`)
          console.log(`[xtream] DEBUG: Episodes object keys:`, Object.keys(info.episodes || {}))
          console.log(`[xtream] DEBUG: First season data:`, JSON.stringify(Object.entries(info.episodes || {})[0], null, 2))
        }

        const seriesName = s.name || s.title || 'Unknown'
        const groupTitle = catMap[s.category_id] || 'Ungrouped'
        const prefixedGroup = groupTitle !== 'Ungrouped' ? `Series: ${groupTitle}` : groupTitle

        const episodes = []
        let totalEpisodeCount = 0

        // Only store metadata if it has useful fields (tmdb_id, imdb_id, year, releaseDate)
        const hasUsefulMeta = s.tmdb_id || s.imdb_id || s.year || s.releaseDate

        // Process each season
        for (const [seasonNum, episodeList] of Object.entries(info.episodes)) {
          if (!Array.isArray(episodeList) || episodeList.length === 0) continue

          // Validate season number exists and is valid (allow 0 for specials)
          const season = parseInt(seasonNum, 10)
          if (isNaN(season)) {
            console.log(`[xtream] Skipping invalid season "${seasonNum}" for series "${s.name}"`)
            skippedData.push({
              series_id: s.series_id,
              series_name: s.name,
              category: catMap[s.category_id] || 'Ungrouped',
              reason: 'Invalid season number',
              season: seasonNum,
              episode: ''
            })
            continue
          }

          for (const episode of episodeList) {
            // Skip episodes without valid episode number
            if (!episode.episode_num || isNaN(parseInt(episode.episode_num, 10))) {
              console.log(`[xtream] Skipping episode without valid episode_num in "${s.name}" S${String(season).padStart(2, '0')}`)
              skippedData.push({
                series_id: s.series_id,
                series_name: s.name,
                category: catMap[s.category_id] || 'Ungrouped',
                reason: 'Missing episode number',
                season: String(season),
                episode: episode.episode_num || 'null'
              })
              continue
            }

            const episodeNum = parseInt(episode.episode_num, 10)
            // Episode number is valid (already checked for NaN above)

            totalEpisodeCount++
            const episodeName = `${seriesName} S${String(season).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`
            const episodeTitle = episode.title || episodeName

            episodes.push({
              tvg_id:       episode.info?.tmdb_id || s.tmdb_id || '',
              tvg_name:     episodeName,
              tvg_logo:     episode.info?.movie_image || s.cover || '',
              group_title:  prefixedGroup,
              url:          `${base}/series/${username}/${password}/${episode.id}.mkv`,
              meta:         hasUsefulMeta ? s : null, // Only store if has useful data
              raw_extinf:   `#EXTINF:-1 tvg-id="${episode.info?.tmdb_id || s.tmdb_id || ''}" tvg-name="${episodeName}" tvg-logo="${episode.info?.movie_image || s.cover || ''}" group-title="${prefixedGroup}",${episodeTitle}`,
            })
          }
        }

        // Debug: Log episode count for first series
        if (i === 0 && batch.indexOf(s) === 0) {
          console.log(`[xtream] DEBUG: Total episodes created: ${totalEpisodeCount}`)
          console.log(`[xtream] DEBUG: Has useful meta: ${hasUsefulMeta}`)
          console.log(`[xtream] DEBUG: First episode:`, episodes[0])
        }

        return episodes
      } catch (e) {
        console.error(`[xtream] Error fetching episodes for series ${s.series_id}:`, e.message)
        return []
      }
    })

    const batchResults = await Promise.all(batchPromises)
    for (const episodes of batchResults) {
      allEpisodes.push(...episodes)
    }

    // Progress logging
    const processed = Math.min(i + BATCH_SIZE, seriesToProcess.length)
    console.log(`[xtream] Processed ${processed}/${seriesToProcess.length} series (${allEpisodes.length} episodes so far, ${apiErrors.length} API errors)`)

    // Delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < seriesToProcess.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES))
    }
  }

  // Count series that produced episodes vs series with no episodes
  const seriesWithEpisodes = new Set()
  for (const ep of allEpisodes) {
    // Extract series name from episode name (before S00E00)
    const match = ep.tvg_name.match(/^(.+?)\s+S\d+E\d+$/)
    if (match) seriesWithEpisodes.add(match[1])
  }

  const seriesWithoutEpisodes = seriesToProcess.length - seriesWithEpisodes.size

  console.log(`[xtream] Completed: ${allEpisodes.length} total episodes from ${seriesToProcess.length} series processed`)
  console.log(`[xtream] Series with episodes: ${seriesWithEpisodes.size}, without episodes: ${seriesWithoutEpisodes}`)
  console.log(`[xtream] API errors: ${apiErrors.length}, Skipped items: ${skippedData.length}`)

  if (apiErrors.length > 0) {
    console.log(`[xtream] WARNING: ${apiErrors.length} series failed to fetch due to API errors (rate limiting or timeouts)`)
  }

  // Always export CSV (even if empty) for investigation
  try {
    const { writeFileSync } = await import('node:fs')
    const csvHeader = 'Series ID,Series Name,Category,Reason,Season,Episode\n'
    const csvRows = skippedData.map(row =>
      `${row.series_id},"${row.series_name.replace(/"/g, '""')}","${row.category}","${row.reason}",${row.season},${row.episode}`
    ).join('\n')
    const csvPath = '/data/skipped-series.csv'
    const csvContent = csvHeader + (csvRows || '')
    writeFileSync(csvPath, csvContent, 'utf8')
    console.log(`[xtream] Exported ${skippedData.length} skipped items to ${csvPath}`)
  } catch (e) {
    console.error(`[xtream] Failed to export skipped data CSV:`, e.message)
  }

  return allEpisodes
}

/**
 * Fetch and parse an M3U URL, returning raw channel objects.
 */
export function parseM3UText(text) {
  const lines = text.split(/\r?\n/)
  const channels = []
  let current = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#EXTINF')) {
      const nameMatch = trimmed.match(/,(.+)$/)
      const name = trimmed.match(/tvg-name="([^"]*)"/)?.[1] || nameMatch?.[1]?.trim() || 'Unknown'
      const groupAttr = trimmed.match(/group-title="([^"]*)"/)?.[1] ?? null
      current = {
        tvg_id:      trimmed.match(/tvg-id="([^"]*)"/)?.[1] || '',
        tvg_name:    name,
        tvg_logo:    trimmed.match(/tvg-logo="([^"]*)"/)?.[1] || '',
        group_title: (groupAttr && groupAttr.trim()) ? groupAttr.trim() : inferGroup(name),
        raw_extinf:  trimmed,
        url:         '',
      }
    } else if (!trimmed.startsWith('#') && current) {
      current.url = trimmed
      channels.push(current)
      current = null
    }
  }
  return channels
}

function inferGroup(name) {
  const colonPrefix = name.match(/^([^:]{1,20}):/)
  if (colonPrefix) return colonPrefix[1].trim()
  const wordPrefix = name.match(/^([A-Z][A-Z0-9]{0,9})\s/)
  if (wordPrefix) return wordPrefix[1]
  return 'Ungrouped'
}
