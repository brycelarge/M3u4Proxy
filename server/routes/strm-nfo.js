import express from 'express'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../db.js'

const router = express.Router()
const STRM_ROOT = '/data/vod-strm'

// Simple XML parser without external dependency
function parseXmlSimple(xml) {
  const result = { movie: null, tvshow: null, episodedetails: null }

  // Extract title
  const titleMatch = xml.match(/<title>([^<]+)<\/title>/i)
  const originalTitleMatch = xml.match(/<originaltitle>([^<]+)<\/originaltitle>/i)
  const showTitleMatch = xml.match(/<showtitle>([^<]+)<\/showtitle>/i)

  // Determine type
  if (xml.includes('<movie>')) {
    result.type = 'movie'
    result.title = titleMatch?.[1] || originalTitleMatch?.[1] || null
  } else if (xml.includes('<tvshow>')) {
    result.type = 'tvshow'
    result.title = titleMatch?.[1] || originalTitleMatch?.[1] || null
  } else if (xml.includes('<episodedetails>')) {
    result.type = 'episode'
    result.title = titleMatch?.[1] || null
    result.showTitle = showTitleMatch?.[1] || null
  }

  // Extract audio stream languages
  result.languages = []
  result.audioStreams = []
  result.hasEmptyStreamDetails = false

  // Check if streamdetails exists but is empty (no media info scanned)
  const streamDetailsMatch = xml.match(/<streamdetails>([\s\S]*?)<\/streamdetails>/i)
  if (streamDetailsMatch) {
    const streamDetailsContent = streamDetailsMatch[1].trim()
    if (!streamDetailsContent || streamDetailsContent === '') {
      result.hasEmptyStreamDetails = true
    }
  }

  // Also check for direct <language> tag at movie/tvshow level (Jellyfin format)
  // This is sometimes populated even when streamdetails is empty
  const directLangMatch = xml.match(/<language>([^<]+)<\/language>/i)
  if (directLangMatch) {
    const lang = directLangMatch[1]
    result.languages.push(lang)
  }

  // Find all <audio> blocks within <streamdetails>
  const audioRegex = /<audio>([\s\S]*?)<\/audio>/g
  let match
  while ((match = audioRegex.exec(xml)) !== null) {
    const audioBlock = match[1]
    const langMatch = audioBlock.match(/<language>([^<]+)<\/language>/i)
    const codecMatch = audioBlock.match(/<codec>([^<]+)<\/codec>/i)
    const channelsMatch = audioBlock.match(/<channels>([^<]+)<\/channels>/i)

    const lang = langMatch?.[1] || 'unknown'
    result.languages.push(lang)
    result.audioStreams.push({
      language: lang,
      codec: codecMatch?.[1] || null,
      channels: channelsMatch?.[1] ? parseInt(channelsMatch[1]) : null
    })
  }

  // FALLBACK: If no languages detected, try to infer from <country> tag
  // Common mapping: Country -> Language
  if (result.languages.length === 0) {
    const countryMatch = xml.match(/<country>([^<]+)<\/country>/i)
    if (countryMatch) {
      const country = countryMatch[1].trim()
      const countryToLang = {
        'USA': 'eng', 'United States': 'eng', 'US': 'eng',
        'UK': 'eng', 'United Kingdom': 'eng', 'GB': 'eng',
        'Italy': 'ita', 'Italia': 'ita',
        'France': 'fre', 'Francia': 'fre',
        'Germany': 'ger', 'Deutschland': 'ger',
        'Spain': 'spa', 'España': 'spa',
        'Portugal': 'por',
        'Brazil': 'por', 'Brasil': 'por',
        'Russia': 'rus', 'Россия': 'rus',
        'Japan': 'jpn', '日本': 'jpn',
        'China': 'chi', '中国': 'chi',
        'South Korea': 'kor', 'Korea': 'kor', '한국': 'kor',
        'India': 'hin',
        'Netherlands': 'dut', 'Nederland': 'dut',
        'Sweden': 'swe', 'Sverige': 'swe',
        'Norway': 'nor', 'Norge': 'nor',
        'Denmark': 'dan', 'Danmark': 'dan',
        'Finland': 'fin', 'Suomi': 'fin',
        'Poland': 'pol', 'Polska': 'pol',
        'Turkey': 'tur', 'Türkiye': 'tur',
        'Greece': 'gre',
        'Czech Republic': 'cze', 'Czechia': 'cze',
        'Hungary': 'hun', 'Magyarország': 'hun',
        'Romania': 'rum',
        'Bulgaria': 'bul',
        'Croatia': 'hrv',
        'Serbia': 'srp',
        'Slovenia': 'slv',
        'Slovakia': 'slo',
        'Ukraine': 'ukr',
        'Lithuania': 'lit',
        'Latvia': 'lav',
        'Estonia': 'est',
        'Israel': 'heb',
        'Arab Emirates': 'ara', 'UAE': 'ara',
        'Saudi Arabia': 'ara',
        'Egypt': 'ara',
        'Thailand': 'tha',
        'Vietnam': 'vie',
        'Indonesia': 'ind',
        'Malaysia': 'may',
        'Philippines': 'fil',
        'South Africa': 'afr', 'ZAF': 'afr'
      }
      const inferredLang = countryToLang[country]
      if (inferredLang) {
        result.languages.push(inferredLang)
        result.inferredFromCountry = country
      }
    }
  }

  // Extract subtitle languages
  result.subtitleStreams = []
  const subtitleRegex = /<subtitle>([\s\S]*?)<\/subtitle>/g
  while ((match = subtitleRegex.exec(xml)) !== null) {
    const subBlock = match[1]
    const langMatch = subBlock.match(/<language>([^<]+)<\/language>/i)
    result.subtitleStreams.push({
      language: langMatch?.[1] || 'unknown'
    })
  }

  // Get unique languages
  result.languages = [...new Set(result.languages.filter(Boolean))]

  return result
}

