/**
 * FFmpeg Remuxer
 *
 * Wraps the existing streamer buffer/variant logic and pipes through FFmpeg
 * for format conversion to browser-compatible formats.
 */

import { spawn } from 'node:child_process'
import db from './db.js'

/**
 * Get FFmpeg settings from database
 */
function getFFmpegSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('ffmpeg_%')
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]))
    return {
      enabled: settings.ffmpeg_enabled === 'true',
      webPlayer: settings.ffmpeg_web_player === 'true',
      // IPTV streaming settings
      outputFormat: settings.ffmpeg_output_format || 'mpegts',
      videoCodec: settings.ffmpeg_video_codec || 'libx264',
      audioCodec: settings.ffmpeg_audio_codec || 'aac',
      preset: settings.ffmpeg_preset || 'veryfast',
      tune: settings.ffmpeg_tune || 'zerolatency',
      gopSize: settings.ffmpeg_gop_size || '60',
      videoBitrate: settings.ffmpeg_video_bitrate || '4000k',
      pixelFormat: settings.ffmpeg_pixel_format || 'yuv420p',
      customParams: settings.ffmpeg_custom_params || '',
      // Web player settings (fMP4)
      webFormat: settings.ffmpeg_web_format || 'mp4',
      webVideoCodec: settings.ffmpeg_web_video_codec || 'copy',
      webAudioCodec: settings.ffmpeg_web_audio_codec || 'copy',
      webParams: settings.ffmpeg_web_params || '-movflags frag_keyframe+empty_moov+default_base_moof'
    }
  } catch (e) {
    console.error('[ffmpeg] Error loading settings:', e.message)
    return { enabled: false }
  }
}

/**
 * Create FFmpeg remux process
 * Takes input stream, outputs remuxed stream
 * @param {Stream} inputStream - The buffered input stream
 * @param {Object} options - { forWebPlayer: boolean }
 */
export function createRemuxProcess(inputStream, options = {}) {
  const settings = getFFmpegSettings()
  const isWebPlayer = options.forWebPlayer || false

  const args = [
    '-fflags', '+genpts',           // Generate presentation timestamps
    '-analyzeduration', '1000000',  // Analyze 1 second of input
    '-probesize', '1000000',        // Probe 1MB of data
    '-i', 'pipe:0',                 // Input from stdin
  ]

  if (isWebPlayer) {
    // Web player mode: fMP4 with copy codecs (fast, browser-compatible)
    args.push(
      '-c:v', settings.webVideoCodec,
      '-c:a', settings.webAudioCodec,
      '-f', settings.webFormat
    )
    // Add web-specific params (movflags for fMP4)
    if (settings.webParams) {
      args.push(...settings.webParams.split(' ').filter(p => p.trim()))
    }
  } else {
    // IPTV mode: H.264/AAC with low latency tuning
    args.push(
      '-c:v', settings.videoCodec,
      '-c:a', settings.audioCodec
    )

    // Only add encoding params if not using copy codec
    if (settings.videoCodec !== 'copy') {
      args.push(
        '-preset', settings.preset,
        '-tune', settings.tune,
        '-g', settings.gopSize,
        '-b:v', settings.videoBitrate,
        '-pix_fmt', settings.pixelFormat
      )
    }

    args.push('-f', settings.outputFormat)

    // Add custom params if any
    if (settings.customParams) {
      args.push(...settings.customParams.split(' ').filter(p => p.trim()))
    }
  }

  // Output to stdout
  args.push('pipe:1')

  console.log('[ffmpeg] Starting remux:', args.join(' '))

  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  // If inputStream is provided, pipe it to FFmpeg stdin
  if (inputStream) {
    inputStream.pipe(ffmpeg.stdin)
  }

  // Log FFmpeg errors
  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString()
    // Only log actual errors, not progress info
    if (msg.includes('error') || msg.includes('Error') || msg.includes('Invalid')) {
      console.error('[ffmpeg]', msg.trim())
    }
  })

  ffmpeg.on('error', (err) => {
    console.error('[ffmpeg] Process error:', err.message)
  })

  ffmpeg.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[ffmpeg] Exited with code ${code}, signal ${signal}`)
    }
  })

  return {
    process: ffmpeg,
    outputStream: ffmpeg.stdout,
    stdin: ffmpeg.stdin,
    kill: () => {
      try {
        ffmpeg.kill('SIGKILL')
      } catch (e) {
        // Already dead
      }
    }
  }
}

/**
 * Get appropriate Content-Type for FFmpeg output format
 */
export function getContentType(format) {
  switch (format) {
    case 'mp4':
      return 'video/mp4'
    case 'mpegts':
      return 'video/mp2t'
    case 'matroska':
      return 'video/x-matroska'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Check if FFmpeg is enabled and should be used
 */
export function shouldUseFFmpeg(forWebPlayer = false) {
  const settings = getFFmpegSettings()
  if (!settings.enabled) return false
  if (forWebPlayer && !settings.webPlayer) return false
  return true
}

export { getFFmpegSettings }
