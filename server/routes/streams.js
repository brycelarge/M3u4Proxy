import express from 'express'
import { join } from 'node:path'
import db from '../db.js'
import { connectClient, getActiveSessions, killSession } from '../streamer.js'
import { connectFfmpegClient, getActiveFfmpegSessions, isFfmpegRemuxEnabled, killFfmpegSession } from '../ffmpeg-streamer.js'
import { getActiveVodSessions, killVodSession } from '../vod-streamer.js'
import { getCompositeSession } from '../composite-streamer.js'

const router = express.Router()

// ── Stream proxy ──────────────────────────────────────────────────────────────
// Log /stream requests only when explicitly enabled
router.use('/stream/:channelId', (req, res, next) => {
  if (process.env.DEBUG_STREAMS === '1') {
    console.log(`[DEBUG] ${req.method} /stream/${req.params.channelId} from ${req.ip}`)
    console.log('[DEBUG] Headers:', JSON.stringify(req.headers, null, 2))
  }
  next()
})

// OPTIONS /stream/:channelId — CORS preflight for Jellyfin
router.options('/stream/:channelId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
  res.status(204).end()
})

// GET /stream/:channelId  — proxy upstream IPTV stream, reuse for multiple clients (direct stream)
router.get('/stream/:channelId', async (req, res) => {
  const { channelId } = req.params
  const row = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
  if (!row) return res.status(404).send('Channel not found')

  const username = req.username || req.query.username || 'anonymous'
  console.log(`[stream] Client "${username}" requested channel ${channelId} (${row.tvg_name})`)

  try {
    // If it's a VOD channel, use direct stream proxying (no buffering/hls conversion)
    if (row.content_type === 'movie' || row.content_type === 'series') {
      const source = row.source_id ? db.prepare('SELECT force_ts_extension FROM sources WHERE id = ?').get(row.source_id) : null
      const { connectVodClient } = await import('../vod-streamer.js')
      await connectVodClient(channelId, row.url, row.tvg_name, req, res, username, source)
      return
    }

    // Live TV — use shared buffer
    if (isFfmpegRemuxEnabled()) {
      await connectFfmpegClient(channelId, row.url, row.tvg_name, res, row.source_id || null, username)
      return
    }

    await connectClient(channelId, row.url, row.tvg_name, res, row.source_id || null, username)
  } catch (err) {
    console.error(`[stream] Error proxying channel ${channelId}:`, err)
    if (!res.headersSent) res.status(502).send(err.message)
  }
})

