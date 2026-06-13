import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectClient } from './streamer.js'

// Active composite sessions map
const compositeSessions = new Map()

// Layout presets for common configurations
export const LAYOUT_PRESETS = {
  'main-pip-right': {
    resolution: '1920x1080',
    sources: {
      main: { x: 0, y: 0, w: 1600, h: 1080 },
      pip1: { x: 1600, y: 20, w: 300, h: 169 },
      pip2: { x: 1600, y: 209, w: 300, h: 169 }
    }
  },
  'quad-split': {
    resolution: '1920x1080',
    sources: {
      main: { x: 0, y: 0, w: 960, h: 540 },
      pip1: { x: 960, y: 0, w: 960, h: 540 },
      pip2: { x: 0, y: 540, w: 960, h: 540 },
      pip3: { x: 960, y: 540, w: 960, h: 540 }
    }
  },
  'main-pip-grid': {
    resolution: '1920x1080',
    sources: {
      main: { x: 0, y: 0, w: 1440, h: 1080 },
      pip1: { x: 1440, y: 0, w: 240, h: 135 },
      pip2: { x: 1680, y: 0, w: 240, h: 135 },
      pip3: { x: 1440, y: 135, w: 240, h: 135 },
      pip4: { x: 1680, y: 135, w: 240, h: 135 }
    }
  },
  'side-by-side': {
    resolution: '1920x1080',
    sources: {
      main: { x: 0, y: 0, w: 960, h: 1080 },
      pip1: { x: 960, y: 0, w: 960, h: 1080 }
    }
  }
}

export class CompositeSession extends EventEmitter {
  constructor(compositeId, config, db, username = null) {
    super()
    this.compositeId = compositeId
    this.config = config
    this.db = db
    this.username = username
    this.sourceSessions = new Map() // role -> session info
    this.ffmpegProcess = null
    this.clients = new Set()
    this.hlsViewers = new Map() // clientId -> lastSeenTimestamp
    this._hlsViewerCleanup = null
    this.outputPath = join(process.env.TRANSCODE_DIR || '/transcode', 'composite-streams', `${compositeId}`)
    this.dead = false
    this.startTime = null
    this.lastActivity = Date.now()
    this.internalStreamPort = process.env.PORT || 3005
  }

  async start() {
    if (this.dead) throw new Error('Session is dead')
    if (this.ffmpegProcess) throw new Error('Session already started')

    console.log(`[composite-${this.compositeId}] Starting composite session`)
    this.startTime = Date.now()

    try {
      // Create output directory
      mkdirSync(this.outputPath, { recursive: true })

      // Open source streams via streamer.js
      await this.openSourceStreams()

      // Build and start FFmpeg process
      await this.startFFmpeg()

      console.log(`[composite-${this.compositeId}] Session started successfully`)
    } catch (error) {
      console.error(`[composite-${this.compositeId}] Failed to start:`, error.message)
      await this.destroy()
      throw error
    }
  }

  async openSourceStreams() {
    console.log(`[composite-${this.compositeId}] Opening source streams`)

    const sources = this.db.prepare(`
      SELECT css.*, pc.url, pc.tvg_name, pc.source_id
      FROM composite_stream_sources css
      JOIN playlist_channels pc ON css.source_channel_id = pc.id
      WHERE css.composite_stream_id = ?
      ORDER BY css.role
    `).all(this.compositeId)

    if (sources.length === 0) {
      throw new Error('No source channels configured')
    }

    // Validate source URLs are accessible (skip HEAD, many streams don't support it)
    const unavailableSources = []
    for (const source of sources) {
      try {
        const testResponse = await fetch(source.url, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        })
        if (!testResponse.ok && testResponse.status !== 405) {
          unavailableSources.push(`${source.tvg_name} (${testResponse.status})`)
        }
      } catch (error) {
        unavailableSources.push(`${source.tvg_name} (${error.message})`)
      }
    }

    if (unavailableSources.length > 0) {
      throw new Error(`Source channels unavailable: ${unavailableSources.join(', ')}`)
    }

