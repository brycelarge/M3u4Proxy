/**
 * EPG Grab Runner
 *
 * Reads the saved channels.xml, groups channels by site, then spawns
 * the epg-grabber CLI for each site using the extracted config.js files
 * from the iptv-org/epg repo sync. Merges per-site XMLTV output into
 * a single guide.xml served at GET /guide.xml.
 *
 * Site configs are CommonJS and depend on axios/dayjs/etc — we run them
 * via the epg-grabber CLI in a child process rather than importing them.
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITES_DIR } from './epgSync.js'
import { enrichGuide } from './epgEnrich.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DATA_DIR = process.env.DATA_DIR || '/data'
export const EPG_DIR   = path.join(DATA_DIR, 'epg')
export const GUIDE_XML = path.join(EPG_DIR, 'guide.xml')
const CHANNELS_XML     = path.join(EPG_DIR, 'channels.xml')
const GRAB_DAYS        = parseInt(process.env.EPG_GRAB_DAYS        || '3')
const GRAB_DELAY       = parseInt(process.env.EPG_GRAB_DELAY       || '500')
const GRAB_TIMEOUT     = parseInt(process.env.EPG_GRAB_TIMEOUT     || '15000')
const GRAB_CONNECTIONS = parseInt(process.env.EPG_GRAB_CONNECTIONS || '4')

// Path to the epg-grabber CLI binary
const EPG_GRABBER_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'epg-grabber')

// ── State ─────────────────────────────────────────────────────────────────────
export const grabState = {
  inProgress:   false,
  lastStarted:  null,
  lastFinished: null,
  lastError:    null,
  guideExists:  false,
  guideUrl:     null,
  progress:     { done: 0, total: 0, site: '' },
  log:          [],
}

function addLog(msg) {
  console.log(`[epg-grab] ${msg}`)
  grabState.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  if (grabState.log.length > 500) grabState.log.shift()
}

// ── Parse channels.xml ────────────────────────────────────────────────────────
function parseChannelsXml(xml) {
  const channels = []

  // Parse epg-grabber format: <channels site="..."><channel site_id="..." xmltv_id="...">Name</channel></channels>
  const siteMatch = xml.match(/<channels\s+site="([^"]+)"/)
  const site = siteMatch ? siteMatch[1] : ''

  const channelRe = /<channel\s([^>]*)>([^<]*)<\/channel>/g
  let m
  while ((m = channelRe.exec(xml)) !== null) {
    const attrs = m[1]
    const name  = m[2].trim()
    const get   = (a) => { const r = new RegExp(`${a}="([^"]*)"`) ; return (attrs.match(r) || [])[1] || '' }

    const site_id = get('site_id')
    if (site_id && name) {
      channels.push({
        name,
        site: site || get('site'),
        site_id,
        xmltv_id: get('xmltv_id') || '',
        lang: get('lang') || 'en',
        logo: get('logo') || ''
      })
    }
  }

  return channels
}

// ── Build per-site channels.xml fragment ──────────────────────────────────────
function buildSiteChannelsXml(channels) {
  if (!channels.length) return '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n</channels>\n'

  const site = channels[0].site
  const lines = channels.map(ch => {
    const attrs = [`site_id="${ch.site_id}"`]
    if (ch.xmltv_id) attrs.push(`xmltv_id="${ch.xmltv_id}"`)
    if (ch.lang) attrs.push(`lang="${ch.lang}"`)
    return `  <channel ${attrs.join(' ')}>${ch.name}</channel>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<channels site="${site}">\n${lines.join('\n')}\n</channels>\n`
}

// ── Spawn epg-grabber CLI for one site ────────────────────────────────────────
function spawnGrabber(configPath, channelsFile, outputFile, onLine) {
  return new Promise((resolve) => {
    const args = [
      '--config',          configPath,
      '--channels',        channelsFile,
      '--output',          outputFile,
      '--days',            String(GRAB_DAYS),
      '--delay',           String(GRAB_DELAY),
      '--timeout',         String(GRAB_TIMEOUT),
      '--max-connections', String(GRAB_CONNECTIONS),
    ]

    // Set NODE_PATH so config files can require() dependencies from /app/node_modules
    const env = {
      ...process.env,
      NODE_PATH: path.join(process.cwd(), 'node_modules'),
      NODE_OPTIONS: undefined // Clear NODE_OPTIONS
    }

    const proc = spawn('node', [EPG_GRABBER_BIN, ...args], { env })

    let buf = ''
    const onData = (d) => {
      buf += d.toString()
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const line of parts) { if (line.trim()) onLine(line) }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('close', (code) => {
      if (buf.trim()) onLine(buf)
      resolve({ code })
    })
    proc.on('error', (err) => { onLine(err.message); resolve({ code: -1 }) })

    // Safety timeout — 30 min per site (large sites can have hundreds of channels × days)
    const killer = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, 30 * 60 * 1000)
    proc.on('close', () => clearTimeout(killer))
  })
}

// ── Merge XMLTV files ─────────────────────────────────────────────────────────
function mergeXmltvFiles(files, preserveExisting = false) {
  const seenChannels = new Set()
  const channelBlocks = []
  const programmeBlocks = []

  // If preserving existing data, load current guide.xml first
  if (preserveExisting && existsSync(GUIDE_XML)) {
    try {
      const existingContent = readFileSync(GUIDE_XML, 'utf8')
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)

      // Extract existing channels
      const chanRe = /<channel\b[^>]*>[\s\S]*?<\/channel>/g
      let m
      while ((m = chanRe.exec(existingContent)) !== null) {
        const idMatch = m[0].match(/\bid="([^"]*)"/)
        const id = idMatch?.[1]
        if (id && !seenChannels.has(id)) {
          seenChannels.add(id)
          channelBlocks.push(m[0])
        }
      }

      // Extract existing programmes that are not older than 2 days
      const progRe = /<programme\b[\s\S]*?<\/programme>/g
      while ((m = progRe.exec(existingContent)) !== null) {
        const stopMatch = m[0].match(/\bstop="([^"]*)"/)
        if (stopMatch) {
          const stopTime = stopMatch[1].replace(/\s.*/, '')
          const stopDate = new Date(
            `${stopTime.slice(0,4)}-${stopTime.slice(4,6)}-${stopTime.slice(6,8)}T${stopTime.slice(8,10)}:${stopTime.slice(10,12)}:${stopTime.slice(12,14)}Z`
          )
          // Keep programmes that ended less than 2 days ago
          if (stopDate >= twoDaysAgo) {
            programmeBlocks.push(m[0])
          }
        }
      }
    } catch (e) {
      console.error('[epg-grab] Error preserving existing guide.xml:', e.message)
    }
  }

  for (const f of files) {
    if (!existsSync(f)) continue
    const content = readFileSync(f, 'utf8')

    // Extract <channel> blocks
    const chanRe = /<channel\b[^>]*>[\s\S]*?<\/channel>/g
    let m
    while ((m = chanRe.exec(content)) !== null) {
      const idMatch = m[0].match(/\bid="([^"]*)"/)
      const id = idMatch?.[1]
      if (id && !seenChannels.has(id)) {
        seenChannels.add(id)
        channelBlocks.push(m[0])
      }
    }

    // Extract <programme> blocks
    const progRe = /<programme\b[\s\S]*?<\/programme>/g
    while ((m = progRe.exec(content)) !== null) {
      programmeBlocks.push(m[0])
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n` +
    `<tv generator-info-name="m3u-manager">\n` +
    channelBlocks.join('\n') + '\n' +
    programmeBlocks.join('\n') + '\n' +
    `</tv>\n`
  )
}

// ── Main grab function ────────────────────────────────────────────────────────
export async function runGrab({ onProgress } = {}) {
  if (grabState.inProgress) return { already: true }

  grabState.inProgress  = true
  grabState.lastStarted = new Date().toISOString()
  grabState.lastError   = null
  grabState.log         = []
  grabState.progress    = { done: 0, total: 0, site: '' }

  const log = (msg) => { addLog(msg); onProgress?.(msg) }

  try {
    if (!existsSync(CHANNELS_XML)) {
      throw new Error(`channels.xml not found at ${CHANNELS_XML}. Select channels in the EPG Scraper first.`)
    }

    const xml = readFileSync(CHANNELS_XML, 'utf8')
    const allChannels = parseChannelsXml(xml)

    if (!allChannels.length) {
      throw new Error('channels.xml is empty. Select channels in the EPG Scraper first.')
    }

    // Group channels by site
    const bySite = new Map()
    for (const ch of allChannels) {
      if (!ch.site) continue
      if (!bySite.has(ch.site)) bySite.set(ch.site, [])
      bySite.get(ch.site).push(ch)
    }

    const sites = [...bySite.keys()]
    grabState.progress.total = sites.length
    log(`Starting EPG grab for ${allChannels.length} channels across ${sites.length} sites, ${GRAB_DAYS} days…`)

    mkdirSync(EPG_DIR, { recursive: true })
    const tmpDir = path.join(EPG_DIR, 'tmp')
    mkdirSync(tmpDir, { recursive: true })

    const outputFiles = []

    // Write a partial guide.xml from whatever output files exist so far
    const flushGuide = () => {
      if (!outputFiles.length) return
      try {
        const merged = mergeXmltvFiles(outputFiles, true) // Preserve existing data
        writeFileSync(GUIDE_XML, merged, 'utf8')
        grabState.guideExists = true
        grabState.guideUrl    = '/guide.xml'
        const ch = (merged.match(/<channel\b/g) || []).length
        const pr = (merged.match(/<programme\b/g) || []).length
        grabState.progress.partialChannels  = ch
        grabState.progress.partialProgrammes = pr
      } catch {}
    }

    for (const [site, channels] of bySite.entries()) {
      grabState.progress.site = site
      log(`Grabbing ${site} (${channels.length} channels)…`)

      const configPath = path.join(SITES_DIR, site, `${site}.config.js`)
      if (!existsSync(configPath)) {
        log(`⚠ No config found for ${site} at ${configPath} — skipping (run a sync first)`)
        grabState.progress.done++
        continue
      }

      const siteChannelsFile = path.join(tmpDir, `${site}.channels.xml`)
      const siteOutputFile   = path.join(tmpDir, `${site}.guide.xml`)

      writeFileSync(siteChannelsFile, buildSiteChannelsXml(channels), 'utf8')

      const { code } = await spawnGrabber(configPath, siteChannelsFile, siteOutputFile,
        (line) => {
          const m = line.match(/\[(\d+)\/(\d+)\]/)
          if (m) {
            grabState.progress.channelDone  = parseInt(m[1])
            grabState.progress.channelTotal = parseInt(m[2])
          }
          log(`  [${site}] ${line}`)
        }
      )

      if (existsSync(siteOutputFile)) {
        outputFiles.push(siteOutputFile)
        log(`✓ ${site}: done${code !== 0 ? ` (exit ${code})` : ''} — flushing guide.xml…`)
        flushGuide()
      } else {
        log(`✗ ${site}: exited with code ${code}, no output produced`)
      }

      grabState.progress.done++
    }

    // Check if any sites produced output
    if (outputFiles.length === 0) {
      throw new Error('No EPG data was retrieved. All sites failed. Check that config files exist (run EPG Sync first).')
    }

    // Final merge (deduplicates across all sites and preserves existing data)
    log(`Finalising guide.xml from ${outputFiles.length} sites…`)
    const merged = mergeXmltvFiles(outputFiles, true) // Preserve existing data
    writeFileSync(GUIDE_XML, merged, 'utf8')

    // Clean up tmp files
    for (const f of outputFiles) { try { unlinkSync(f) } catch {} }

    grabState.guideExists  = true
    grabState.guideUrl     = `/guide.xml`

    const chanCount = (merged.match(/<channel\b/g) || []).length
    const progCount = (merged.match(/<programme\b/g) || []).length
    log(`guide.xml: ${chanCount} channels, ${progCount} programmes.`)

    // TMDB enrichment disabled - only runs via cron schedule or manual trigger
    // log(`Running TMDB enrichment…`)
    // await enrichGuide(GUIDE_XML, log)

    grabState.lastFinished = new Date().toISOString()
    return { ok: true, channels: chanCount, programmes: progCount }
  } catch (e) {
    grabState.lastError = e.message
    log(`Error: ${e.message}`)
    throw e
  } finally {
    grabState.inProgress = false
  }
}
