/**
 * EPG Site Sync
 *
 * Downloads the iptv-org/epg repo as a zip, extracts only
 * sites/**\/*.channels.xml files, parses them, and bulk-inserts
 * into the epg_site_channels SQLite table.
 *
 * No git required. No GitHub API rate limits (zip is a single request).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const ZIP_URL = 'https://codeload.github.com/iptv-org/epg/zip/refs/heads/master'

export const SITES_DIR = path.join(process.cwd(), 'data', 'epg-sites')

// ── Minimal ZIP parser ────────────────────────────────────────────────────────
// We implement a streaming ZIP parser to avoid loading the whole file in memory.
// ZIP local file header format:
//   signature  4 bytes  0x04034b50
//   version    2 bytes
//   flags      2 bytes
//   compress   2 bytes  (0=store, 8=deflate)
//   mod time   2 bytes
//   mod date   2 bytes
//   crc32      4 bytes
//   comp size  4 bytes
//   uncomp size 4 bytes
//   fname len  2 bytes
//   extra len  2 bytes
//   fname      fname len bytes
//   extra      extra len bytes
//   data       comp size bytes

const LOCAL_SIG  = 0x04034b50
const DD_SIG     = 0x08074b50  // data descriptor
const CD_SIG     = 0x02014b50  // central directory
const EOCD_SIG   = 0x06054b50  // end of central directory

function parseChannelsXml(xml, site, filename) {
  const channels = []
  const re = /<channel\s([^>]*)>([^<]*)<\/channel>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]
    const name  = m[2].trim()
    const get   = (a) => { const r = new RegExp(`${a}="([^"]*)"`) ; return (attrs.match(r) || [])[1] || '' }
    channels.push({
      site,
      name,
      site_id:  get('site_id'),
      xmltv_id: get('xmltv_id'),
      lang:     get('lang') || 'en',
      file:     filename,
    })
  }
  return channels
}

// ── Streaming ZIP extractor ───────────────────────────────────────────────────
// Returns an async generator yielding { path, data: Buffer } for matching files
async function* streamZipEntries(readable, filterFn) {
  // We need random-ish access to the stream — buffer chunks and parse
  // This is a simplified parser that handles STORE and DEFLATE entries
  const chunks = []
  for await (const chunk of readable) chunks.push(chunk)
  const buf = Buffer.concat(chunks)

  let pos = 0
  while (pos < buf.length - 4) {
    const sig = buf.readUInt32LE(pos)

    if (sig === LOCAL_SIG) {
      const flags      = buf.readUInt16LE(pos + 6)
      const compress   = buf.readUInt16LE(pos + 8)
      const compSize   = buf.readUInt32LE(pos + 18)
      const fnameLen   = buf.readUInt16LE(pos + 26)
      const extraLen   = buf.readUInt16LE(pos + 28)
      const fname      = buf.toString('utf8', pos + 30, pos + 30 + fnameLen)
      const dataStart  = pos + 30 + fnameLen + extraLen

      // Skip directories
      if (fname.endsWith('/')) {
        pos = dataStart + compSize
        continue
      }

      // Data descriptor follows if bit 3 of flags is set and compSize is 0
      let actualCompSize = compSize
      if ((flags & 0x08) && compSize === 0) {
        // Need to scan for data descriptor signature after data
        // For simplicity, skip — most entries have sizes in header
        pos = dataStart
        continue
      }

      if (filterFn(fname)) {
        const compData = buf.slice(dataStart, dataStart + actualCompSize)
        let data
        if (compress === 0) {
          data = compData
        } else if (compress === 8) {
          // Deflate (raw, no zlib header)
          const { inflateRawSync } = await import('node:zlib')
          data = inflateRawSync(compData)
        } else {
          pos = dataStart + actualCompSize
          continue
        }
        yield { path: fname, data }
      }

      pos = dataStart + actualCompSize
    } else if (sig === CD_SIG || sig === EOCD_SIG) {
      break
    } else {
      pos++
    }
  }
}

// ── Main sync function ────────────────────────────────────────────────────────
export async function syncEpgSites(db, { onProgress } = {}) {
  const log = (msg) => { console.log(`[epg-sync] ${msg}`); onProgress?.(msg) }

  log('Downloading iptv-org/epg zip…')
  const res = await fetch(ZIP_URL, {
    headers: { 'User-Agent': 'm3u-manager' },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Failed to download zip: ${res.status}`)

  log('Parsing ZIP entries…')
  const arrayBuffer = await res.arrayBuffer()
  const buf = Buffer.from(arrayBuffer)

  // Parse ZIP entries — extract *.channels.xml (parse into DB) and *.config.js (write to disk)
  const wantFile = (fname) =>
    fname.includes('/sites/') &&
    (fname.endsWith('.channels.xml') || fname.endsWith('.config.js'))

  const { inflateRawSync } = await import('node:zlib')

  const allChannels = []
  let fileCount = 0
  let configCount = 0
  let pos = 0

  mkdirSync(SITES_DIR, { recursive: true })

  while (pos < buf.length - 4) {
    const sig = buf.readUInt32LE(pos)

    if (sig !== LOCAL_SIG) { pos++; continue }

    const flags     = buf.readUInt16LE(pos + 6)
    const compress  = buf.readUInt16LE(pos + 8)
    const compSize  = buf.readUInt32LE(pos + 18)
    const fnameLen  = buf.readUInt16LE(pos + 26)
    const extraLen  = buf.readUInt16LE(pos + 28)
    const fname     = buf.toString('utf8', pos + 30, pos + 30 + fnameLen)
    const dataStart = pos + 30 + fnameLen + extraLen

    if (fname.endsWith('/') || compSize === 0) {
      pos = dataStart + compSize
      continue
    }

    if (wantFile(fname)) {
      try {
        const compData = buf.slice(dataStart, dataStart + compSize)
        let fileBuf
        if (compress === 0) {
          fileBuf = compData
        } else if (compress === 8) {
          fileBuf = inflateRawSync(compData)
        } else {
          pos = dataStart + compSize
          continue
        }

        // Path: epg-master/sites/dstv.com/dstv.com_za.channels.xml
        const parts    = fname.split('/')
        const siteName = parts[parts.length - 2]
        const filename = parts[parts.length - 1]

        if (filename.endsWith('.channels.xml')) {
          const channels = parseChannelsXml(fileBuf.toString('utf8'), siteName, filename)
          allChannels.push(...channels)
          fileCount++
          if (fileCount % 50 === 0) log(`Parsed ${fileCount} channel files, ${allChannels.length} channels so far…`)
        } else if (filename.endsWith('.config.js')) {
          // Write config.js to disk so epg-grabber can import it
          const siteDir = path.join(SITES_DIR, siteName)
          mkdirSync(siteDir, { recursive: true })
          writeFileSync(path.join(siteDir, filename), fileBuf)
          configCount++
        }
      } catch (e) {
        console.warn(`[epg-sync] Failed to process ${fname}: ${e.message}`)
      }
    }

    pos = dataStart + compSize
  }

  log(`Parsed ${fileCount} channel files, ${allChannels.length} channels. Wrote ${configCount} config files. Writing to DB…`)

  // Bulk insert into DB in a transaction
  const deleteAll = db.prepare('DELETE FROM epg_site_channels')
  const insert    = db.prepare(
    'INSERT INTO epg_site_channels (site, name, site_id, xmltv_id, lang, file) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const upsertMeta = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('epg_sites_last_synced', ?)")

  const bulkInsert = db.transaction((rows) => {
    deleteAll.run()
    for (const ch of rows) {
      insert.run(ch.site, ch.name, ch.site_id, ch.xmltv_id, ch.lang, ch.file)
    }
    upsertMeta.run(new Date().toISOString())
  })

  bulkInsert(allChannels)
  log(`Sync complete. ${allChannels.length} channels from ${fileCount} files stored in DB.`)

  return { channels: allChannels.length, files: fileCount }
}

export function getLastSynced(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'epg_sites_last_synced'").get()
  return row?.value || null
}

export function getSiteList(db) {
  return db.prepare('SELECT DISTINCT site FROM epg_site_channels ORDER BY site').all().map(r => r.site)
}
