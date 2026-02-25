/**
 * Client capability detection for adaptive streaming
 * Determines if FFmpeg transcoding is needed based on client headers
 */

// Known player capabilities
const PLAYER_PROFILES = {
  // Web browsers - support most modern codecs
  chrome: { supportsHEVC: false, supportsAAC: true, supportsMP3: true, preferredFormat: 'mpegts' },
  firefox: { supportsHEVC: false, supportsAAC: true, supportsMP3: true, preferredFormat: 'mpegts' },
  safari: { supportsHEVC: true, supportsAAC: true, supportsMP3: true, preferredFormat: 'mpegts' },
  edge: { supportsHEVC: false, supportsAAC: true, supportsMP3: true, preferredFormat: 'mpegts' },

  // IPTV players
  vlc: { supportsHEVC: true, supportsAAC: true, supportsMP3: true, supportsAC3: true, preferredFormat: 'mpegts' },
  kodi: { supportsHEVC: true, supportsAAC: true, supportsMP3: true, supportsAC3: true, preferredFormat: 'mpegts' },
  plex: { supportsHEVC: true, supportsAAC: true, supportsMP3: true, supportsAC3: true, preferredFormat: 'mpegts' },

  // Mobile
  ios: { supportsHEVC: true, supportsAAC: true, supportsMP3: true, preferredFormat: 'hls' },
  android: { supportsHEVC: false, supportsAAC: true, supportsMP3: true, preferredFormat: 'mpegts' },
}

/**
 * Detect client type from User-Agent
 */
export function detectClient(userAgent) {
  if (!userAgent) return 'unknown'

  const ua = userAgent.toLowerCase()

  // Browsers
  if (ua.includes('chrome') && !ua.includes('edg')) return 'chrome'
  if (ua.includes('firefox')) return 'firefox'
  if (ua.includes('safari') && !ua.includes('chrome')) return 'safari'
  if (ua.includes('edg')) return 'edge'

  // IPTV Players
  if (ua.includes('vlc')) return 'vlc'
  if (ua.includes('kodi')) return 'kodi'
  if (ua.includes('plex')) return 'plex'

  // Mobile
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios'
  if (ua.includes('android')) return 'android'

  return 'unknown'
}

/**
 * Get client capabilities
 */
export function getClientCapabilities(req) {
  const userAgent = req.headers['user-agent'] || ''
  const accept = req.headers['accept'] || ''
  const clientType = detectClient(userAgent)

  const capabilities = {
    clientType,
    userAgent,
    accept,
    profile: PLAYER_PROFILES[clientType] || {
      supportsHEVC: false,
      supportsAAC: true,
      supportsMP3: true,
      preferredFormat: 'mpegts'
    }
  }

  return capabilities
}

/**
 * Determine if transcoding is needed based on stream info and client capabilities
 * This would be called after probing the stream with ffprobe
 */
export function needsTranscoding(streamInfo, clientCapabilities) {
  const { videoCodec, audioCodec } = streamInfo
  const { profile, clientType } = clientCapabilities

  const reasons = []
  const transcode = {}

  // Check video codec compatibility
  if (videoCodec === 'hevc' && !profile.supportsHEVC) {
    reasons.push('HEVC → H.264')
    transcode.video = 'h264'
  }

  // Check audio codec compatibility
  if (audioCodec === 'ac3' && !profile.supportsAC3) {
    reasons.push('AC3 → AAC')
    transcode.audio = 'aac'
  }

  if (reasons.length > 0) {
    return {
      needed: true,
      reason: `${reasons.join(', ')} for ${clientType}`,
      transcode
    }
  }

  return { needed: false }
}

/**
 * Log client capabilities for debugging
 */
export function logClientInfo(req, channelName) {
  const caps = getClientCapabilities(req)
  console.log(`[client] "${channelName}" requested by ${caps.clientType}`)
  console.log(`[client] User-Agent: ${caps.userAgent}`)
  console.log(`[client] Supports HEVC: ${caps.profile.supportsHEVC}`)
  console.log(`[client] Preferred format: ${caps.profile.preferredFormat}`)
  return caps
}
