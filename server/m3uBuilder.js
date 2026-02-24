import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Build M3U content from playlist channels, applying EPG mappings.
 * @param {Array} channels - playlist_channels rows
 * @param {Map} epgMap - source_tvg_id -> target_tvg_id
 * @returns {string}
 */
/**
 * Build M3U content from playlist channels.
 * @param {Array}  channels  - playlist_channels rows
 * @param {Map}    epgMap    - source_tvg_id -> target_tvg_id
 * @param {Object} opts
 * @param {string} [opts.baseUrl]    - if set, rewrite stream URLs through /stream/:id proxy
 * @param {string} [opts.catchupSrc] - catchup-source template (e.g. "Xtream")
 * @param {number} [opts.catchupDays] - days of catchup (default 7)
 */
export function buildM3U(channels, epgMap = new Map(), opts = {}) {
  const { baseUrl, catchupSrc, catchupDays = 7 } = opts
  const lines = ['#EXTM3U url-tvg="' + (opts.epgUrl || '') + '"']
  for (const ch of channels) {
    const tvgId  = ch.custom_tvg_id || epgMap.get(ch.tvg_id) || ch.tvg_id || ''
    const rawLogo = ch.custom_logo || ch.tvg_logo || ''
    const logo   = rawLogo ? ` tvg-logo="${baseUrl ? `${baseUrl}/api/logo?url=${encodeURIComponent(rawLogo)}` : rawLogo}"` : ''
    const group  = ch.group_title ? ` group-title="${ch.group_title}"` : ''
    const chno   = ch.sort_order > 0 ? ` tvg-chno="${ch.sort_order}"` : ''
    const catchup = catchupSrc
      ? ` catchup="default" catchup-source="${catchupSrc}" catchup-days="${catchupDays}"`
      : ''
    const streamUrl = baseUrl ? `${baseUrl}/stream/${ch.id}` : ch.url
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${ch.tvg_name}"${chno}${logo}${group}${catchup},${ch.tvg_name}`)
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
 */
export async function fetchXtreamChannels(url, username, password) {
  const base = url.replace(/\/$/, '')
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
