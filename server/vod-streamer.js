/**
 * VOD (Video on Demand) streaming proxy
 * 
 * Handles MP4/MKV/AVI files with:
 * - Range request support for seeking
 * - Session sharing (multiple clients can watch same movie)
 * - Grace period before closing upstream (handles client reconnects)
 */

import { EventEmitter } from 'node:events'

const GRACE_PERIOD_MS = 500 // Keep connection alive 0.5s after last client disconnects

// ── Session store ─────────────────────────────────────────────────────────────
const vodSessions = new Map()

class VodSession extends EventEmitter {
  constructor(channelId, upstreamUrl, channelName, username) {
    super()
    this.setMaxListeners(200)
    this.channelId = channelId
    this.upstreamUrl = upstreamUrl
    this.channelName = channelName
    this.username = username || null
    this.clients = new Set()
    this.startedAt = new Date()
    this.bytesOut = 0
    this.dead = false
    this.graceTimer = null
  }

  addClient(res) {
    // Cancel grace period if client reconnects
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
      console.log(`[vod] Client reconnected to "${this.channelName}" within grace period`)
    }
    
    this.clients.add(res)
    res.on('close', () => this.removeClient(res))
  }

  removeClient(res) {
    this.clients.delete(res)
    
    if (this.clients.size === 0) {
      console.log(`[vod] No clients left for "${this.channelName}" — starting grace period (${GRACE_PERIOD_MS}ms)`)
      
      // Don't destroy immediately - wait for potential reconnect
      this.graceTimer = setTimeout(() => {
        console.log(`[vod] Grace period expired for "${this.channelName}" — closing session`)
        this.destroy()
      }, GRACE_PERIOD_MS)
    }
  }

  destroy() {
    if (this.dead) return
    this.dead = true
    
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    
    vodSessions.delete(this.channelId)
    this.emit('dead')
  }
}

// ── Stream VOD with range support ────────────────────────────────────────────
export async function connectVodClient(channelId, upstreamUrl, channelName, req, res, username = null) {
  if (res.headersSent) {
    throw new Error('Response headers already sent')
  }

  const range = req.headers.range
  console.log(`[vod] Request for "${channelName}" (range: ${range || 'none'})`)

  // For range requests, always fetch fresh (can't reuse partial content streams)
  // Only session-share for full file requests (no range header)
  if (!range && vodSessions.has(channelId)) {
    const session = vodSessions.get(channelId)
    console.log(`[vod] ✓ Client joining "${session.channelName}" (${session.clients.size + 1} clients)`)
    
    // Can't really share MP4 streams effectively since each client may seek differently
    // Just track for stats but serve independently
    session.addClient(res)
    
    // Fall through to fetch - each client gets own stream for now
    // TODO: Could implement smart caching here later
  }

  try {
    const headers = {
      'User-Agent': req.get('user-agent') || 'Mozilla/5.0 (compatible; M3UManager/1.0)',
      'Connection': 'keep-alive',
    }

    if (range) {
      headers['Range'] = range
    }

    const upstream = await fetch(upstreamUrl, { headers })

    if (!upstream.ok) {
      console.error(`[vod] Upstream ${upstream.status} for "${channelName}"`)
      return res.status(upstream.status).send('Upstream error')
    }

    // Forward upstream headers
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    const contentLength = upstream.headers.get('content-length')
    const acceptRanges = upstream.headers.get('accept-ranges')
    const contentRange = upstream.headers.get('content-range')

    if (contentType) res.setHeader('Content-Type', contentType)
    if (contentLength) res.setHeader('Content-Length', contentLength)
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges)
    if (contentRange) res.setHeader('Content-Range', contentRange)

    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Create or get session for tracking
    let session = vodSessions.get(channelId)
    if (!session) {
      session = new VodSession(channelId, upstreamUrl, channelName, username)
      vodSessions.set(channelId, session)
      console.log(`[vod] New session for "${channelName}"`)
    }

    session.addClient(res)

    // Stream the response
    const { Readable } = await import('node:stream')
    const readable = Readable.fromWeb(upstream.body)

    let bytesStreamed = 0
    readable.on('data', (chunk) => {
      bytesStreamed += chunk.length
      session.bytesOut += chunk.length
    })

    readable.on('error', (err) => {
      console.error(`[vod] Stream error for "${channelName}":`, err.message)
      if (!res.writableEnded) res.end()
    })

    readable.on('end', () => {
      console.log(`[vod] Stream complete for "${channelName}" (${bytesStreamed} bytes)`)
    })

    res.on('close', () => {
      readable.destroy()
      session.removeClient(res)
    })

    readable.pipe(res)

  } catch (e) {
    console.error(`[vod] Fetch error for "${channelName}":`, e.message)
    if (!res.headersSent) res.status(502).send('Failed to fetch VOD')
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getActiveVodSessions() {
  return [...vodSessions.values()].map(s => ({
    channelId: s.channelId,
    channelName: s.channelName,
    username: s.username,
    clients: s.clients.size,
    startedAt: s.startedAt,
    bytesOut: s.bytesOut,
    upstreamUrl: s.upstreamUrl,
  }))
}

export function killVodSession(channelId) {
  const s = vodSessions.get(channelId)
  if (s) s.destroy()
}
