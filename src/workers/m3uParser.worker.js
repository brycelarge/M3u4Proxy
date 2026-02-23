// Phase 1: extract group names + counts only (fast, no channel objects)
function parseGroups(text) {
  const groups = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.startsWith('#EXTINF')) continue
    const g = line.match(/group-title="([^"]*)"/)?.[1]?.trim()
    const key = g || inferGroup(line.match(/,(.+)$/)?.[1]?.trim() || '')
    groups[key] = (groups[key] || 0) + 1
  }
  return Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }))
}

// Phase 2: extract channels for a specific group only
function parseGroupChannels(text, groupName) {
  const lines = text.split(/\r?\n/)
  const channels = []
  let current = null
  let id = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('#EXTINF')) {
      const nameMatch = trimmed.match(/,(.+)$/)
      const name = trimmed.match(/tvg-name="([^"]*)"/)?.[1] || nameMatch?.[1]?.trim() || 'Unknown'
      const groupAttr = trimmed.match(/group-title="([^"]*)"/)?.[1]?.trim()
      const group = (groupAttr && groupAttr.length) ? groupAttr : inferGroup(name)
      if (group !== groupName) { current = null; continue }
      current = {
        id: id++,
        name,
        tvgId: trimmed.match(/tvg-id="([^"]*)"/)?.[1] || '',
        tvgLogo: trimmed.match(/tvg-logo="([^"]*)"/)?.[1] || '',
        group,
        url: '',
        raw: trimmed,
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

// Store raw text between phases so we don't re-transfer it
let cachedText = null

self.onmessage = (e) => {
  const { type, text, groupName } = e.data

  if (type === 'parse-groups') {
    cachedText = text
    try {
      const groups = parseGroups(text)
      self.postMessage({ ok: true, type: 'groups', groups })
    } catch (err) {
      self.postMessage({ ok: false, error: err.message })
    }
  } else if (type === 'parse-channels') {
    const src = text || cachedText
    if (!src) { self.postMessage({ ok: false, error: 'No text cached' }); return }
    try {
      const channels = parseGroupChannels(src, groupName)
      self.postMessage({ ok: true, type: 'channels', channels, groupName })
    } catch (err) {
      self.postMessage({ ok: false, error: err.message })
    }
  }
}

export {}
