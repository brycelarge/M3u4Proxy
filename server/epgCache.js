import { writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import db from './db.js'
import { getEnrichmentMaps, applyEnrichment, parseProgBlock } from './index.js'

const EPG_CACHE_DIR = process.env.EPG_DIR || '/data/epg'

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildProgrammeXml(prog) {
  let xml = `  <programme channel="${escapeXml(prog.channel)}" start="${prog.start}" stop="${prog.stop}">`
  xml += `\n    <title>${escapeXml(prog.title)}</title>`
  if (prog.desc) xml += `\n    <desc>${escapeXml(prog.desc)}</desc>`
  if (prog.icon) xml += `\n    <icon src="${escapeXml(prog.icon)}" />`
  if (prog.episode) xml += `\n    <episode-num system="xmltv_ns">${escapeXml(prog.episode)}</episode-num>`
  xml += `\n  </programme>`
  return xml
}

export function generatePlaylistGuideXml(playlistId) {
  console.log(`[epg-cache] Generating guide for playlist ${playlistId}`)

  // Get playlist channels with EPG IDs
  const channels = db.prepare(`
    SELECT pc.*,
           CASE
             WHEN pc.custom_tvg_id != '' THEN pc.custom_tvg_id
             WHEN em.target_tvg_id IS NOT NULL THEN em.target_tvg_id
             ELSE pc.tvg_id
           END as epg_id
    FROM playlist_channels pc
    LEFT JOIN epg_mappings em ON (em.source_tvg_id = pc.tvg_id OR em.source_tvg_id = pc.custom_tvg_id)
    WHERE pc.playlist_id = ?
  `).all(playlistId)

  const epgIds = new Set(channels.map(ch => ch.epg_id).filter(Boolean))
  if (!epgIds.size) {
    console.log(`[epg-cache] No EPG IDs for playlist ${playlistId}`)
    return null
  }

  // Get EPG cache
  const cacheRows = db.prepare('SELECT content FROM epg_cache WHERE content IS NOT NULL').all()
  if (!cacheRows.length) {
    console.log(`[epg-cache] No EPG cache data available`)
    return null
  }

  const { showMap, epMap } = getEnrichmentMaps()

  const channelsXml = []
  const programmesXml = []
  const seenChannels = new Set()

  // Parse and filter
  for (const row of cacheRows) {
    // Extract channels
    const channelRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g
    let m
    while ((m = channelRe.exec(row.content)) !== null) {
      if (epgIds.has(m[1]) && !seenChannels.has(m[1])) {
        channelsXml.push(m[0])
        seenChannels.add(m[1])
      }
    }

    // Extract programmes
    const progRe = /<programme\b[\s\S]*?<\/programme>/g
    while ((m = progRe.exec(row.content)) !== null) {
      const prog = parseProgBlock(m[0])
      if (epgIds.has(prog.channel)) {
        const enriched = applyEnrichment(prog, showMap, epMap)
        programmesXml.push(buildProgrammeXml(enriched))
      }
    }
  }

  // Build XML
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="m3u-manager">',
    ...channelsXml,
    ...programmesXml,
    '</tv>'
  ].join('\n')

  // Write file
  const filePath = path.join(EPG_CACHE_DIR, `playlist-${playlistId}-guide.xml`)
  writeFileSync(filePath, xml, 'utf8')

  const sizeMB = (xml.length / 1024 / 1024).toFixed(2)
  console.log(`[epg-cache] Generated ${filePath} (${sizeMB}MB, ${programmesXml.length} programmes)`)

  return filePath
}

export function clearPlaylistGuideCache(playlistId) {
  const filePath = path.join(EPG_CACHE_DIR, `playlist-${playlistId}-guide.xml`)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
    console.log(`[epg-cache] Cleared cache for playlist ${playlistId}`)
  }
}

export function clearAllGuideCaches() {
  try {
    const files = readdirSync(EPG_CACHE_DIR).filter(f => f.startsWith('playlist-') && f.endsWith('-guide.xml'))
    for (const file of files) {
      unlinkSync(path.join(EPG_CACHE_DIR, file))
    }
    console.log(`[epg-cache] Cleared ${files.length} cached guide files`)
  } catch (e) {
    console.error(`[epg-cache] Error clearing caches:`, e.message)
  }
}
