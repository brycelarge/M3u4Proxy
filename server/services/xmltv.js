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

export function generateXmltv(db, mappedChannels, cacheRows, hostUrl) {
  // Build channel XML from playlist
  const channels_xml = mappedChannels.map(ch => {
    const displayName = ch.tvg_name || ch.name || 'Unknown'
    const logo = ch.tvg_logo || ch.custom_logo || ''
    const groupTitle = ch.group_title || ''

    // Use epg_id which is already calculated in the SQL query
    // This is either custom_tvg_id, mapped tvg_id, or original tvg_id
    const channelId = ch.epg_id

    let xml = `  <channel id="${escapeXml(channelId)}">`
    xml += `\n    <display-name>${escapeXml(displayName)}</display-name>`
    if (logo) {
      // Proxy the logo URL through our server for Plex compatibility
      const proxyLogoUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(logo)}`
      xml += `\n    <icon src="${escapeXml(proxyLogoUrl)}" />`
    }
    // Add group as category if set in Review & Group
    if (groupTitle) {
      xml += `\n    <category>${escapeXml(groupTitle)}</category>`
    }

    xml += `\n  </channel>`
    return xml
  })

  // Get programme data from cache and scraper
  const programmes_xml = []

  // Load EPG mappings to map source_tvg_id -> target_tvg_id
  const epgMappings = db.prepare('SELECT source_tvg_id, target_tvg_id FROM epg_mappings').all()
  const sourceToTargetMap = {}
  epgMappings.forEach(m => {
    sourceToTargetMap[m.source_tvg_id] = m.target_tvg_id
  })

  // Build set of wanted channel IDs - include source_tvg_id, target_tvg_id, and custom_tvg_id
  const wantedIds = new Set()
  const idToEpgId = {}

  mappedChannels.forEach(ch => {
    // The final epg_id used in channel definitions
    const finalEpgId = ch.epg_id

    // Add the final epg_id to wanted set
    wantedIds.add(finalEpgId)
    idToEpgId[finalEpgId] = finalEpgId

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

    // Also check if any source_tvg_id maps to this channel's final epg_id
    Object.entries(sourceToTargetMap).forEach(([sourceId, targetId]) => {
      if (targetId === finalEpgId || targetId === ch.tvg_id || targetId === ch.custom_tvg_id) {
        wantedIds.add(sourceId)
        idToEpgId[sourceId] = finalEpgId
      }
    })
  })

  // Get TMDB enrichment data
  const { showMap, epMap } = getEnrichmentMaps()

  // From cache
  for (const row of cacheRows) {
    const progRe = /<programme\b[^>]*channel="([^"]*)"[^>]*>[\s\S]*?<\/programme>/g
    let m
    while ((m = progRe.exec(row.content)) !== null) {
      const channelId = m[1]
      if (wantedIds.has(channelId)) {
        let progContent = m[0]

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

        programmes_xml.push(progContent)
      }
    }
  }

  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<tv generator-info-name="m3u-manager">`,
    ...channels_xml,
    ...programmes_xml,
    `</tv>`,
  ].join('\n')

  return out
}