// ── Player page ───────────────────────────────────────────────────────────────
// GET /web-player/:channelId  — simple HTML5 video player with FFmpeg remuxing
router.get('/web-player/:channelId', (req, res) => {
  const { channelId } = req.params
  const channelName = req.query.name || 'Live Stream'
  const protocol = req.protocol
  const host = req.get('host')
  const streamUrl = `${protocol}://${host}/stream-web/${channelId}`

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channelName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
    .header { background: #1a1d27; border-bottom: 1px solid #2e3250; padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
    .back-btn { background: none; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; padding: 4px 8px; }
    .back-btn:hover { color: #e2e8f0; }
    .title { color: #f1f5f9; font-size: 14px; font-weight: 600; }
    .player-container { width: 100vw; height: calc(100vh - 49px); display: flex; align-items: center; justify-content: center; background: #000; }
    video { width: 100%; height: 100%; max-height: 100%; object-fit: contain; }
    .error { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ef4444; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px; text-align: center; max-width: 400px; }
  </style>
</head>
<body>
  <div class="header">
    <button class="back-btn" onclick="window.close()">←</button>
    <div class="title">${channelName}</div>
  </div>
  <div class="player-container">
    <video id="video" controls></video>
    <div id="error" class="error" style="display:none;"></div>
  </div>
  <script>
    const streamUrl = '${streamUrl}'
    const errorDiv = document.getElementById('error')
    const video = document.getElementById('video')
    video.src = streamUrl
    video.addEventListener('error', () => {
      const error = video.error
      let errorMsg = 'Stream error'
      if (error) {
        switch(error.code) {
          case error.MEDIA_ERR_ABORTED: errorMsg = 'Playback aborted'; break
          case error.MEDIA_ERR_NETWORK: errorMsg = 'Network error'; break
          case error.MEDIA_ERR_DECODE: errorMsg = 'Decode error'; break
          case error.MEDIA_ERR_SRC_NOT_SUPPORTED: errorMsg = 'Stream format not supported'; break
        }
      }
      errorDiv.textContent = errorMsg
      errorDiv.style.display = 'block'
    })
    video.addEventListener('loadedmetadata', () => {
      video.play().catch(() => {})
    })
  </script>
</body>
</html>
  `)
})

// ── Stream proxy for web browsers ─────────────────────────────────────────────
// GET /stream-web/:channelId  — proxy upstream IPTV stream with FFmpeg remuxing for browser compatibility
router.get('/stream-web/:channelId', async (req, res) => {
  const { channelId } = req.params
  const row = db.prepare('SELECT * FROM playlist_channels WHERE id = ?').get(channelId)
  if (!row) return res.status(404).send('Channel not found')

  const username = req.username || req.query.username || 'web-user'
  console.log(`[stream-web] Client "${username}" requested channel ${channelId} (${row.tvg_name})`)

  try {
    // Import spawn for FFmpeg
    const { spawn } = await import('node:child_process')

    console.log(`[stream-web] ⚡ FFMPEG REMUX ENABLED - Converting stream to MP4 container for browser`)

    // Set headers for MP4 streaming
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Access-Control-Allow-Origin', '*')

    // Create FFmpeg process to remux stream to MP4 container
    // Video: copy (no re-encoding)
    // Audio: re-encode to AAC for browser compatibility
    const ffmpegArgs = [
      '-i', 'pipe:0',           // Input from stdin
      '-c:v', 'copy',           // Copy video codec (no re-encoding)
      '-c:a', 'aac',            // Re-encode audio to AAC (browser-compatible)
      '-b:a', '128k',           // Audio bitrate
      '-f', 'mp4',              // Output format: MP4
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Enable streaming MP4
      'pipe:1'                  // Output to stdout
    ]
    console.log(`[ffmpeg] Starting FFmpeg with args: ${ffmpegArgs.join(' ')}`)

    const ffmpeg = spawn('ffmpeg', ffmpegArgs)
    let ffmpegStarted = false
    let ffmpegKilled = false

    // Pipe FFmpeg output to client
    ffmpeg.stdout.pipe(res)

    // Handle FFmpeg stdin errors (e.g., EPIPE when writing to closed pipe)
    ffmpeg.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') {
        console.error(`[ffmpeg] stdin error:`, err)
      }
    })

    // Handle FFmpeg errors and info
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim()
      if (!ffmpegStarted && msg.includes('Stream mapping:')) {
        console.log(`[ffmpeg] ✓ Stream processing started`)
        ffmpegStarted = true
      }
      // Only log important FFmpeg messages (errors, warnings, stream info)
      if (msg.includes('error') || msg.includes('Error') || msg.includes('Stream #') || msg.includes('Duration:')) {
        console.log(`[ffmpeg] ${msg}`)
      }
    })

    ffmpeg.on('error', (err) => {
      console.error(`[ffmpeg] ✗ Process error:`, err)
      if (!res.headersSent) {
        res.status(500).send('Transcoding error')
      }
    })

    ffmpeg.on('exit', (code) => {
      ffmpegKilled = true
      console.log(`[ffmpeg] Process exited with code ${code}`)
    })

    // Clean up on client disconnect
    res.on('close', () => {
      if (!ffmpegKilled) {
        console.log(`[ffmpeg] Client disconnected, killing FFmpeg process`)
        ffmpegKilled = true
        ffmpeg.kill('SIGKILL')
      }
    })

    // Create a wrapper that mimics HTTP response interface but pipes to FFmpeg stdin
    const ffmpegWrapper = {
      write: (chunk) => {
        if (!ffmpegKilled && !ffmpeg.stdin.destroyed) {
          return ffmpeg.stdin.write(chunk)
        }
        return false
      },
      end: () => {
        if (!ffmpegKilled && !ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end()
        }
      },
      setHeader: () => {}, // No-op for FFmpeg stdin
      flushHeaders: () => {}, // No-op for FFmpeg stdin
      writableEnded: false,
      on: (event, handler) => {
        if (event === 'close') {
          res.on('close', handler)
        }
      }
    }

    // Connect to upstream stream and pipe to FFmpeg stdin via wrapper
    console.log(`[stream-web] Connecting upstream stream to FFmpeg stdin...`)

    if (row.content_type === 'movie' || row.content_type === 'series') {
      const source = row.source_id ? db.prepare('SELECT force_ts_extension FROM sources WHERE id = ?').get(row.source_id) : null
      const { connectVodClient } = await import('../vod-streamer.js')
      await connectVodClient(channelId, row.url, row.tvg_name, req, ffmpegWrapper, username, source)
    } else {
      await connectClient(channelId, row.url, row.tvg_name, ffmpegWrapper, row.source_id || null, username)
    }

    console.log(`[stream-web] Successfully connected to upstream`)

  } catch (err) {
    console.error(`[stream-web] Error proxying channel ${channelId}:`, err)
    if (!res.headersSent) res.status(502).send(err.message)
  }
})

// ── Composite Stream ──────────────────────────────────────────────────────────
// Get composite stream HLS playlist
router.get('/stream/composite/:id', async (req, res) => {
  try {
    const compositeId = parseInt(req.params.id)
    const session = await getCompositeSession(compositeId, db, req.username)

    if (!session) {
      return res.status(404).send('Composite stream session failed to start')
    }

    // Redirect to the HLS playlist
    // The session creates files in a temp dir served by express.static
    // URL format: /hls/composite-{id}/master.m3u8
    const playlistUrl = `/hls/composite-${compositeId}/master.m3u8`

    // Redirect and let client retry if playlist isn't ready yet
    res.redirect(playlistUrl)

  } catch (error) {
    console.error('[composite] Stream error:', error)
    res.status(500).send(error.message)
  }
})

// Serve HLS playlist
router.get('/composite-stream/:id/playlist.m3u8', async (req, res) => {
  try {
    const compositeId = parseInt(req.params.id)
    const session = await getCompositeSession(compositeId, db, req.username)

    const playlistPath = join(session.outputPath, 'playlist.m3u8')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.sendFile(playlistPath)
  } catch (error) {
    console.error('[composite] Playlist serve failed:', error)
    res.status(404).json({ error: error.message })
  }
})

// Serve HLS segments
router.get('/composite-stream/:id/:segment', async (req, res) => {
  try {
    const compositeId = parseInt(req.params.id)
    const session = await getCompositeSession(compositeId, db, req.username)

    const segmentPath = join(session.outputPath, req.params.segment)
    res.setHeader('Content-Type', 'video/mp2t')
    res.sendFile(segmentPath)
  } catch (error) {
    console.error('[composite] Segment serve failed:', error)
    res.status(404).json({ error: error.message })
  }
})

// Internal stream endpoint for FFmpeg to read from
router.get('/internal-stream/composite-:compositeId-:role', async (req, res) => {
  const { compositeId, role } = req.params

  console.log(`[internal-stream] Request for composite-${compositeId}-${role}`)

  try {
    const source = db.prepare(`
      SELECT css.*, pc.url, pc.tvg_name, pc.source_id, pc.id as channel_id
      FROM composite_stream_sources css
      JOIN playlist_channels pc ON css.source_channel_id = pc.id
      WHERE css.composite_stream_id = ? AND css.role = ?
    `).get(compositeId, role)

    if (!source) {
      console.error(`[internal-stream] Source not found for composite-${compositeId}-${role}`)
      return res.status(404).end('Source not found')
    }

    console.log(`[internal-stream] Connecting to channel ${source.channel_id} (${source.tvg_name})`)
    console.log(`[internal-stream] URL: ${source.url}`)

    await connectClient(source.channel_id, source.url, source.tvg_name, res, source.source_id, req.username)
  } catch (error) {
    console.error(`[internal-stream] Failed for composite-${compositeId}-${role}:`, error.message)
    console.error(`[internal-stream] Stack:`, error.stack)
    res.status(500).end('Internal stream error')
  }
})

// ── API Endpoints ─────────────────────────────────────────────────────────────
// These will be mounted under /api/streams/

// GET /api/streams  — list active stream sessions (both Live TV and VOD)
router.get('/', (req, res) => {
  const liveSessions = getActiveSessions()
  const ffmpegSessions = getActiveFfmpegSessions()
  const vodSessions = getActiveVodSessions()
  const allSessions = [...liveSessions, ...ffmpegSessions, ...vodSessions]

  // Enrich with channel details from database
  const enriched = allSessions.map(session => {
    const channel = db.prepare('SELECT tvg_name, group_title, tvg_logo FROM playlist_channels WHERE id = ?').get(session.channelId)
    return {
      ...session,
      tvg_name: channel?.tvg_name || session.channelName,
      group_title: channel?.group_title || null,
      tvg_logo: channel?.tvg_logo || null,
      isVod: channel?.group_title?.startsWith('Series:') || channel?.group_title?.startsWith('Movie:') || false
    }
  })

  res.json(enriched)
})

// DELETE /api/streams/:channelId  — kill a stream session (Live TV or VOD)
router.delete('/:channelId', (req, res) => {
  killSession(req.params.channelId)
  killFfmpegSession(req.params.channelId)
  killVodSession(req.params.channelId)
  res.json({ ok: true })
})

// GET /api/stream-history
router.get('/history', (req, res) => {
  const username = req.query.username || null
  const limit    = Math.min(parseInt(req.query.limit || '200'), 1000)
  const rows = username
    ? db.prepare('SELECT * FROM stream_history WHERE username = ? ORDER BY started_at DESC LIMIT ?').all(username, limit)
    : db.prepare('SELECT * FROM stream_history ORDER BY started_at DESC LIMIT ?').all(limit)
  res.json(rows)
})

// Legacy compatibility endpoint
router.get('/api/stream-history', (req, res) => {
  const username = req.query.username || null
  const limit    = Math.min(parseInt(req.query.limit || '200'), 1000)
  const rows = username
    ? db.prepare('SELECT * FROM stream_history WHERE username = ? ORDER BY started_at DESC LIMIT ?').all(username, limit)
    : db.prepare('SELECT * FROM stream_history ORDER BY started_at DESC LIMIT ?').all(limit)
  res.json(rows)
})

export default router
