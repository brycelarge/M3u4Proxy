const BASE = '/api'

function buildQuery(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return q ? `?${q}` : ''
}

async function fetchAllPages(fetcher, pageSize = 2000) {
  let offset = 0
  const all = []
  while (true) {
    const res = await fetcher(pageSize, offset)
    const page = res.channels ?? res
    all.push(...page)
    if (!res.total || all.length >= res.total) break
    offset += pageSize
  }
  return all
}

async function request(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      console.error(`API Error (${res.status}) on ${method} ${path}:`, err)
      throw new Error(err.error || `${res.status}: ${res.statusText}`)
    }

    return res.json().catch(err => {
      console.error(`Failed to parse JSON from ${method} ${path}:`, err)
      throw new Error('Invalid response format')
    })
  } catch (err) {
    console.error(`Request failed for ${method} ${path}:`, err)
    throw err
  }
}

export function logoUrl(url) {
  if (!url) return ''
  return `/api/logo?url=${encodeURIComponent(url)}`
}

export const api = {
  // Sources
  getSources:          ()           => request('GET',    '/sources'),
  createSource:        (data)       => request('POST',   '/sources', data),
  updateSource:        (id, data)   => request('PUT',    `/sources/${id}`, data),
  deleteSource:        (id)         => request('DELETE', `/sources/${id}`),
  getSourceGroups:     (id)         => request('GET',    `/sources/${id}/groups`),
  getSourceChannels:   (id, group, limit, offset)  => request('GET',    `/sources/${id}/channels${buildQuery({ group, limit, offset })}`),
  getSourceChannelsAll: async (id, group) => fetchAllPages((limit, offset) => request('GET', `/sources/${id}/channels${buildQuery({ group, limit, offset })}`)),
  refreshSource:       (id)         => request('POST',   `/sources/${id}/refresh`),
  getAllSourceGroups:   (playlistId) => request('GET',    `/sources/all/groups${playlistId ? `?playlist_id=${playlistId}` : ''}`),
  getAllSourceChannels: (group, limit, offset) => request('GET', `/sources/all/channels${buildQuery({ group, limit, offset })}`),
  getAllSourceChannelsAll: async (group) => fetchAllPages((limit, offset) => request('GET', `/sources/all/channels${buildQuery({ group, limit, offset })}`)),

  // Playlists
  getPlaylists:        ()           => request('GET',    '/playlists'),
  createPlaylist:      (data)       => request('POST',   '/playlists', data),
  updatePlaylist:      (id, data)   => request('PUT',    `/playlists/${id}`, data),
  deletePlaylist:      (id)         => request('DELETE', `/playlists/${id}`),
  getPlaylistChannels: (id)         => request('GET',    `/playlists/${id}/channels`),
  getPlaylistSelection:(id)         => request('GET',    `/playlists/${id}/selection`),
  savePlaylistChannels:(id, channels) => request('PUT',  `/playlists/${id}/channels`, { channels }),
  savePlaylistByGroups:(id, data)     => request('PUT',  `/playlists/${id}/channels-by-groups`, data),
  buildPlaylist:       (id)         => request('POST',   `/playlists/${id}/build`),
  getGroupOrder:       (id)         => request('GET',    `/playlists/${id}/group-order`),
  saveGroupOrder:      (id, order)  => request('PUT',    `/playlists/${id}/group-order`, { order }),
  getSchedules:        ()           => request('GET',    '/playlists/schedules'),
  saveSchedule:        (id, schedule) => request('PATCH', `/playlists/${id}/schedule`, { schedule }),

  // EPG Mappings
  getEpgMappings:      ()           => request('GET',    '/epg-mappings'),
  createEpgMapping:    (data)       => request('POST',   '/epg-mappings', data),
  deleteEpgMapping:    (id)         => request('DELETE', `/epg-mappings/${id}`),
  autoMatchEpg:        (playlist_id) => request('GET',   `/epg-mappings/auto-match?playlist_id=${playlist_id}`),
  bulkCreateMappings:       (mappings)    => request('POST',   '/epg-mappings/bulk', { mappings }),
  clearPlaylistMappings:    (playlist_id) => request('DELETE', `/epg-mappings/by-playlist/${playlist_id}`),
  patchChannelCustomTvgId: (id, custom_tvg_id) => request('PATCH', `/playlist-channels/${id}/custom-tvg-id`, { custom_tvg_id }),
  patchChannelCustomLogo:  (id, custom_logo)   => request('PATCH', `/playlist-channels/${id}/custom-logo`,   { custom_logo }),
  deletePlaylistChannel:   (id)               => request('DELETE', `/playlist-channels/${id}`),

  getCachedEpgChannels:       ()           => request('GET',  '/epg/cached-channels'),
  createEpgSourceFromScraper: (data)       => request('POST', '/epg/sources/from-scraper', data),

  // Streams
  getStreams:           ()           => request('GET',    '/streams'),
  killStream:          (channelId)  => request('DELETE', `/streams/${channelId}`),
  getPlaylistM3uUrl:   (id)         => `/api/playlists/${id}/m3u`,

  // Settings
  getSettings:         ()           => request('GET',    '/settings'),
  saveSettings:        (data)       => request('PUT',    '/settings', data),
  getHdhrStatus:       ()           => request('GET',    '/hdhr/status'),

  // EPG Scraper — channels.xml management
  getChannelsXml:      ()           => request('GET',    '/epg/channels-xml'),
  saveChannelsXml:     (content)    => request('PUT',    '/epg/channels-xml', { content }),

  // EPG Scraper — iptv-org/epg site browser (DB-backed)
  getEpgSites:         ()           => request('GET',    '/epg/sites'),
  getSiteFiles:        (site)       => request('GET',    `/epg/sites/${encodeURIComponent(site)}/files`),
  getSiteChannels:     (site, file) => request('GET',    `/epg/sites/${encodeURIComponent(site)}/channels${file ? `?file=${encodeURIComponent(file)}` : ''}`),
  searchSiteChannels:  (q, site)    => request('GET',    `/epg/sites/search?q=${encodeURIComponent(q)}${site ? `&site=${encodeURIComponent(site)}` : ''}`),
  getEpgSyncStatus:    ()           => request('GET',    '/epg/sites/sync/status'),
  triggerEpgSync:      ()           => request('POST',   '/epg/sites/sync'),
  getEpgGrabStatus:    ()           => request('GET',    '/epg/grab/status'),
  triggerEpgGrab:      ()           => request('POST',   '/epg/grab'),

  // EPG Scraper — guide.xml preview (output of the scraper)
  getEpgChannels:      (url)        => request('GET',    `/epg/channels${url ? `?url=${encodeURIComponent(url)}` : ''}`),
  searchEpg:           (q, url)     => request('GET',    `/epg/search?q=${encodeURIComponent(q)}${url ? `&url=${encodeURIComponent(url)}` : ''}`),

  // Proxy (for loading M3U URLs via backend)
  proxyUrl:            (url)        => `/api/proxy?url=${encodeURIComponent(url)}`,
}
