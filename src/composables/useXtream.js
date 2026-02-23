function proxyUrl(url) {
  return `/api-proxy?url=${encodeURIComponent(url)}`
}

export async function fetchXtreamChannels(baseUrl, username, password) {
  const base = baseUrl.replace(/\/$/, '')
  const api = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`

  const [catRes, streamRes] = await Promise.all([
    fetch(proxyUrl(`${api}&action=get_live_categories`)),
    fetch(proxyUrl(`${api}&action=get_live_streams`)),
  ])

  if (!catRes.ok) throw new Error(`Categories: HTTP ${catRes.status}`)
  if (!streamRes.ok) throw new Error(`Streams: HTTP ${streamRes.status}`)

  const cats = await catRes.json()
  const streams = await streamRes.json()

  if (!Array.isArray(streams)) throw new Error('Invalid response — check credentials')

  const catMap = Object.fromEntries(cats.map((c) => [c.category_id, c.category_name]))

  return streams.map((s, i) => {
    const group = catMap[s.category_id] || 'Ungrouped'
    const name = s.name || 'Unknown'
    const logo = s.stream_icon || ''
    const epgId = s.epg_channel_id || ''
    return {
      id: i,
      name,
      tvgId: epgId,
      tvgLogo: logo,
      group,
      url: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`,
      raw: `#EXTINF:-1 tvg-id="${epgId}" tvg-name="${name}" tvg-logo="${logo}" group-title="${group}",${name}`,
      streamId: s.stream_id,
    }
  })
}
