/**
 * EPG Enrichment via TMDB
 *
 * Two persistent DB tables survive daily epg_cache refreshes:
 *   tmdb_enrichment  — show/movie level: title → tmdb_id, media_type, poster, desc
 *   tmdb_episodes    — episode level:    show_title + season + episode → poster, desc
 *
 * /api/playlists/:id/xmltv injects at serve time:
 *   1. Parse <episode-num system="xmltv_ns"> → S/E numbers
 *   2. Look up tmdb_episodes(show_title, season, episode) → episode still + desc
 *   3. Fall back to tmdb_enrichment(title) → show poster + desc
 *
 * epg_cache is NEVER mutated.
 *
 * Requires TMDB_API_KEY in .env
 */

import db from './db.js'
import { execSync } from 'child_process'
import { findNfoByTitle } from './nfo-parser.js'

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG  = 'https://image.tmdb.org/t/p/w300'
const tmdbKey   = () => process.env.TMDB_API_KEY || ''

export const enrichState = {
  inProgress: false,
  lastRun:    null,
  lastError:  null,
  enriched:   0,
  skipped:    0,
  log:        [],
}

function addLog(msg) {
  console.log(`[epg-enrich] ${msg}`)
  enrichState.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  if (enrichState.log.length > 200) enrichState.log.shift()
}

