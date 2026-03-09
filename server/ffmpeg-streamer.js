import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import db from './db.js'
import { getBufferSeconds } from './streamer.js'

const MAX_RECONNECTS = parseInt(process.env.STREAM_MAX_RECONNECTS || '5')
const RECONNECT_DELAY = parseInt(process.env.STREAM_RECONNECT_DELAY || '2000')

const sessions = new Map()

function getRollingBufferSize() {
  const bufferSecs = getBufferSeconds()
  if (bufferSecs === 0) return 0

  const calculatedSize = bufferSecs * 250 * 1024
  return Math.max(1 * 1024 * 1024, Math.min(calculatedSize, 10 * 1024 * 1024))
}

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

export function isFfmpegRemuxEnabled() {
  try {
    const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('remux_live_tv')
    return setting ? setting.value === 'true' : false
  } catch {
    return false
  }
}

class FfmpegSession extends EventEmitter {
  constructor(channelId, upstreamUrl, channelName, sourceId, username) {
    super()
    this.setMaxListeners(200)
    this.channelId = channelId
    this.upstreamUrl = upstreamUrl
    this.channelName = channelName
    this.sourceId = sourceId
    this.username = username || null
    this.clients = new Set()
    this.startedAt = new Date()
    this.bytesIn = 0
    this.bytesOut = 0
    this.reconnects = 0
    this._lastBytes = 0
    this._lastTick = Date.now()
    this.bitrate = 0
    this.dead = false
    this.upstreamAbortCtrl = null
    this.ffmpegProcess = null
    this._ffmpegStarted = false
    this._bufferStarted = false
    this._recentChunks = []
    this._currentBufferSize = 0
  }

  get preBuffer() {
    if (!this._preBuffer) this._preBuffer = []
    return this._preBuffer
  }

  addClient(res) {
    this.clients.add(res)

    const cleanup = () => this.removeClient(res)
    res.on('close', cleanup)
    res.on('error', cleanup)
    res.on('finish', cleanup)
  }

  removeClient(res) {
    this.clients.delete(res)
    if (this.clients.size === 0) {
      console.log(`[ffmpeg-stream] No clients left for "${this.channelName}" — closing upstream`)
      this.destroy()
    }
  }

  destroy() {
    if (this.dead) return
    this.dead = true

    try {
      this.upstreamAbortCtrl?.abort()
    } catch {}

    if (this.ffmpegProcess) {
      try {
        if (!this.ffmpegProcess.stdin.destroyed) this.ffmpegProcess.stdin.end()
      } catch {}
      try {
        if (!this.ffmpegProcess.killed) this.ffmpegProcess.kill('SIGKILL')
      } catch {}
      this.ffmpegProcess = null
    }

    sessions.delete(this.channelId)

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

function attachClient(session, res) {
  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const onChunk = (chunk) => {
    if (!res.writableEnded) res.write(chunk)
  }

  if (session._recentChunks.length > 0) {
    const bridgeData = Buffer.concat(session._recentChunks)
    res.write(bridgeData)
  }

  session.on('chunk', onChunk)
  session.addClient(res)

  res.on('close', () => {
    session.off('chunk', onChunk)
  })
  res.on('error', () => {
    session.off('chunk', onChunk)
  })
  res.on('finish', () => {
    session.off('chunk', onChunk)
  })
}

function startFfmpeg(session) {
  const ffmpegArgs = [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0?',
    '-map', '0:a?',
    '-map', '0:s?',
    '-c', 'copy',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'mpegts',
    'pipe:1',
  ]

  console.log(`[ffmpeg-stream] Starting remux for "${session.channelName}"`)
  session.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] })

  session.ffmpegProcess.on('error', (error) => {
    if (session.dead) return
    console.error(`[ffmpeg-stream] FFmpeg process error for "${session.channelName}":`, error.message)
  })

  session.ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg) {
      console.error(`[ffmpeg-stream] FFmpeg stderr for "${session.channelName}": ${msg}`)
    }
  })

  session.ffmpegProcess.stdout.on('data', (chunk) => {
    if (session.dead) return

    session._ffmpegStarted = true
    const now = Date.now()
    const value = Buffer.from(chunk)

    session.bytesIn += value.length
    const elapsed = (now - session._lastTick) / 1000
    if (elapsed >= 1) {
      session.bitrate = Math.round((session.bytesIn - session._lastBytes) / elapsed)
      session._lastBytes = session.bytesIn
      session._lastTick = now
    }

    const bufSecs = getBufferSeconds()
    if (bufSecs > 0 && !session._bufferStarted) {
      session.preBuffer.push({ chunk: value, ts: now })

      const bufferAge = session.preBuffer.length > 0 ? now - session.preBuffer[0].ts : 0
      const targetMs = bufSecs * 1000

      if (bufferAge >= (targetMs * 0.5)) {
        console.log(`[ffmpeg-stream] Buffer ready (${bufferAge}ms), flushing to clients`)
        const syncedData = Buffer.concat(session.preBuffer.map(entry => entry.chunk))
        session.emit('chunk', syncedData)
        session.bytesOut += (syncedData.length * session.clients.size)
        session._bufferStarted = true
        session._preBuffer = []
      }
    } else {
      session.emit('chunk', value)
      session.bytesOut += (value.length * session.clients.size)

      session._recentChunks.push(value)
      session._currentBufferSize += value.length

      const maxBufferSize = getRollingBufferSize()
      while (session._currentBufferSize > maxBufferSize && session._recentChunks.length > 0) {
        const removed = session._recentChunks.shift()
        session._currentBufferSize -= removed.length
      }
    }
  })

  session.ffmpegProcess.on('exit', (code, signal) => {
    if (session.dead) return
    console.log(`[ffmpeg-stream] FFmpeg exited for "${session.channelName}": code=${code}, signal=${signal}`)
    try {
      session.upstreamAbortCtrl?.abort()
    } catch {}
  })
}

