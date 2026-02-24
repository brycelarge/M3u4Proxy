/**
 * Stream proxy + session manager
 *
 * - One upstream connection per channel, shared across all clients
 * - Auto-reconnects on upstream drop (up to MAX_RECONNECTS times)
 * - Enforces max_streams per source (from DB)
 */

import { EventEmitter } from 'node:events'
import db from './db.js'

const MAX_RECONNECTS    = parseInt(process.env.STREAM_MAX_RECONNECTS || '5')
const RECONNECT_DELAY   = parseInt(process.env.STREAM_RECONNECT_DELAY || '2000')

// Buffer N seconds of stream data before sending to clients.
// Default 3 seconds helps absorb network jitter and connection drops.
export function getBufferSeconds() {
  try {
    const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxy_buffer_seconds')
    if (setting) {
      return parseFloat(setting.value)
    }
  } catch (e) {
    // Database not ready or error, fall back to env/default
  }
  return parseFloat(process.env.PROXY_BUFFER_SECONDS || '3')
}

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map()

class Session extends EventEmitter {
  constructor(channelId, upstreamUrl, channelName, sourceId, username) {
    super()
    this.setMaxListeners(200)
    this.channelId    = channelId
    this.upstreamUrl  = upstreamUrl
    this.channelName  = channelName
    this.sourceId     = sourceId
    this.username     = username || null
    this.clients      = new Set()
    this.startedAt    = new Date()
    this.bytesIn      = 0
    this.bytesOut     = 0
    this.reconnects   = 0
    this._lastBytes   = 0
    this._lastTick    = Date.now()
    this.bitrate      = 0  // bytes/sec, rolling
    this.abortCtrl    = new AbortController()
    this.dead         = false
    this._bufferStarted = false  // Track if buffer has started streaming
  }

  // Rolling pre-buffer: array of { chunk: Uint8Array, ts: number }
  // Kept trimmed to PROXY_BUFFER_SECONDS worth of data.
  get preBuffer() {
    if (!this._preBuffer) this._preBuffer = []
    return this._preBuffer
  }

  addClient(res) {
    this.clients.add(res)
    res.on('close', () => this.removeClient(res))
  }

  removeClient(res) {
    this.clients.delete(res)
    if (this.clients.size === 0) {
      console.log(`[stream] No clients left for "${this.channelName}" — closing upstream`)
      this.destroy()
    }
  }

