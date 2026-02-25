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

// Helper: Check if buffer contains PES start code for video stream (0x00 0x00 0x01 + video stream ID 0xE0-0xEF)
function hasPesStart(buf) {
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x00 && buf[i+1] === 0x00 && buf[i+2] === 0x01 && (buf[i+3] >= 0xE0 && buf[i+3] <= 0xEF)) {
      return true
    }
  }
  return false
}

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

// Calculate rolling buffer size based on buffer seconds setting
// Assumes ~2 Mbps average bitrate (250 KB/s)
function getRollingBufferSize() {
  const bufferSecs = getBufferSeconds()
  if (bufferSecs === 0) return 0  // No rolling buffer if buffering disabled

  // Calculate size: bufferSeconds * 250 KB/s, minimum 1MB, maximum 10MB
  const calculatedSize = bufferSecs * 250 * 1024
  return Math.max(1 * 1024 * 1024, Math.min(calculatedSize, 10 * 1024 * 1024))
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
    this._recentChunks = []  // Rolling buffer of recent chunks for joining clients (burst-and-bridge)
    this._currentBufferSize = 0  // Track buffer size efficiently without reduce()
    this._rollingBufferStarted = false  // Only start collecting after finding a keyframe
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

        // If FFmpeg is enabled, pipe data through it instead of directly to clients
        if (session.ffmpegRemux && ffmpegResult) {
          // Write to FFmpeg stdin - FFmpeg output handler will send to clients
          if (!ffmpegResult.stdin.destroyed) {
            ffmpegResult.stdin.write(value)
          }
        } else {
          // Normal flow: Buffer logic for direct streaming
          const bufSecs = getBufferSeconds()
          if (bufSecs > 0 && !session._bufferStarted) {
            // ALWAYS push to preBuffer while filling
            session.preBuffer.push({ chunk: value, ts: now })

            const bufferAge = session.preBuffer.length > 0 ? now - session.preBuffer[0].ts : 0
            const targetMs = bufSecs * 1000

            // Check if we've reached the 50% threshold
            if (bufferAge >= (targetMs * 0.5)) {
              console.log(`[stream] Buffer ready (${bufferAge}ms), flushing to clients`)

              // Simple PES start code detection (0x00 0x00 0x01) which often indicates a new frame/keyframe
              const hasPesStart = (buf, startIdx) => {
                for (let i = startIdx; i < Math.min(startIdx + 188 - 3, buf.length - 3); i++) {
                  if (buf[i] === 0x00 && buf[i+1] === 0x00 && buf[i+2] === 0x01) {
                    // Check if it's a video stream (0xE0 - 0xEF)
                    if (buf[i+3] >= 0xE0 && buf[i+3] <= 0xEF) {
                      return true
                    }
                  }
                }
                return false
              }

              // Find sync point in buffered data before flushing
              const combined = Buffer.concat(session.preBuffer.map(e => e.chunk))
              let syncOffset = 0
              let foundKeyframe = false

              // Look for valid MPEG-TS sync point (2 consecutive 0x47 at 188-byte intervals) AND a keyframe
              for (let i = 0; i <= combined.length - 376; i++) {
                if (combined[i] === 0x47 && combined[i + 188] === 0x47) {
                  const pusi = (combined[i+1] & 0x40) !== 0

                  if (pusi && hasPesStart(combined, i)) {
                    syncOffset = i
                    foundKeyframe = true
                    break
                  }
                }
              }

              // Fallback to basic sync if no keyframe found in buffer
              if (!foundKeyframe) {
                for (let i = 0; i <= combined.length - 376; i++) {
                  if (combined[i] === 0x47 && combined[i + 188] === 0x47) {
                    syncOffset = i
                    break
                  }
                }
              }

              // FLUSH: Send from sync point onwards
              const syncedData = combined.slice(syncOffset)

              // Send via event emitter for consistency with normal flow
              session.emit('chunk', syncedData)
              session.bytesOut += (syncedData.length * session.clients.size)

              session._bufferStarted = true
              session._preBuffer = [] // Clear memory
            }
            // Don't write current chunk yet - it's in the buffer
          } else {
            // NORMAL FLOW: Only the event emitter sends data to clients
            // This prevents double-writing to clients who joined via connectClient
            session.emit('chunk', value)

            // Update stats
            session.bytesOut += (value.length * session.clients.size)

            // ROLLING BUFFER: Build the bridge for joining clients
            const isKeyframe = (value[1] & 0x40) !== 0 && hasPesStart(value)

            // Start collecting only once we hit a keyframe to ensure the burst is decodable
            if (!session._rollingBufferStarted && isKeyframe) {
              session._rollingBufferStarted = true
            }

            if (session._rollingBufferStarted) {
              session._recentChunks.push(value)
              session._currentBufferSize += value.length

              // Maintain rolling buffer based on configured buffer seconds
              const maxBufferSize = getRollingBufferSize()
              while (session._currentBufferSize > maxBufferSize && session._recentChunks.length > 0) {
                const removed = session._recentChunks.shift()
                session._currentBufferSize -= removed.length
              }
            }
          }
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
  // Check if response is already sent
  if (res.headersSent) {
    throw new Error('Response headers already sent')
  }

  // Reuse existing session (no limit check needed - not creating new upstream connection)
  if (sessions.has(channelId)) {
    const session = sessions.get(channelId)
    console.log(`[stream] ✓ Client joining "${session.channelName}" (${session.clients.size + 1} clients)`)

    // Set streaming headers
    res.setHeader('Content-Type', 'video/mp2t')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // 1. Prepare the listener BUT don't attach it yet
    const onChunk = (chunk) => {
      if (!res.writableEnded) res.write(chunk)
    }

    // 2. Send the Bridge Data (The Past)
    if (session._recentChunks.length > 0) {
      const bridgeData = Buffer.concat(session._recentChunks)
      res.write(bridgeData)
    }

    // 3. Start listening for the NEXT live chunks
    session.on('chunk', onChunk)

    // 4. Register client ONLY for the "no clients left" logic
    // DO NOT let the loop in pump() write to this 'res' object
    session.clients.add(res)

    res.on('close', () => {
      session.off('chunk', onChunk)
      session.removeClient(res)
    })
    return
  }

  // New session - check max_streams limit before creating
  const limitErr = checkMaxStreams(sourceId)
  if (limitErr) {
    console.log(`[stream] Cannot create new session: ${limitErr}`)
    res.status(503).json({ error: limitErr })
    return
  }

  const bufferSecs = getBufferSeconds()
  console.log(`[stream] Opening "${channelName}" (buffer: ${bufferSecs}s)`)

  const session = new Session(channelId, upstreamUrl, channelName, sourceId, username)
  sessions.set(channelId, session)

  // Set streaming headers
  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // First client also uses event listener pattern for consistency
  const onChunk = (chunk) => {
    if (!res.writableEnded) res.write(chunk)
  }

  session.on('chunk', onChunk)
  session.clients.add(res)

  res.on('close', () => {
    session.off('chunk', onChunk)
    session.removeClient(res)
  })

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
