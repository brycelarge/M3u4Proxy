import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import db from './db.js'
import { getBufferSeconds } from './streamer.js'

const MAX_RECONNECTS = parseInt(process.env.STREAM_MAX_RECONNECTS || '5')
const RECONNECT_DELAY = parseInt(process.env.STREAM_RECONNECT_DELAY || '2000')

function getSettingValue(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
}

export function getDefaultFfmpegStreamOptions() {
  return '-loglevel error -i {input} -map 0:v:0? -map 0:a? -map 0:s? -c copy -muxdelay 0 -muxpreload 0 -f mpegts {output}'
}

export function getDefaultVlcStreamOptions() {
  return '{input} --sout #std{access=file,mux=ts,dst={output}} --intf dummy --quiet'
}

export function getStreamBufferMode() {
  const mode = getSettingValue('stream_buffer_mode')
  if (mode === 'ffmpeg' || mode === 'm3u4prox' || mode === 'vlc') {
    return mode
  }

  const remuxSetting = getSettingValue('remux_live_tv')
  return remuxSetting === 'true' ? 'ffmpeg' : 'm3u4prox'
}

function getConfiguredFfmpegOptions() {
  return getSettingValue('ffmpeg_stream_options') || getDefaultFfmpegStreamOptions()
}

function getConfiguredVlcOptions() {
  return getSettingValue('vlc_stream_options') || getDefaultVlcStreamOptions()
}

function parseCliArgs(optionString) {
  const matches = String(optionString || '').match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) || []
  return matches.map(token => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1)
    }
    return token
  })
}

function buildProcessConfig(mode, upstreamUrl) {
  if (mode === 'vlc') {
    const args = parseCliArgs(getConfiguredVlcOptions())
      .map(arg => arg.replaceAll('{input}', upstreamUrl).replaceAll('{output}', '-'))
    return {
      command: 'cvlc',
      args,
      env: {
        ...process.env,
        HOME: process.env.HOME || '/tmp',
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/tmp/.config',
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/tmp/.cache',
      },
    }
  }

  const args = parseCliArgs(getConfiguredFfmpegOptions())
    .map(arg => arg.replaceAll('{input}', upstreamUrl).replaceAll('{output}', 'pipe:1'))
  return { command: 'ffmpeg', args, env: process.env }
}

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
    return getStreamBufferMode() === 'ffmpeg'
  } catch {
    return false
  }
}

class FfmpegSession extends EventEmitter {
  constructor(channelId, upstreamUrl, channelName, sourceId, username, mode = 'ffmpeg') {
    super()
    this.setMaxListeners(200)
    this.channelId = channelId
    this.upstreamUrl = upstreamUrl
    this.channelName = channelName
    this.sourceId = sourceId
    this.username = username || null
    this.mode = mode
    this.clients = new Set()
    this.startedAt = new Date()
    this.bytesIn = 0
    this.bytesOut = 0
    this.reconnects = 0
    this._lastBytes = 0
    this._lastTick = Date.now()
    this.bitrate = 0
    this.dead = false
    this.process = null
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
      console.log(`[buffer-stream] No clients left for "${this.channelName}" — closing upstream`)
      this.destroy()
    }
  }

  destroy() {
    if (this.dead) return
    this.dead = true

    if (this.process) {
      try {
        if (this.process.stdin && !this.process.stdin.destroyed) this.process.stdin.end()
      } catch {}
      try {
        if (!this.process.killed) this.process.kill('SIGKILL')
      } catch {}
      this.process = null
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

function startProcess(session) {
  const processConfig = buildProcessConfig(session.mode, session.upstreamUrl)
  console.log(`[buffer-stream] Starting ${session.mode} remux for "${session.channelName}"`)
  session.process = spawn(processConfig.command, processConfig.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: processConfig.env,
  })

  session.process.on('error', (error) => {
    if (session.dead) return
    console.error(`[buffer-stream] ${session.mode} process error for "${session.channelName}":`, error.message)
  })

  session.process.stderr.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg) {
      console.error(`[buffer-stream] ${session.mode} stderr for "${session.channelName}": ${msg}`)
    }
  })

  session.process.stdout.on('data', (chunk) => {
    if (session.dead) return

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
        console.log(`[buffer-stream] Buffer ready (${bufferAge}ms), flushing to clients`)
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

  session.process.on('exit', (code, signal) => {
    if (session.dead) return
    console.log(`[buffer-stream] ${session.mode} exited for "${session.channelName}": code=${code}, signal=${signal}`)
  })
}

async function pump(session) {
  while (!session.dead) {
    try {
      startProcess(session)

      session.reconnects > 0 && console.log(`[buffer-stream] Reconnected to "${session.channelName}" (attempt ${session.reconnects})`)

      await new Promise(resolve => {
        const handleExit = () => resolve()
        session.process.once('exit', handleExit)
        session.process.once('error', handleExit)
      })

      if (session.dead) break
      if (session.clients.size === 0) break
      console.log(`[buffer-stream] ${session.mode} stream ended for "${session.channelName}" — reconnecting in ${RECONNECT_DELAY}ms…`)
    } catch (error) {
      if (session.dead) break
      console.error(`[buffer-stream] Error for "${session.channelName}":`, error.message)
    }

    session.reconnects++
    if (session.reconnects > MAX_RECONNECTS) {
      console.error(`[buffer-stream] Max reconnects reached for "${session.channelName}" — giving up`)
      break
    }
    if (session.clients.size === 0) break

    if (session.process) {
      try {
        if (!session.process.killed) session.process.kill('SIGKILL')
      } catch {}
      session.process = null
    }

    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY))
  }

  session.destroy()
  for (const client of session.clients) {
    if (!client.writableEnded) client.end()
  }
}

async function connectProcessClient(channelId, upstreamUrl, channelName, res, sourceId = null, username = null, mode = 'ffmpeg') {
  if (res.headersSent) {
    throw new Error('Response headers already sent')
  }

  if (sessions.has(channelId)) {
    const session = sessions.get(channelId)
    console.log(`[buffer-stream] ✓ Client joining "${session.channelName}" (${session.clients.size + 1} clients)`)
    attachClient(session, res)
    return
  }

  const limitErr = checkMaxStreams(sourceId)
  if (limitErr) {
    console.log(`[buffer-stream] Cannot create new session: ${limitErr}`)
    res.status(503).json({ error: limitErr })
    return
  }

  const bufferSecs = getBufferSeconds()
  console.log(`[buffer-stream] Opening "${channelName}" via ${mode} (buffer: ${bufferSecs}s)`)

  const session = new FfmpegSession(channelId, upstreamUrl, channelName, sourceId, username, mode)
  sessions.set(channelId, session)

  attachClient(session, res)
  pump(session)
}

export async function connectFfmpegClient(channelId, upstreamUrl, channelName, res, sourceId = null, username = null) {
  await connectProcessClient(channelId, upstreamUrl, channelName, res, sourceId, username, 'ffmpeg')
}

export async function connectVlcClient(channelId, upstreamUrl, channelName, res, sourceId = null, username = null) {
  await connectProcessClient(channelId, upstreamUrl, channelName, res, sourceId, username, 'vlc')
}

export function getActiveFfmpegSessions() {
  return [...sessions.values()].map(session => ({
    channelId: session.channelId,
    channelName: session.channelName,
    mode: session.mode,
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