  destroy() {
    if (this.dead) return
    this.dead = true
    this.abortCtrl.abort()
    sessions.delete(this.channelId)
    // Record stream history if we have a username
    if (this.username) {
      try {
        const durationS = Math.round((Date.now() - this.startedAt.getTime()) / 1000)
        const row = db.prepare('SELECT group_title FROM playlist_channels WHERE id = ?').get(this.channelId)
        db.prepare(
          `INSERT INTO stream_history (username, channel_id, tvg_name, group_title, started_at, ended_at, duration_s)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
        ).run(this.username, this.channelId, this.channelName, row?.group_title || null, this.startedAt.toISOString(), durationS)
      } catch {}
    }
    this.emit('dead')
  }
}

// ── Max streams check ─────────────────────────────────────────────────────────
function checkMaxStreams(sourceId) {
  if (!sourceId) return null
  const source = db.prepare('SELECT max_streams FROM sources WHERE id = ?').get(sourceId)
  if (!source || !source.max_streams) return null
  const active = [...sessions.values()].filter(s => s.sourceId === sourceId).length
  if (active >= source.max_streams) {
    return `Source has reached its limit of ${source.max_streams} concurrent streams`
  }
  return null
}

// ── Upstream pump with reconnect ──────────────────────────────────────────────
async function pump(session) {
  while (!session.dead) {
    try {
      const upstream = await fetch(session.upstreamUrl, {
        signal: session.abortCtrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; M3UManager/1.0)',
          'Connection': 'keep-alive',
          'Accept': '*/*',
        },
      })

      if (!upstream.ok) {
        console.error(`[stream] Upstream ${upstream.status} for "${session.channelName}"`)
        break
      }

      session.reconnects > 0 && console.log(`[stream] Reconnected to "${session.channelName}" (attempt ${session.reconnects})`)

      const reader = upstream.body.getReader()
      let lastDataTime = Date.now()
      const STALL_TIMEOUT = 30000 // 30 seconds without data = stalled

      while (true) {
        // Add timeout to detect stalled streams
        const readPromise = reader.read()
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stream stalled - no data received')), STALL_TIMEOUT)
        )

        const { done, value } = await Promise.race([readPromise, timeoutPromise])
        if (done || session.dead) break

        lastDataTime = Date.now()
        session.bytesIn += value.length
        const now = Date.now()
        const elapsed = (now - session._lastTick) / 1000
        if (elapsed >= 1) {
          session.bitrate    = Math.round((session.bytesIn - session._lastBytes) / elapsed)
          session._lastBytes = session.bytesIn
          session._lastTick  = now
        }

        // Buffer logic: collect data first, then flush and stream
        const bufSecs = getBufferSeconds()
        if (bufSecs > 0 && !session._bufferStarted) {
          // ALWAYS push to preBuffer while filling
          session.preBuffer.push({ chunk: value, ts: now })

          const bufferAge = session.preBuffer.length > 0 ? now - session.preBuffer[0].ts : 0
          const targetMs = bufSecs * 1000

          // Check if we've reached the 50% threshold
          if (bufferAge >= (targetMs * 0.5)) {
            console.log(`[stream] Buffer ready (${bufferAge}ms). Flushing ${session.preBuffer.length} chunks to clients.`)

            // FLUSH: Send everything we collected to the clients right now
            for (const entry of session.preBuffer) {
              for (const client of session.clients) {
                if (!client.writableEnded) {
                  client.write(entry.chunk)
                  session.bytesOut += entry.chunk.length
                }
              }
              session.emit('chunk', entry.chunk)
            }

            session._bufferStarted = true
            session.preBuffer = [] // Clear memory
          }
          // Don't write current chunk yet - it's in the buffer
        } else {
          // NORMAL FLOW: Buffer is done (or disabled), just stream live
          for (const client of session.clients) {
            if (!client.writableEnded) {
              client.write(value)
              session.bytesOut += value.length
            }
          }
          session.emit('chunk', value)
        }
      }

      if (session.dead) break

      // Stream ended cleanly — reconnect if clients still waiting
      if (session.clients.size === 0) break
      console.log(`[stream] Stream ended for "${session.channelName}" — reconnecting in ${RECONNECT_DELAY}ms…`)
    } catch (e) {
      if (e.name === 'AbortError' || session.dead) break
      console.error(`[stream] Error for "${session.channelName}":`, e.message)
    }

    session.reconnects++
    if (session.reconnects > MAX_RECONNECTS) {
      console.error(`[stream] Max reconnects reached for "${session.channelName}" — giving up`)
      break
    }
    if (session.clients.size === 0) break
    await new Promise(r => setTimeout(r, RECONNECT_DELAY))
  }

  session.destroy()
  for (const client of session.clients) {
    if (!client.writableEnded) client.end()
  }
}

// ── Start or join a stream session ────────────────────────────────────────────
export async function connectClient(channelId, upstreamUrl, channelName, res, sourceId = null, username = null) {
  // Check max_streams limit
  const limitErr = checkMaxStreams(sourceId)
  if (limitErr) {
    res.status(503).json({ error: limitErr })
    return
  }

  // Reuse existing session
  if (sessions.has(channelId)) {
    const session = sessions.get(channelId)
    console.log(`[stream] Client joining "${session.channelName}" (${session.clients.size + 1} clients)`)

    // Set streaming headers
    res.setHeader('Content-Type', 'video/mp2t')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    session.addClient(res)
    // Flush pre-buffer so the joining client starts with data immediately
    if (session._preBuffer?.length) {
      // Send the buffer in order but with minimal delay to prevent jitter
      // This helps ensure smooth playback start
      const bufferChunks = [...session._preBuffer]
      let i = 0

      // Send first chunk immediately to start playback
      if (!res.writableEnded && bufferChunks[0]) {
        res.write(bufferChunks[0].chunk)
        i++
      }

      // Send the rest of the buffer with minimal delay
      const sendNextChunk = () => {
        if (i < bufferChunks.length && !res.writableEnded) {
          res.write(bufferChunks[i].chunk)
          i++
          if (i < bufferChunks.length) {
            setImmediate(sendNextChunk)
          }
        }
      }

      // Start sending the rest of the buffer
      if (i < bufferChunks.length) {
        setImmediate(sendNextChunk)
      }
    }
    const onChunk = (chunk) => { if (!res.writableEnded) res.write(chunk) }
    session.on('chunk', onChunk)
    session.once('dead', () => { session.off('chunk', onChunk); if (!res.writableEnded) res.end() })
    res.on('close', () => session.off('chunk', onChunk))
    return
  }

  // New session
  const bufferSecs = getBufferSeconds()
  console.log(`[stream] Opening "${channelName}" → ${upstreamUrl}`)
  console.log(`[stream] Buffer: ${bufferSecs} seconds${bufferSecs === 0 ? ' (disabled)' : ''}`)
  const session = new Session(channelId, upstreamUrl, channelName, sourceId, username)
  sessions.set(channelId, session)

  // Set streaming headers
  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  session.addClient(res)
  pump(session)
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getActiveSessions() {
  return [...sessions.values()].map(s => ({
    channelId:   s.channelId,
    channelName: s.channelName,
    sourceId:    s.sourceId,
    username:    s.username,
    clients:     s.clients.size,
    startedAt:   s.startedAt,
    bytesIn:     s.bytesIn,
    bytesOut:    s.bytesOut,
    bitrate:     s.bitrate,
    reconnects:  s.reconnects,
    upstreamUrl: s.upstreamUrl,
  }))
}

// Expose for xtream.js connection count check
globalThis.__streamer = { getActiveSessions }

export function killSession(channelId) {
  const s = sessions.get(channelId)
  if (s) s.destroy()
}
