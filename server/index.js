import express from 'express'
import cors from 'cors'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import os from 'node:os'

import db from './db.js'
import { runMigrations } from './migrate.js'
import { startStatsFlusher } from './stats-flusher.js'
import { registerHdhrRoutes, startAllDeviceServers } from './hdhr.js'
import { registerXtreamRoutes } from './xtream.js'
import { startContentUpdateScheduler, startEpgGrabCron, startEnrichCron } from './services/scheduler.js'

// Import Routers
import authRoutes from './routes/auth.js'
import sourcesRoutes from './routes/sources.js'
import playlistsRoutes from './routes/playlists.js'
import epgRoutes from './routes/epg.js'
import streamsRoutes from './routes/streams.js'
import settingsRoutes from './routes/settings.js'
import compositeRoutes from './routes/composite.js'
import systemRoutes from './routes/system.js'
import backupRoutes from './routes/backup.js'
import hdhrVirtualDevicesRoutes from './routes/hdhr-virtual-devices.js'
import diagnosticsRoutes from './routes/diagnostics.js'
import tmdbRoutes from './routes/tmdb.js'
import sourceChannelsRoutes from './routes/source-channels.js'
import playlistChannelsRoutes from './routes/playlist-channels.js'
import strmNfoRoutes from './routes/strm-nfo.js'
import portalRoutes from './routes/portal.js'
import streamStatsRoutes from './routes/stream-stats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3005

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Serve built Vue app in production
const distPath = path.join(__dirname, '../dist')
app.use(express.static(distPath))

// Mount API Routes
app.use('/api', systemRoutes)
app.use('/api', authRoutes)
app.use('/api', sourcesRoutes)
app.use('/api', playlistsRoutes)
app.use('/api', epgRoutes)
app.use('/api', settingsRoutes)
app.use('/api/composite-streams', compositeRoutes)
app.use('/api/streams', streamsRoutes) // This mounts /api/streams endpoints
app.use('/api/stream-stats', streamStatsRoutes)
app.use('/api', backupRoutes)
app.use('/api', hdhrVirtualDevicesRoutes)
app.use('/api', diagnosticsRoutes)
app.use('/api', tmdbRoutes)
app.use('/api', sourceChannelsRoutes)
app.use('/api', playlistChannelsRoutes)
app.use('/api', strmNfoRoutes)

// The proxy endpoints from streams need to be mounted at root
// to match existing URL structures like /stream/:id
import { default as streamsRootRouter } from './routes/streams.js'
app.use('/', streamsRootRouter) // Mounts /stream and /stream-web

// Serve guide.xml at ROOT (not under /api) for EPG feed compatibility
app.get('/guide.xml', async (req, res) => {
  const { existsSync } = await import('node:fs')
  const { GUIDE_XML } = await import('./epgGrab.js')
  if (!existsSync(GUIDE_XML)) return res.status(404).send('guide.xml not yet generated. Run an EPG grab first.')
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.sendFile(GUIDE_XML)
})

// Run migrations on startup
runMigrations(db)
startStatsFlusher()

// Start device servers
startAllDeviceServers(db)

// Start content update scheduler
startContentUpdateScheduler()
startEpgGrabCron()
startEnrichCron()

// Xtream UI / API routes
registerXtreamRoutes(app, db)

// MAG Portal API routes
app.use('/', portalRoutes)

// HDHomeRun routes
registerHdhrRoutes(app, db)

// Cleanup old temp directories on startup
function cleanupOnStartup() {
  const tmpdir = os.tmpdir()

  if (existsSync(tmpdir)) {
    try {
      const items = readdirSync(tmpdir)
      for (const item of items) {
        if (item.startsWith('m3u4prox-composite-')) {
          const itemPath = join(tmpdir, item)
          if (statSync(itemPath).isDirectory()) {
            console.log(`[cleanup] Removing orphaned temp dir: ${itemPath}`)
            rmSync(itemPath, { recursive: true, force: true })
          }
        }
      }
    } catch (err) {
      console.log(`[cleanup] Could not clean temp directory: ${err.message}`)
    }
  }
}

cleanupOnStartup()

// Log all unhandled requests to debug missing routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/stream')) {
    console.log(`[unhandled] ${req.method} ${req.path}`)
  }
  // For non-API routes, let it fall through to Vue router if needed,
  // or return 404 for API requests
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Endpoint not found' })
  } else {
    next()
  }
})

// Fallback for Vue router (must be last)
app.get('/{*path}', (req, res) => {
  if (existsSync(join(distPath, 'index.html'))) {
    res.sendFile(join(distPath, 'index.html'))
  } else {
    res.status(404).send('Not found')
  }
})

app.listen(PORT, '0.0.0.0', async () => {
  const host = process.env.HOST_IP || 'localhost'
  console.log(`M3u4Proxy server running on http://${host}:${PORT}`)
  console.log('Server version: 2026-03-05-v5 (Modular Refactor)')

  // Build NFO index on startup for fast Xtream VOD/series metadata
  try {
    const { buildNfoIndex } = await import('./nfo-index.js')
    buildNfoIndex()
  } catch (e) {
    console.error('[startup] Failed to build NFO index:', e.message)
  }
})
