import db from './db.js'
import { getActiveSessions } from './streamer.js'
import { getActiveFfmpegSessions } from './ffmpeg-streamer.js'
import { getActiveVodSessions } from './vod-streamer.js'

const lastFlushedByChannel = new Map()

export function flushSession(session) {
  const channelId = session.channelId
  const lastFlushed = lastFlushedByChannel.get(channelId) || {
    bytesIn: session._lastFlushedBytesIn || 0,
    bytesOut: session._lastFlushedBytesOut || 0,
  }

  const currentBytesIn = session.bytesIn || 0
  const currentBytesOut = session.bytesOut || 0
  const deltaIn = currentBytesIn - lastFlushed.bytesIn
  const deltaOut = currentBytesOut - lastFlushed.bytesOut

  if (deltaIn <= 0 && deltaOut <= 0) return

  const today = new Date().toISOString().split('T')[0]

  try {
    db.prepare(`
      INSERT INTO stream_stats_daily (date, channel_id, bytes_in, bytes_out)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date, channel_id) DO UPDATE SET
        bytes_in  = bytes_in  + excluded.bytes_in,
        bytes_out = bytes_out + excluded.bytes_out
    `).run(today, channelId, deltaIn, deltaOut)

    session._lastFlushedBytesIn = currentBytesIn
    session._lastFlushedBytesOut = currentBytesOut
    lastFlushedByChannel.set(channelId, {
      bytesIn: currentBytesIn,
      bytesOut: currentBytesOut,
    })
  } catch (err) {
    console.error('[stats-flusher] Failed to flush session:', err.message)
  }
}

function flushAll() {
  const allSessions = [
    ...getActiveSessions(),
    ...getActiveFfmpegSessions(),
    ...getActiveVodSessions(),
  ]

  for (const session of allSessions) {
    flushSession(session)
  }
}

export function startStatsFlusher() {
  console.log('[stats-flusher] Starting periodic bandwidth flush (60s interval)')
  setInterval(flushAll, 60_000)
}
