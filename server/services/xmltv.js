import { getEnrichmentMaps, parseProgBlock, applyEnrichment } from '../epgEnrich.js'

// Helper function to escape XML special characters
export function escapeXml(str) {
  if (!str) return ''
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeCategory(groupTitle) {
  if (!groupTitle) return null
  const value = groupTitle.trim().toLowerCase()

  if (value.startsWith('movie')) return 'Movie'
  if (value.startsWith('series')) return 'Drama'
  if (value.includes('kid') || value.includes('children') || value.includes('family')) return 'Children'
  if (value.includes('sport')) return 'Sports'
  if (value.includes('news')) return 'News'
  if (value.includes('documentary') || value.includes('docu')) return 'Documentary'
  if (value.includes('music')) return 'Music'
  if (value.includes('comedy')) return 'Comedy'
  if (value.includes('drama')) return 'Drama'
  return null
}

export function generateXmltv(db, mappedChannels, cacheRows, hostUrl) {
  // Build channel XML from playlist
  const channels_xml = mappedChannels.map(ch => {
    const displayName = ch.tvg_name || ch.name || 'Unknown'
    const channelNumber = Number.isFinite(Number(ch.sort_order)) && Number(ch.sort_order) > 0
      ? String(ch.sort_order)
      : ''
    const logo = ch.custom_logo || ch.tvg_logo || ''
    const groupTitle = ch.group_title || ''

    // Use epg_id which is already calculated in the SQL query
    // This is either custom_tvg_id, mapped tvg_id, or original tvg_id
    const channelId = ch.epg_id

    let xml = `  <channel id="${escapeXml(channelId)}">`
    xml += `\n    <display-name>${escapeXml(displayName)}</display-name>`
    if (channelNumber) {
      xml += `\n    <display-name>${escapeXml(`${channelNumber} ${displayName}`)}</display-name>`
      xml += `\n    <channel-number>${escapeXml(channelNumber)}</channel-number>`
    }
    if (logo) {
      // Proxy the logo URL through our server for Plex compatibility
      const proxyLogoUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(logo)}`
      xml += `\n    <icon src="${escapeXml(proxyLogoUrl)}" />`
    }
    // Add group as category if set in Review & Group
    if (groupTitle) {
      xml += `\n    <category>${escapeXml(groupTitle)}</category>`
      const normalizedCategory = normalizeCategory(groupTitle)
      if (normalizedCategory && normalizedCategory.toLowerCase() !== groupTitle.trim().toLowerCase()) {
        xml += `\n    <category>${escapeXml(normalizedCategory)}</category>`
      }
    }

    xml += `\n  </channel>`
    return xml
  })

  // Get programme data from cache and scraper
  const programmes_xml = []

  // Load EPG mappings to map source_tvg_id -> target_tvg_id
  const epgMappings = db.prepare('SELECT source_tvg_id, target_tvg_id FROM epg_mappings').all()
  const sourceToTargetMap = {}
  const targetToSourceMap = new Map()
  epgMappings.forEach(m => {
    sourceToTargetMap[m.source_tvg_id] = m.target_tvg_id
    if (!targetToSourceMap.has(m.target_tvg_id)) targetToSourceMap.set(m.target_tvg_id, [])
    targetToSourceMap.get(m.target_tvg_id).push(m.source_tvg_id)
  })

  // Build set of wanted channel IDs - include source_tvg_id, target_tvg_id, and custom_tvg_id
  const wantedIds = new Set()
  const idToEpgId = {}
  const epgIdToGroupTitle = {}

  mappedChannels.forEach(ch => {
    // The final epg_id used in channel definitions
    const finalEpgId = ch.epg_id

    // Add the final epg_id to wanted set
    wantedIds.add(finalEpgId)
    idToEpgId[finalEpgId] = finalEpgId
    epgIdToGroupTitle[finalEpgId] = ch.group_title || null

    // Add original tvg_id and map it to final epg_id
    if (ch.tvg_id && ch.tvg_id !== finalEpgId) {
      wantedIds.add(ch.tvg_id)
      idToEpgId[ch.tvg_id] = finalEpgId
    }

    // Add custom_tvg_id and map it to final epg_id
    if (ch.custom_tvg_id && ch.custom_tvg_id !== finalEpgId) {
      wantedIds.add(ch.custom_tvg_id)
      idToEpgId[ch.custom_tvg_id] = finalEpgId
    }

    // If there's an EPG mapping for this channel's tvg_id, add the source_tvg_id
    // This allows matching programmes that use the original EPG source ID
    if (ch.tvg_id && sourceToTargetMap[ch.tvg_id]) {
      // ch.tvg_id is a source_tvg_id that maps to a target
      // Programmes in cache use source_tvg_id, so add it to wanted set
      wantedIds.add(ch.tvg_id)
      idToEpgId[ch.tvg_id] = finalEpgId
    }

    for (const targetId of [finalEpgId, ch.tvg_id, ch.custom_tvg_id].filter(Boolean)) {
      for (const sourceId of targetToSourceMap.get(targetId) || []) {
        wantedIds.add(sourceId)
        idToEpgId[sourceId] = finalEpgId
      }
    }
  })

  // Get TMDB enrichment data
  const { showMap, epMap } = getEnrichmentMaps()

  // From database instead of scanning giant blobs
  if (relevantSourceIds && relevantSourceIds.length > 0 && Array.from(wantedIds).length > 0) {
    const idsParams = Array.from(wantedIds).map(() => '?').join(',')
    const srcParams = relevantSourceIds.map(() => '?').join(',')

    // Chunk wantedIds to avoid SQLite limit on variables if there are many channels
    const chunkSize = 500;
    const wantedIdsArr = Array.from(wantedIds);

    for (let i = 0; i < wantedIdsArr.length; i += chunkSize) {
      const chunk = wantedIdsArr.slice(i, i + chunkSize);
      const chunkParams = chunk.map(() => '?').join(',');

      const rows = db.prepare(`
        SELECT channel_id, raw
        FROM epg_programmes
        WHERE source_id IN (${srcParams})
          AND channel_id IN (${chunkParams})
      `).all(...relevantSourceIds, ...chunk);

      for (const row of rows) {
        const channelId = row.channel_id;
        let progContent = row.raw;

        // Replace channel ID with mapped epg_id if needed
        const targetEpgId = idToEpgId[channelId]
        if (targetEpgId && targetEpgId !== channelId) {
          progContent = progContent.replace(`channel="${channelId}"`, `channel="${targetEpgId}"`)
        }

        // Parse and apply TMDB enrichment
        const prog = parseProgBlock(progContent)
        const enriched = applyEnrichment(prog, showMap, epMap)

        // Handle both <icon> and <image> tags (some EPGs use <image> instead of <icon>)
        const hasIcon = /<icon\b/.test(progContent)
        const hasImage = /<image\b/.test(progContent)

        // Extract existing image URL if present
        let existingImageUrl = null
        if (hasImage && !hasIcon) {
          const imageMatch = progContent.match(/<image[^>]*>\s*([^<]+)\s*<\/image>/)
          if (imageMatch) {
            existingImageUrl = imageMatch[1].trim()
            // Remove <image> tag and replace with <icon>
            progContent = progContent.replace(/<image[^>]*>[\s\S]*?<\/image>/, '')
          }
        }

        // Replace or add enriched poster
        if (enriched.icon) {
          const proxyUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(enriched.icon)}`
          if (hasIcon) {
            // Replace existing icon
            progContent = progContent.replace(/<icon\s+src="[^"]*"\s*\/>/, `<icon src="${escapeXml(proxyUrl)}" />`)
          } else {
            // Add new icon
            progContent = progContent.replace('</programme>', `  <icon src="${escapeXml(proxyUrl)}" />\n</programme>`)
          }
        } else if (existingImageUrl) {
          // Use existing image URL from <image> tag
          const proxyUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(existingImageUrl)}`
          progContent = progContent.replace('</programme>', `  <icon src="${escapeXml(proxyUrl)}" />\n</programme>`)
        } else {
          // Fix any existing icon URLs to use our proxy
          const iconMatch = progContent.match(/<icon\s+src="([^"]+)"\s*\/>/)
          if (iconMatch) {
            const originalUrl = iconMatch[1]
            // Only proxy external URLs, not already proxied ones
            if (!originalUrl.startsWith('/api/logo') && !originalUrl.includes('/api/logo?url=')) {
              const proxyUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(originalUrl)}`
              progContent = progContent.replace(/<icon\s+src="([^"]+)"\s*\/>/, `<icon src="${escapeXml(proxyUrl)}" />`)
            }
          }
        }

        // Add enriched description if available and not already present
        if (enriched.desc && !/<desc\b/.test(progContent)) {
          progContent = progContent.replace('</programme>', `  <desc>${escapeXml(enriched.desc)}</desc>\n</programme>`)
        }

        // Preserve or add episode-num if available
        if (enriched.episode && !/<episode-num\b/.test(progContent)) {
          progContent = progContent.replace('</programme>', `  <episode-num system="xmltv_ns">${escapeXml(enriched.episode)}</episode-num>\n</programme>`)
        }

        // Always add channel group as category for Jellyfin filtering
        const groupTitle = epgIdToGroupTitle[targetEpgId]
        if (groupTitle) {
          progContent = progContent.replace('</programme>', `  <category lang="en">${escapeXml(groupTitle)}</category>\n</programme>`)
          const normalizedCategory = normalizeCategory(groupTitle)
          if (normalizedCategory && normalizedCategory.toLowerCase() !== groupTitle.trim().toLowerCase()) {
            progContent = progContent.replace('</programme>', `  <category lang="en">${escapeXml(normalizedCategory)}</category>\n</programme>`)
          }
        }

        programmes_xml.push(progContent)
      }
    }
  }
  timer('programmes')

  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<tv generator-info-name="m3u4prox">`,
    ...channels_xml,
    ...programmes_xml,
    `</tv>`,
  ].join('\n')

  timer('serialize')

  if (debug) {
    timer.flush({
      playlistId: opts.playlistId ?? null,
      channels: mappedChannels.length,
      programmes: programmes_xml.length,
      cacheRows: cacheRows.length,
    })
  }

  return out
}
