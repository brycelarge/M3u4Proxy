export function buildM3U(channels) {
  const lines = ['#EXTM3U']
  for (const ch of channels) {
    lines.push(ch.raw)
    lines.push(ch.url)
  }
  return lines.join('\n')
}

function proxyUrl(url) {
  return `/api/proxy?url=${encodeURIComponent(url)}`
}

// ── Persistent worker that caches raw text between phases ─────────────────────
let _worker = null

function getWorker() {
  if (!_worker) {
    _worker = new Worker(
      new URL('../workers/m3uParser.worker.js', import.meta.url),
      { type: 'module' },
    )
  }
  return _worker
}

export function destroyWorker() {
  if (_worker) { _worker.terminate(); _worker = null }
}

function workerRequest(msg) {
  return new Promise((resolve, reject) => {
    const w = getWorker()
    const handler = (e) => {
      w.removeEventListener('message', handler)
      w.removeEventListener('error', errHandler)
      e.data.ok ? resolve(e.data) : reject(new Error(e.data.error))
    }
    const errHandler = (e) => {
      w.removeEventListener('message', handler)
      w.removeEventListener('error', errHandler)
      reject(new Error(e.message))
    }
    w.addEventListener('message', handler)
    w.addEventListener('error', errHandler)
    w.postMessage(msg)
  })
}

// Phase 1: stream text, send to worker, get back group list only
export async function loadM3UText(text, onProgress) {
  if (onProgress) onProgress(100)
  const result = await workerRequest({ type: 'parse-groups', text })
  return result.groups // [{ name, count }]
}

// Phase 2: get channels for a specific group (worker uses cached text)
export async function loadGroupChannels(groupName) {
  const result = await workerRequest({ type: 'parse-channels', groupName })
  return result.channels
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
export async function fetchM3UUrl(url, onProgress) {
  const res = await fetch(proxyUrl(url))
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)

  const contentLength = res.headers.get('content-length')
  const total = contentLength ? parseInt(contentLength) : 0
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    text += decoder.decode(value, { stream: true })
    if (onProgress && total) onProgress(Math.round((received / total) * 100))
  }

  if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
    throw new Error('Response does not appear to be a valid M3U file')
  }

  return loadM3UText(text, onProgress)
}

export function readM3UFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => loadM3UText(e.target.result).then(resolve).catch(reject)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