async function pump(session) {
  while (!session.dead) {
    session.upstreamAbortCtrl = new AbortController()

    try {
      startFfmpeg(session)

      const upstream = await fetch(session.upstreamUrl, {
        signal: session.upstreamAbortCtrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; M3UManager/1.0)',
          'Connection': 'keep-alive',
          'Accept': '*/*',
        },
      })

      if (!upstream.ok) {
        console.error(`[ffmpeg-stream] Upstream ${upstream.status} for "${session.channelName}"`)
        break
      }

      session.reconnects > 0 && console.log(`[ffmpeg-stream] Reconnected to "${session.channelName}" (attempt ${session.reconnects})`)

      const reader = upstream.body.getReader()
      let lastDataTime = Date.now()
      const STALL_TIMEOUT = 30000

      const watchdog = setInterval(() => {
        if (Date.now() - lastDataTime > STALL_TIMEOUT && !session.dead) {
          console.error(`[ffmpeg-stream] Watchdog triggered for "${session.channelName}": No data received for ${STALL_TIMEOUT / 1000}s. Forcing reconnect...`)
          try { session.upstreamAbortCtrl.abort() } catch {}
        }
      }, 5000)

      try {
        while (true) {
          const readPromise = reader.read()
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Stream stalled - no data received')), STALL_TIMEOUT)
          )

          const { done, value } = await Promise.race([readPromise, timeoutPromise])
          if (done || session.dead) break

          lastDataTime = Date.now()
          if (session.ffmpegProcess && !session.ffmpegProcess.stdin.destroyed) {
            session.ffmpegProcess.stdin.write(value)
          }
        }

        if (session.ffmpegProcess && !session.ffmpegProcess.stdin.destroyed) {
          session.ffmpegProcess.stdin.end()
        }
      } finally {
        clearInterval(watchdog)
      }

      if (session.dead) break
      if (session.clients.size === 0) break
      console.log(`[ffmpeg-stream] Stream ended for "${session.channelName}" — reconnecting in ${RECONNECT_DELAY}ms…`)
    } catch (error) {
      if (error.name === 'AbortError' || session.dead) break
      console.error(`[ffmpeg-stream] Error for "${session.channelName}":`, error.message)
    }

    session.reconnects++
    if (session.reconnects > MAX_RECONNECTS) {
      console.error(`[ffmpeg-stream] Max reconnects reached for "${session.channelName}" — giving up`)
      break
    }
    if (session.clients.size === 0) break

    if (session.ffmpegProcess) {
      try {
        if (!session.ffmpegProcess.killed) session.ffmpegProcess.kill('SIGKILL')
      } catch {}
      session.ffmpegProcess = null
    }

    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY))
  }

  session.destroy()
  for (const client of session.clients) {
    if (!client.writableEnded) client.end()
  }
}

export async function connectFfmpegClient(channelId, upstreamUrl, channelName, res, sourceId = null, username = null) {
  if (res.headersSent) {
    throw new Error('Response headers already sent')
  }

  if (sessions.has(channelId)) {
    const session = sessions.get(channelId)
    console.log(`[ffmpeg-stream] ✓ Client joining "${session.channelName}" (${session.clients.size + 1} clients)`)
    attachClient(session, res)
    return
  }

  const limitErr = checkMaxStreams(sourceId)
  if (limitErr) {
    console.log(`[ffmpeg-stream] Cannot create new session: ${limitErr}`)
    res.status(503).json({ error: limitErr })
    return
  }

  const bufferSecs = getBufferSeconds()
  console.log(`[ffmpeg-stream] Opening "${channelName}" (buffer: ${bufferSecs}s)`)

  const session = new FfmpegSession(channelId, upstreamUrl, channelName, sourceId, username)
  sessions.set(channelId, session)

  attachClient(session, res)
  pump(session)
}

export function getActiveFfmpegSessions() {
  return [...sessions.values()].map(session => ({
    channelId: session.channelId,
    channelName: session.channelName,
    sourceId: session.sourceId,
    username: session.username,
    clients: session.clients.size,
    startedAt: session.startedAt,
    bytesIn: session.bytesIn,
    bytesOut: session.bytesOut,
    bitrate: session.bitrate,
    reconnects: session.reconnects,
    upstreamUrl: session.upstreamUrl,
  }))
}

export function killFfmpegSession(channelId) {
  const session = sessions.get(channelId)
  if (session) session.destroy()
}