    for (const source of sources) {
      const internalUrl = `http://localhost:${this.internalStreamPort}/internal-stream/composite-${this.compositeId}-${source.role}`

      this.sourceSessions.set(source.role, {
        channelId: source.source_channel_id,
        url: source.url,
        name: source.tvg_name,
        sourceId: source.source_id,
        internalUrl,
        role: source.role,
        position: {
          x: source.position_x,
          y: source.position_y,
          w: source.width,
          h: source.height
        }
      })

      console.log(`[composite-${this.compositeId}] Registered source: ${source.role} -> ${source.tvg_name}`)
    }
  }

  buildFFmpegCommand() {
    const layoutConfig = JSON.parse(this.config.layout_config)
    const audioConfig = JSON.parse(this.config.audio_config)
    const settings = this.getSettings()

    const inputs = []
    const filterParts = []
    const audioMaps = []
    const videoMap = []
    let filterIndex = 0

    const [canvasW, canvasH] = (layoutConfig.resolution || '1920x1080').split('x').map(Number)
    const sourceArray = Array.from(this.sourceSessions.entries())

    // Add blank canvas as lavfi input (index 0)
    inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${canvasW}x${canvasH}:r=30`)

    // Build source inputs and scale filters (indices 1, 2, ...)
    for (const [role, session] of this.sourceSessions.entries()) {
      inputs.push('-i', session.internalUrl)

      const pos = session.position
      if (pos && pos.w && pos.h) {
        filterParts.push(`[${filterIndex + 1}:v]scale=${pos.w}:${pos.h}[v${filterIndex}]`)
      } else {
        filterParts.push(`[${filterIndex + 1}:v]copy[v${filterIndex}]`)
      }

      filterIndex++
    }

    // Overlay all sources onto the base canvas
    let overlayChain = '[0:v]'
    let overlayIndex = 1

    for (let i = 0; i < sourceArray.length; i++) {
      const [role, session] = sourceArray[i]
      const pos = session.position

      if (i === sourceArray.length - 1) {
        filterParts.push(`${overlayChain}[v${i}]overlay=${pos.x}:${pos.y}[out]`)
      } else {
        filterParts.push(`${overlayChain}[v${i}]overlay=${pos.x}:${pos.y}[tmp${overlayIndex}]`)
        overlayChain = `[tmp${overlayIndex}]`
        overlayIndex++
      }
    }

    const filterComplex = filterParts.join(';')

    // Video mapping
    videoMap.push('-map', '[out]')

    // Audio mapping - sources are at indices 1, 2, ...
    for (let i = 0; i < sourceArray.length; i++) {
      audioMaps.push('-map', `${i + 1}:a?`)
    }

    // Build complete command
    const cmd = [
      '-loglevel', 'warning',
      '-stats',
      ...inputs,
      '-filter_complex', filterComplex,
      ...videoMap,
      ...audioMaps,
      '-c:v', 'libx264',
      '-preset', settings.encoding_preset,
      '-crf', '23',
      '-maxrate', settings.video_bitrate,
      '-bufsize', `${parseInt(settings.video_bitrate) * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', settings.audio_bitrate,
      '-ac', '2',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', join(this.outputPath, 'segment_%03d.ts'),
      join(this.outputPath, 'playlist.m3u8')
    ]

    // Add hardware acceleration if configured with a valid specific decoder
    const validHwaccels = ['cuda', 'vaapi', 'dxva2', 'videotoolbox', 'qsv', 'drm', 'opencl']
    if (settings.hwaccel && validHwaccels.includes(settings.hwaccel)) {
      cmd.unshift('-hwaccel', settings.hwaccel)
    }

    return cmd
  }

  async startFFmpeg() {
    const cmd = this.buildFFmpegCommand()

    console.log(`[composite-${this.compositeId}] Starting FFmpeg:`, 'ffmpeg', cmd.join(' '))

    this.ffmpegProcess = spawn('ffmpeg', cmd, {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.ffmpegProcess.stdout.on('data', (data) => {
      // Log FFmpeg stats periodically
      const output = data.toString()
      if (output.includes('frame=')) {
        console.log(`[composite-${this.compositeId}] ${output.trim()}`)
      }
    })

    this.ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString().trim()
      if (output) {
        console.error(`[composite-${this.compositeId}] FFmpeg:`, output)
      }
    })

    this.ffmpegProcess.on('exit', (code, signal) => {
      console.log(`[composite-${this.compositeId}] FFmpeg exited: code=${code}, signal=${signal}`)
      if (!this.dead) {
        this.emit('ffmpeg-exit', { code, signal })
        // Auto-restart on unexpected exit?
        if (code !== 0 && this.clients.size > 0) {
          console.log(`[composite-${this.compositeId}] Attempting restart...`)
          setTimeout(() => this.restart(), 2000)
        }
      }
    })

    // Wait for playlist to be created
    await this.waitForPlaylist()
  }

  async waitForPlaylist(timeout = 30000) {
    const playlistPath = join(this.outputPath, 'playlist.m3u8')
    const startTime = Date.now()

    while (!existsSync(playlistPath)) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for HLS playlist')
      }
      if (this.ffmpegProcess && this.ffmpegProcess.exitCode !== null) {
        throw new Error(`FFmpeg exited with code ${this.ffmpegProcess.exitCode} before creating playlist`)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log(`[composite-${this.compositeId}] HLS playlist ready`)
  }

  async restart() {
    console.log(`[composite-${this.compositeId}] Restarting session`)

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGKILL')
      this.ffmpegProcess = null
    }

    try {
      await this.startFFmpeg()
    } catch (error) {
      console.error(`[composite-${this.compositeId}] Restart failed:`, error.message)
      await this.destroy()
    }
  }

  addClient(clientId) {
    this.clients.add(clientId)
    this.lastActivity = Date.now()
    console.log(`[composite-${this.compositeId}] Client added: ${clientId} (total: ${this.clients.size})`)
  }

  trackViewer(clientId) {
    const now = Date.now()
    const wasEmpty = this.hlsViewers.size === 0
    this.hlsViewers.set(clientId, now)
    this.lastActivity = now

    // Start cleanup timer if not running
    if (!this._hlsViewerCleanup) {
      this._hlsViewerCleanup = setInterval(() => {
        if (this.dead) {
          clearInterval(this._hlsViewerCleanup)
          this._hlsViewerCleanup = null
          return
        }
        const cutoff = Date.now() - 15000 // 15s TTL
        for (const [id, ts] of this.hlsViewers) {
          if (ts < cutoff) this.hlsViewers.delete(id)
        }
      }, 5000)
    }
  }

  removeClient(clientId) {
    this.clients.delete(clientId)
    this.lastActivity = Date.now()
    console.log(`[composite-${this.compositeId}] Client removed: ${clientId} (remaining: ${this.clients.size})`)

    // Auto-cleanup if no clients
    if (this.clients.size === 0) {
      const inactivityTimeout = this.getSettings().inactivity_timeout * 1000
      setTimeout(() => {
        if (this.clients.size === 0 && this.hlsViewers.size === 0 && !this.dead) {
          console.log(`[composite-${this.compositeId}] No clients or HLS viewers, cleaning up`)
          this.destroy()
        }
      }, inactivityTimeout)
    }
  }

  getSettings() {
    const defaults = {
      encoding_preset: 'veryfast',
      video_bitrate: '4000k',
      audio_bitrate: '128k',
      hwaccel: 'none',
      inactivity_timeout: 300
    }

    try {
      const settings = this.db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('composite_%')
      for (const { key, value } of settings) {
        const settingKey = key.replace('composite_', '')
        defaults[settingKey] = value
      }
    } catch (error) {
      console.warn(`[composite-${this.compositeId}] Failed to load settings:`, error.message)
    }

    return defaults
  }

  async destroy() {
    if (this.dead) return
    this.dead = true

    console.log(`[composite-${this.compositeId}] Destroying session`)

    // Kill FFmpeg
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGKILL')
      this.ffmpegProcess = null
    }

    // Close all source sessions
    // Note: streamer.js sessions will auto-cleanup when clients disconnect
    this.sourceSessions.clear()

    // Clean up HLS segments
    try {
      if (existsSync(this.outputPath)) {
        rmSync(this.outputPath, { recursive: true, force: true })
      }
    } catch (error) {
      console.error(`[composite-${this.compositeId}] Failed to clean up output:`, error.message)
    }

    // Remove from sessions map
    compositeSessions.delete(this.compositeId)

    if (this._hlsViewerCleanup) {
      clearInterval(this._hlsViewerCleanup)
      this._hlsViewerCleanup = null
    }

    this.emit('destroyed')
    this.removeAllListeners()
  }

  getStatus() {
    // Prune stale HLS viewers before reporting
    const cutoff = Date.now() - 15000
    for (const [id, ts] of this.hlsViewers) {
      if (ts < cutoff) this.hlsViewers.delete(id)
    }

    return {
      compositeId: this.compositeId,
      active: !this.dead && this.ffmpegProcess !== null,
      clients: this.clients.size,
      hlsViewers: this.hlsViewers.size,
      sources: this.sourceSessions.size,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      lastActivity: this.lastActivity
    }
  }
}

// Get or create composite session
export async function getCompositeSession(compositeId, db, username = null) {
  let session = compositeSessions.get(compositeId)

  if (!session || session.dead) {
    // Load composite config from database
    const composite = db.prepare('SELECT * FROM composite_streams WHERE id = ? AND active = 1').get(compositeId)
    if (!composite) {
      throw new Error('Composite stream not found or inactive')
    }

    session = new CompositeSession(compositeId, composite, db, username)
    compositeSessions.set(compositeId, session)

    await session.start()
  }

  return session
}

// Get all active sessions
export function getActiveSessions() {
  return Array.from(compositeSessions.values()).map(s => s.getStatus())
}

// Stop a specific session
export async function stopCompositeSession(compositeId) {
  const session = compositeSessions.get(compositeId)
  if (session) {
    await session.destroy()
  }
}

// Stop all sessions
export async function stopAllCompositeSessions() {
  const sessions = Array.from(compositeSessions.values())
  await Promise.all(sessions.map(s => s.destroy()))
}
