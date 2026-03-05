import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { parseString } from 'xml2js'
import { promisify } from 'node:util'

const parseXml = promisify(parseString)

const STRM_ROOT = '/data/vod-strm'

/**
 * Recursively find all .nfo files in a directory
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
    console.error(`[nfo-scanner] Error reading ${dir}:`, e.message)
  }
  return files
}

/**
 * Parse an NFO file and extract language information
 */
async function parseNfoFile(nfoPath) {
  try {
    const content = readFileSync(nfoPath, 'utf-8')
    const result = await parseXml(content, { explicitArray: false })
    
    const data = {
      path: nfoPath,
      type: null,
      title: null,
      languages: [],
      audioStreams: [],
      subtitleStreams: [],
      fileinfo: null
    }

    // Determine type and extract data
    if (result.movie) {
      data.type = 'movie'
      data.title = result.movie.title || result.movie.originaltitle || null
      data.fileinfo = result.movie.fileinfo || null
    } else if (result.tvshow) {
      data.type = 'tvshow'
      data.title = result.tvshow.title || result.tvshow.originaltitle || null
      data.fileinfo = result.tvshow.fileinfo || null
    } else if (result.episodedetails) {
      data.type = 'episode'
      data.title = result.episodedetails.title || null
      data.showTitle = result.episodedetails.showtitle || null
      data.fileinfo = result.episodedetails.fileinfo || null
    }

    // Extract stream details if present
    if (data.fileinfo?.streamdetails) {
      const streams = data.fileinfo.streamdetails
      
      // Video streams (usually just one)
      if (streams.video) {
        const videos = Array.isArray(streams.video) ? streams.video : [streams.video]
        data.video = videos.map(v => ({
          codec: v.codec || null,
          width: v.width ? parseInt(v.width) : null,
          height: v.height ? parseInt(v.height) : null,
          language: v.language || null
        }))
      }

      // Audio streams (can be multiple languages)
      if (streams.audio) {
        const audios = Array.isArray(streams.audio) ? streams.audio : [streams.audio]
        data.audioStreams = audios.map(a => ({
          codec: a.codec || null,
          language: a.language || 'unknown',
          channels: a.channels ? parseInt(a.channels) : null
        }))
        // Extract unique languages
        data.languages = [...new Set(audios.map(a => a.language).filter(Boolean))]
      }

      // Subtitle streams
      if (streams.subtitle) {
        const subs = Array.isArray(streams.subtitle) ? streams.subtitle : [streams.subtitle]
        data.subtitleStreams = subs.map(s => ({
          language: s.language || 'unknown'
        }))
      }
    }

    return data
  } catch (e) {
    return {
      path: nfoPath,
      error: e.message,
      type: 'unknown'
    }
  }
}

/**
 * Scan all STRM folders and report language statistics
 */
export async function scanNfoLanguages() {
  console.log('[nfo-scanner] Scanning for NFO files...')
  
  if (!existsSync(STRM_ROOT)) {
    console.error(`[nfo-scanner] STRM root not found: ${STRM_ROOT}`)
    return { error: 'STRM root not found' }
  }

  const nfoFiles = findNfoFiles(STRM_ROOT)
  console.log(`[nfo-scanner] Found ${nfoFiles.length} NFO files`)

  if (nfoFiles.length === 0) {
    return { message: 'No NFO files found', files: [] }
  }

  const results = []
  const languageStats = new Map()
  const errors = []

  for (const nfoPath of nfoFiles) {
    const data = await parseNfoFile(nfoPath)
    results.push(data)

    if (data.error) {
      errors.push({ path: nfoPath, error: data.error })
      continue
    }

    // Aggregate language statistics
    for (const lang of data.languages) {
      const key = lang.toLowerCase()
      languageStats.set(key, (languageStats.get(key) || 0) + 1)
    }

    // Log languages found
    if (data.languages.length > 0) {
      console.log(`[nfo-scanner] ${data.title || 'Unknown'}: ${data.languages.join(', ')}`)
    }
  }

  // Sort by count
  const sortedLanguages = [...languageStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => ({ language: lang, count }))

  return {
    totalFiles: nfoFiles.length,
    movies: results.filter(r => r.type === 'movie').length,
    tvShows: results.filter(r => r.type === 'tvshow').length,
    episodes: results.filter(r => r.type === 'episode').length,
    errors: errors.length,
    languageStats: sortedLanguages,
    filesWithLanguages: results.filter(r => r.languages?.length > 0).length,
    filesWithoutLanguages: results.filter(r => r.languages?.length === 0 && !r.error).length,
    errorDetails: errors.slice(0, 10), // First 10 errors
    sampleFiles: results.filter(r => r.languages?.length > 0).slice(0, 5) // Sample for debugging
  }
}

/**
 * Find movies/shows without language info
 */
export async function findMissingLanguages() {
  const nfoFiles = findNfoFiles(STRM_ROOT)
  const missing = []

  for (const nfoPath of nfoFiles) {
    const data = await parseNfoFile(nfoPath)
    if (!data.error && data.languages?.length === 0) {
      missing.push({
        path: nfoPath,
        title: data.title,
        type: data.type
      })
    }
  }

  return missing
}

/**
 * Find all files by specific language
 */
export async function findByLanguage(targetLang) {
  const nfoFiles = findNfoFiles(STRM_ROOT)
  const matches = []
  const normalizedLang = targetLang.toLowerCase()

  for (const nfoPath of nfoFiles) {
    const data = await parseNfoFile(nfoPath)
    if (!data.error && data.languages?.some(l => l.toLowerCase() === normalizedLang)) {
      matches.push({
        path: nfoPath,
        title: data.title,
        type: data.type,
        languages: data.languages,
        audioStreams: data.audioStreams
      })
    }
  }

  return matches
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'scan'
  
  switch (action) {
    case 'scan':
      scanNfoLanguages().then(console.log)
      break
    case 'missing':
      findMissingLanguages().then(console.log)
      break
    case 'lang':
      findByLanguage(process.argv[3] || 'eng').then(console.log)
      break
    default:
      console.log('Usage: node nfo-language-scanner.js [scan|missing|lang <language>]')
  }
}
