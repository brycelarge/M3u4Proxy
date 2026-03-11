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

export function generateXmltv(db, mappedChannels, relevantSourceIds, hostUrl) {
  // Build channel XML from playlist
  const channels_xml = mappedChannels.map(ch => {
    const displayName = ch.tvg_name || ch.name || 'Unknown'
    const channelNumber = Number.isFinite(Number(ch.sort_order)) && Number(ch.sort_order) > 0
      ? String(ch.sort_order)
      : ''
    const logo = ch.custom_logo || ch.tvg_logo || ''
    const groupTitle = ch.group_title || ''
    const channelId = ch.epg_id

    let xml = `  <channel id="${escapeXml(channelId)}">`
    xml += `\n    <display-name>${escapeXml(displayName)}</display-name>`
    if (channelNumber) {
      xml += `\n    <display-name>${escapeXml(`${channelNumber} ${displayName}`)}</display-name>`
      xml += `\n    <channel-number>${escapeXml(channelNumber)}</channel-number>`
    }
    if (logo) {
      const proxyLogoUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(logo)}`
      xml += `\n    <icon src="${escapeXml(proxyLogoUrl)}" />`
    }
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

  // Build set of wanted channel IDs
  const wantedIds = new Set()
  const idToEpgId = {}
  const epgIdToGroupTitle = {}

  mappedChannels.forEach(ch => {
    const finalEpgId = ch.epg_id

    wantedIds.add(finalEpgId)
    idToEpgId[finalEpgId] = finalEpgId
    epgIdToGroupTitle[finalEpgId] = ch.group_title || null

    if (ch.tvg_id && ch.tvg_id !== finalEpgId) {
      wantedIds.add(ch.tvg_id)
      idToEpgId[ch.tvg_id] = finalEpgId
    }

    if (ch.custom_tvg_id && ch.custom_tvg_id !== finalEpgId) {
      wantedIds.add(ch.custom_tvg_id)
      idToEpgId[ch.custom_tvg_id] = finalEpgId
    }

    if (ch.tvg_id && sourceToTargetMap[ch.tvg_id]) {
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

  // Query epg_programmes directly — only rows for wanted channel IDs, no blob scanning
  if (relevantSourceIds && relevantSourceIds.length > 0 && wantedIds.size > 0) {
    const t0 = Date.now()
    // Only build enrichment maps if there are programmes to enrich
    const { showMap, epMap } = getEnrichmentMaps()
    console.log(`[xmltv] getEnrichmentMaps: ${Date.now() - t0}ms (${showMap.size} shows)`)

    const srcParams = relevantSourceIds.map(() => '?').join(',')
    const wantedIdsArr = Array.from(wantedIds)
    const chunkSize = 500

    for (let i = 0; i < wantedIdsArr.length; i += chunkSize) {
      const chunk = wantedIdsArr.slice(i, i + chunkSize)
      const chunkParams = chunk.map(() => '?').join(',')

      const rows = db.prepare(`
        SELECT channel_id, raw
        FROM epg_programmes
        WHERE source_id IN (${srcParams})
          AND channel_id IN (${chunkParams})
      `).all(...relevantSourceIds, ...chunk)

      for (const row of rows) {
        const channelId = row.channel_id
        let progContent = row.raw

        const targetEpgId = idToEpgId[channelId]
        if (targetEpgId && targetEpgId !== channelId) {
          progContent = progContent.replace(`channel="${channelId}"`, `channel="${targetEpgId}"`)
        }

        const prog = parseProgBlock(progContent)
        const enriched = applyEnrichment(prog, showMap, epMap)

        const hasIcon = /<icon\b/.test(progContent)
        const hasImage = /<image\b/.test(progContent)

        let existingImageUrl = null
        if (hasImage && !hasIcon) {
          const imageMatch = progContent.match(/<image[^>]*>\s*([^<]+)\s*<\/image>/)
          if (imageMatch) {
            existingImageUrl = imageMatch[1].trim()
            progContent = progContent.replace(/<image[^>]*>[\s\S]*?<\/image>/, '')
          }
        }

        if (enriched.icon) {
          const proxyUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(enriched.icon)}`
          if (hasIcon) {
            progContent = progContent.replace(/<icon\s+src="[^"]*"\s*\/>/, `<icon src="${escapeXml(proxyUrl)}" />`)
          } else {
            progContent = progContent.replace('</programme>', `  <icon src="${escapeXml(proxyUrl)}" />\n</programme>`)
          }
        } else if (existingImageUrl) {
          const proxyUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(existingImageUrl)}`
          progContent = progContent.replace('</programme>', `  <icon src="${escapeXml(proxyUrl)}" />\n</programme>`)
        } else {
          const iconMatch = progContent.match(/<icon\s+src="([^"]+)"\s*\/>/)
          if (iconMatch) {
            const originalUrl = iconMatch[1]
            if (!originalUrl.startsWith('/api/logo') && !originalUrl.includes('/api/logo?url=')) {
              const proxyUrl = `${hostUrl}/api/logo?url=${encodeURIComponent(originalUrl)}`
              progContent = progContent.replace(/<icon\s+src="([^"]+)"\s*\/>/, `<icon src="${escapeXml(proxyUrl)}" />`)
            }
          }
        }

        if (enriched.desc && !/<desc\b/.test(progContent)) {
          progContent = progContent.replace('</programme>', `  <desc>${escapeXml(enriched.desc)}</desc>\n</programme>`)
        }

        if (enriched.episode && !/<episode-num\b/.test(progContent)) {
          progContent = progContent.replace('</programme>', `  <episode-num system="xmltv_ns">${escapeXml(enriched.episode)}</episode-num>\n</programme>`)
        }

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

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<tv generator-info-name="m3u4prox">`,
    ...channels_xml,
    ...programmes_xml,
    `</tv>`,
  ].join('\n')
}