/**
 * Recursively find all .nfo files
 */
function findNfoFiles(dir, files = []) {
  try {
    const items = readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        findNfoFiles(fullPath, files)
      } else if (extname(item.name).toLowerCase() === '.nfo') {
        files.push(fullPath)
      }
    }
  } catch (e) {
    // Silently skip unreadable directories
  }
  return files
}

/**
 * Scan NFO files and extract language info
 */
async function scanNfoFiles() {
  if (!existsSync(STRM_ROOT)) {
    return { error: 'STRM root not found', path: STRM_ROOT }
  }

  const nfoFiles = findNfoFiles(STRM_ROOT)
  const results = []
  const languageStats = new Map()
  const errors = []

  for (const nfoPath of nfoFiles) {
    try {
      const content = readFileSync(nfoPath, 'utf-8')
      const data = parseXmlSimple(content)

      // Get relative path for cleaner output
      const relativePath = nfoPath.replace(STRM_ROOT, '').replace(/^\//, '')

      const entry = {
        path: relativePath,
        type: data.type,
        title: data.title,
        languages: data.languages,
        audioStreams: data.audioStreams,
        subtitleStreams: data.subtitleStreams,
        hasLanguages: data.languages.length > 0
      }

      results.push(entry)

      // Aggregate language stats
      for (const lang of data.languages) {
        const key = lang.toLowerCase()
        languageStats.set(key, (languageStats.get(key) || 0) + 1)
      }
    } catch (e) {
      errors.push({ path: nfoPath, error: e.message })
    }
  }

  // Sort by count
  const sortedLanguages = [...languageStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => ({ language: lang, count }))

  return {
    totalFiles: nfoFiles.length,
    scanned: results.length,
    errors: errors.length,
    movies: results.filter(r => r.type === 'movie').length,
    tvShows: results.filter(r => r.type === 'tvshow').length,
    episodes: results.filter(r => r.type === 'episode').length,
    withLanguages: results.filter(r => r.hasLanguages).length,
    withoutLanguages: results.filter(r => !r.hasLanguages).length,
    languageStats: sortedLanguages,
    files: results,
    errorDetails: errors.slice(0, 10)
  }
}

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/strm/nfo-languages - Scan all NFO files and report
router.get('/strm/nfo-languages', async (req, res) => {
  try {
    const result = await scanNfoFiles()
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/strm/nfo-languages/stats - Quick stats only
router.get('/strm/nfo-languages/stats', async (req, res) => {
  try {
    const full = await scanNfoFiles()
    res.json({
      totalFiles: full.totalFiles,
      scanned: full.scanned,
      errors: full.errors,
      movies: full.movies,
      tvShows: full.tvShows,
      episodes: full.episodes,
      withLanguages: full.withLanguages,
      withoutLanguages: full.withoutLanguages,
      languageStats: full.languageStats
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/strm/nfo-languages/missing - Files without language info
router.get('/strm/nfo-languages/missing', async (req, res) => {
  try {
    const full = await scanNfoFiles()
    const missing = full.files.filter(f => !f.hasLanguages)
    res.json({
      count: missing.length,
      files: missing
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/strm/nfo-languages/by-lang/:lang - Find files by language
router.get('/strm/nfo-languages/by-lang/:lang', async (req, res) => {
  try {
    const targetLang = req.params.lang.toLowerCase()
    const full = await scanNfoFiles()
    const matches = full.files.filter(f =>
      f.languages.some(l => l.toLowerCase() === targetLang)
    )
    res.json({
      language: req.params.lang,
      count: matches.length,
      files: matches
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/strm/languages - Get unique languages from all NFO files (for settings)
router.get('/strm/languages', async (req, res) => {
  try {
    const full = await scanNfoFiles()
    // Extract just unique language codes, always include 'eng'
    const languages = full.languageStats.map(ls => ls.language)
    if (!languages.includes('eng')) {
      languages.push('eng')
    }
    res.json({
      languages: languages.sort(),
      totalChannels: full.totalFiles,
      withLanguageData: full.withLanguages
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Auto-sync detected languages to vod_allowed_languages setting
export async function autoSyncVodLanguages() {
  try {
    const full = await scanNfoFiles()
    const detectedLanguages = full.languageStats.map(ls => ls.language)

    // Always include 'eng' as fallback
    if (!detectedLanguages.includes('eng')) {
      detectedLanguages.push('eng')
    }

    // Get current allowed languages
    const currentSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('vod_allowed_languages')
    const currentLanguages = currentSetting ? JSON.parse(currentSetting.value) : ['eng']

    // Merge: keep existing + add new detected languages (never remove)
    const mergedLanguages = [...new Set([...currentLanguages, ...detectedLanguages])].sort()

    // Update database
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('vod_allowed_languages', JSON.stringify(mergedLanguages))

    console.log(`[nfo-sync] Auto-synced VOD languages: ${mergedLanguages.join(', ')} (${mergedLanguages.length} total)`)

    return {
      detected: detectedLanguages.length,
      total: mergedLanguages.length,
      languages: mergedLanguages
    }
  } catch (e) {
    console.error('[nfo-sync] Auto-sync failed:', e.message)
    return null
  }
}

// GET /api/strm/nfo-missing-languages - CSV export of NFO files without allowed/missing languages
router.get('/strm/nfo-missing-languages', async (req, res) => {
  try {
    // Get current allowed languages
    const allowedSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('vod_allowed_languages')
    const allowedLanguages = allowedSetting ? JSON.parse(allowedSetting.value) : ['eng']
    const allowedSet = new Set(allowedLanguages.map(l => l.toLowerCase()))

    const full = await scanNfoFiles()

    // Filter files that:
    // 1. Have no detected languages at all, OR
    // 2. Have languages but none are in the allowed list
    const missingFiles = full.files.filter(f => {
      if (!f.languages || f.languages.length === 0) return true
      const hasAllowedLang = f.languages.some(l => allowedSet.has(l.toLowerCase()))
      return !hasAllowedLang
    })

    // Generate CSV
    const csvHeader = 'Title,Type,Path,Languages,Audio Streams,Issue\n'
    const csvRows = missingFiles.map(f => {
      const title = f.title || 'Unknown'
      const type = f.type || 'unknown'
      const path = f.path || ''
      const languages = f.languages ? f.languages.join('; ') : 'none'
      const audioStreams = f.audioStreams ? f.audioStreams.map(s => s.language || 'unknown').join('; ') : 'none'

      let issue = ''
      if (!f.languages || f.languages.length === 0) {
        if (f.hasEmptyStreamDetails) {
          issue = 'No media info in NFO (<streamdetails> is empty). Run library scan in Jellyfin/Emby to populate audio track info.'
        } else {
          issue = 'No language data detected in NFO'
        }
      } else if (f.inferredFromCountry) {
        issue = `Language '${f.languages[0]}' inferred from country '${f.inferredFromCountry}' (not from actual audio tracks)`
      } else {
        issue = `Languages not in allowed list: ${f.languages.join(', ')}`
      }

      // Escape quotes in fields
      const escape = (s) => `"${String(s).replace(/"/g, '""')}"`
      return [escape(title), escape(type), escape(path), escape(languages), escape(audioStreams), escape(issue)].join(',')
    }).join('\n')

    const csv = csvHeader + csvRows

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="nfo-missing-languages-${new Date().toISOString().split('T')[0]}.csv"`)
    res.send(csv)

    console.log(`[nfo-csv] Exported ${missingFiles.length} files without allowed languages (allowed: ${allowedLanguages.join(', ')})`)
  } catch (e) {
    console.error('[nfo-csv] Export failed:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/strm/sync-languages - Manually trigger NFO language scan and update settings
router.post('/strm/sync-languages', async (req, res) => {
  try {
    console.log('[nfo-sync] Manual language sync triggered via API')
    const result = await autoSyncVodLanguages()

    if (result) {
      res.json({
        success: true,
        message: `Synced ${result.detected} detected languages. Total allowed: ${result.total}`,
        detected: result.detected,
        total: result.total,
        languages: result.languages
      })
    } else {
      res.status(500).json({ success: false, error: 'Sync failed' })
    }
  } catch (e) {
    console.error('[nfo-sync] Manual sync failed:', e)
    res.status(500).json({ success: false, error: e.message })
  }
})

export default router