// ── TMDB API helpers ──────────────────────────────────────────────────────────
function tmdbGet(path) {
  const url = `${TMDB_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${tmdbKey()}&language=en-US`
  try {
    const result = execSync(`curl -s -m 8 "${url}"`, { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    return JSON.parse(result)
  } catch (err) {
    console.error(`[tmdb] curl failed for ${path}:`, err.message)
    return null
  }
}

// Decode HTML entities in titles
function decodeHtmlEntities(text) {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// Search for a title — returns { tmdb_id, media_type, poster, desc } or null
// Uses multi-search to reduce API calls from 2 to 1
function tmdbSearchTitle(title) {
  try {
    // Decode HTML entities before searching
    const cleanTitle = decodeHtmlEntities(title)
    const data = tmdbGet(`/search/multi?query=${encodeURIComponent(cleanTitle)}&page=1`)
    const results = data?.results || []

    // Filter to only TV and movie results, prioritize TV shows
    const tvResult = results.find(r => r.media_type === 'tv')
    const movieResult = results.find(r => r.media_type === 'movie')
    const top = tvResult || movieResult

    if (!top) return null

    return {
      tmdb_id:    top.id,
      media_type: top.media_type,
      poster:     top.poster_path ? `${TMDB_IMG}${top.poster_path}` : null,
      desc:       top.overview    || null,
    }
  } catch (err) {
    console.error(`[tmdb] Search failed for "${title}":`, err.message)
    return null
  }
}

// Fetch all episodes for a TV show and upsert into tmdb_episodes
export function fetchAndStoreAllEpisodes(title, tmdbId) {
  try {
    const show = tmdbGet(`/tv/${tmdbId}`)
    if (!show?.seasons) return
    const upsertEp = db.prepare(`
      INSERT INTO tmdb_episodes (show_title, season, episode, poster, description, fetched_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(show_title, season, episode) DO UPDATE SET
        poster=excluded.poster, description=excluded.description, fetched_at=excluded.fetched_at
    `)
    for (const season of show.seasons) {
      const sNum = season.season_number
      if (sNum < 1) continue  // skip specials (season 0)
      try {
        const sData = tmdbGet(`/tv/${tmdbId}/season/${sNum}`)
        if (!sData?.episodes) continue
        for (const ep of sData.episodes) {
          const poster = ep.still_path   ? `${TMDB_IMG}${ep.still_path}`   : null
          const desc   = ep.overview     || null
          upsertEp.run(title, sNum, ep.episode_number, poster, desc)
        }
        // Rate limit: 260ms between season requests
        execSync('sleep 0.26')
      } catch {}
    }
  } catch {}
}

// ── XML helpers ───────────────────────────────────────────────────────────────
export function extractTitle(progBlock) {
  const m = progBlock.match(/<title[^>]*>([^<]+)<\/title>/)
  return m ? decodeHtmlEntities(m[1].trim()) : null
}

// Parse xmltv_ns episode-num: "S.E.P" (0-indexed) → { season, episode } (1-indexed) or null
export function parseEpisodeNum(progBlock) {
  const m = progBlock.match(/<episode-num[^>]*system="xmltv_ns"[^>]*>([^<]+)<\/episode-num>/)
  if (!m) return null
  const parts = m[1].trim().split('.')
  const s = parseInt(parts[0], 10)
  const e = parseInt(parts[1], 10)
  if (isNaN(s) || isNaN(e)) return null
  return { season: s + 1, episode: e + 1 }  // xmltv_ns is 0-indexed
}

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Inject poster + desc into a programme block, only if not already present
export function injectEnrichment(progBlock, poster, desc) {
  let out = progBlock
  if (poster && !/<icon\b/.test(out)) {
    // Use a relative URL for the poster that will be resolved by the server
    // This ensures Plex can access the images
    const relativeUrl = `/api/logo?url=${encodeURIComponent(poster)}`
    out = out.replace(/<\/programme>/, `  <icon src="${escapeXml(relativeUrl)}" />\n</programme>`)
  }
  if (desc && !/<desc\b/.test(out)) {
    out = out.replace(/<\/programme>/, `  <desc lang="en">${escapeXml(desc)}</desc>\n</programme>`)
  }
  return out
}

// ── Main enrichment function ──────────────────────────────────────────────────
export async function enrichGuide(_unused, { onProgress } = {}) {
  if (!tmdbKey()) {
    addLog('TMDB_API_KEY not set — skipping enrichment.')
    return { skipped: true, reason: 'no_api_key' }
  }

  if (enrichState.inProgress) return { already: true }

  const cacheRows = db.prepare('SELECT source_id, content FROM epg_cache WHERE content IS NOT NULL').all()
  if (!cacheRows.length) return { skipped: true, reason: 'no_epg_cache' }

  enrichState.inProgress = true
  enrichState.lastError  = null
  enrichState.enriched   = 0
  enrichState.skipped    = 0
  enrichState.log        = []

  const log = (msg) => { addLog(msg); onProgress?.(msg) }

  try {
    // Build set of mapped EPG channel IDs
    const mappedIds = new Set(
      db.prepare('SELECT target_tvg_id FROM epg_mappings WHERE target_tvg_id IS NOT NULL').all()
        .map(r => r.target_tvg_id)
    )
    db.prepare('SELECT custom_tvg_id FROM playlist_channels WHERE custom_tvg_id IS NOT NULL').all()
      .forEach(r => mappedIds.add(r.custom_tvg_id))

    // Get list of news and sports channels to exclude from enrichment
    const excludedChannels = new Set(
      db.prepare("SELECT tvg_id FROM playlist_channels WHERE group_title LIKE '%news%' OR group_title LIKE '%sport%'").all()
        .map(r => r.tvg_id)
    )
    db.prepare("SELECT custom_tvg_id FROM playlist_channels WHERE custom_tvg_id IS NOT NULL AND (group_title LIKE '%news%' OR group_title LIKE '%sport%')").all()
      .forEach(r => excludedChannels.add(r.custom_tvg_id))

    log(`${mappedIds.size} mapped channel entries · ${excludedChannels.size} excluded news/sports channels · ${cacheRows.length} EPG source(s)`)

    // Collect unique titles from ALL programmes in epg_cache
    // (XML channel IDs use a different format to epg_mappings so we enrich everything)
    const progRe    = /<programme\b[^>]*channel="([^"]*)"[^>]*>[\s\S]*?<\/programme>/g
    const allTitles = new Set()
    let skippedNewsAndSports = 0

    for (const row of cacheRows) {
      progRe.lastIndex = 0
      let m
      while ((m = progRe.exec(row.content)) !== null) {
        const channelId = m[1]

        // Skip news and sports channels
        if (excludedChannels.has(channelId)) {
          skippedNewsAndSports++
          continue
        }

        const t = extractTitle(m[0])
        if (t) allTitles.add(t)
      }
    }

    log(`Skipped ${skippedNewsAndSports} programmes from news and sports channels`)
    log(`${allTitles.size} unique titles found across all EPG sources`)

    // Skip titles that are already fully enriched or blocked:
    //   - Blocked: skip entirely
    //   - TV shows: skip only if tmdb_episodes already has rows (episodes fetched)
    //   - Movies / not-found: skip if any tmdb_enrichment row exists
    const getEnrichRow = db.prepare('SELECT media_type, blocked, manual_override FROM tmdb_enrichment WHERE title = ?')
    const getEpCount   = db.prepare('SELECT COUNT(*) as c FROM tmdb_episodes WHERE show_title = ?')
    const needsFetch = [...allTitles].filter(title => {
      const row = getEnrichRow.get(title)
      if (!row) return true                          // never seen
      if (row.blocked) return false                  // blocked: skip
      if (row.manual_override) return false          // manual override: skip
      if (row.media_type === 'tv') return getEpCount.get(title).c === 0  // tv: only if no episodes yet
      return false                                   // movie / not-found: already done
    })

    log(`${allTitles.size} unique titles · ${needsFetch.length} need TMDB lookup`)

    if (!needsFetch.length) {
      log('All titles already enriched and up to date.')
      enrichState.lastRun = new Date().toISOString()
      return { ok: true, enriched: 0, skipped: allTitles.size }
    }

    const upsertShow = db.prepare(`
      INSERT INTO tmdb_enrichment (title, tmdb_id, media_type, poster, description, fetched_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(title) DO UPDATE SET
        tmdb_id=excluded.tmdb_id, media_type=excluded.media_type,
        poster=excluded.poster, description=excluded.description, fetched_at=excluded.fetched_at
    `)

    let nfoHits = 0
    let tmdbHits = 0

    for (let i = 0; i < needsFetch.length; i++) {
      const title = needsFetch[i]
      if (i > 0 && i % 40 === 0) {
        log(`  ${i}/${needsFetch.length} titles processed…`)
        await new Promise(r => setTimeout(r, 1000))
      }

      // First, try to find NFO file locally
      const nfoData = findNfoByTitle(title)
      let result = null

      if (nfoData && (nfoData.plot || nfoData.poster)) {
        // Found NFO file with metadata - use it instead of TMDB API
        result = {
          tmdb_id: nfoData.tmdbId || null,
          media_type: nfoData.tmdbId ? 'movie' : null,  // Assume movie if we have tmdb_id
          poster: nfoData.poster || null,
          desc: nfoData.plot || null
        }
        nfoHits++

        if (nfoHits <= 3) {
          log(`  ✓ "${title}" → NFO (local metadata)`)
        }
      } else {
        // No NFO found or NFO lacks metadata - fall back to TMDB API
        result = await tmdbSearchTitle(title)
        if (result) {
          tmdbHits++
        }
      }

      if (result) {
        upsertShow.run(title, result.tmdb_id, result.media_type, result.poster, result.desc)
        enrichState.enriched++

        // Debug: log first 3 successful TMDB enrichments to verify poster URLs
        if (tmdbHits <= 3 && result.poster && !nfoData) {
          log(`  ✓ "${title}" → ${result.media_type} (TMDB: ${result.poster.slice(0, 60)}...)`)
        }

        // For TV shows: fetch and store all seasons/episodes (only if from TMDB)
        if (result.media_type === 'tv' && result.tmdb_id && !nfoData) {
          log(`  Fetching all episodes for "${title}" (TMDB id ${result.tmdb_id})…`)
          await fetchAndStoreAllEpisodes(title, result.tmdb_id)
        }
      } else {
        // Store negative result so we don't re-query until TTL expires
        upsertShow.run(title, null, null, null, null)
        enrichState.skipped++
      }

      // Only rate limit if we hit TMDB API
      if (!nfoData) {
        await new Promise(r => setTimeout(r, 260))
      }
    }

    if (nfoHits > 0) {
      log(`Used local NFO files for ${nfoHits} titles (saved ${nfoHits} TMDB API calls)`)
    }

    enrichState.lastRun = new Date().toISOString()
    log(`Done. ${enrichState.enriched} titles enriched, ${enrichState.skipped} not found on TMDB.`)

    return { ok: true, enriched: enrichState.enriched, skipped: enrichState.skipped }
  } catch (e) {
    enrichState.lastError = e.message
    log(`Error: ${e.message}`)
    throw e
  } finally {
    enrichState.inProgress = false
  }
}
