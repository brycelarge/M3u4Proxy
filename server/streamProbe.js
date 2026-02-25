/**
 * Stream probing utility using ffprobe to detect codecs
 */

import { spawn } from 'node:child_process'

/**
 * Probe stream to detect video/audio codecs
 * Returns codec information or null if probe fails
 */
export async function probeStream(streamUrl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      '-analyzeduration', '5000000',
      '-probesize', '10000000',
      streamUrl
    ]

    const ffprobe = spawn('ffprobe', args, {
      timeout: timeoutMs
    })

    let stdout = ''
    let stderr = ''

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        console.error(`[probe] ffprobe failed with code ${code}:`, stderr)
        resolve(null)
        return
      }

      try {
        const data = JSON.parse(stdout)
        const videoStream = data.streams?.find(s => s.codec_type === 'video')
        const audioStream = data.streams?.find(s => s.codec_type === 'audio')

        const info = {
          videoCodec: videoStream?.codec_name || 'unknown',
          audioCodec: audioStream?.codec_name || 'unknown',
          width: videoStream?.width,
          height: videoStream?.height,
          fps: videoStream?.r_frame_rate,
          bitrate: data.format?.bit_rate,
          duration: data.format?.duration,
          raw: data
        }

        console.log(`[probe] Stream info: ${info.videoCodec}/${info.audioCodec} ${info.width}x${info.height}`)
        resolve(info)
      } catch (err) {
        console.error(`[probe] Failed to parse ffprobe output:`, err.message)
        resolve(null)
      }
    })

    ffprobe.on('error', (err) => {
      console.error(`[probe] ffprobe error:`, err.message)
      resolve(null)
    })

    // Timeout fallback
    setTimeout(() => {
      ffprobe.kill('SIGTERM')
      console.log(`[probe] Probe timeout after ${timeoutMs}ms`)
      resolve(null)
    }, timeoutMs)
  })
}

/**
 * Check if ffprobe is available
 */
export async function checkFfprobeAvailable() {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', ['-version'])
    ffprobe.on('close', (code) => resolve(code === 0))
    ffprobe.on('error', () => resolve(false))
  })
}
