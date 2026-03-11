export function up(db) {
  console.log('[Migration 017] Adding epg_programmes table for fast XMLTV generation')

  db.exec(`
    CREATE TABLE IF NOT EXISTS epg_programmes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      channel_id  TEXT NOT NULL,
      start       TEXT NOT NULL,
      stop        TEXT NOT NULL,
      title       TEXT,
      desc        TEXT,
      icon        TEXT,
      episode_num TEXT,
      raw         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ep_source_channel ON epg_programmes(source_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_ep_channel        ON epg_programmes(channel_id);
  `)

  console.log('[Migration 017] ✓ Created epg_programmes table and indexes')

  // Backfill from existing epg_cache blobs so XMLTV works immediately
  // without needing a manual EPG source refresh
  const cacheRows = db.prepare('SELECT source_id, content FROM epg_cache WHERE content IS NOT NULL').all()

  if (cacheRows.length === 0) {
    console.log('[Migration 017] No cached EPG content to backfill')
    return
  }

  const insertProg = db.prepare(`
    INSERT INTO epg_programmes (source_id, channel_id, start, stop, raw)
    VALUES (?, ?, ?, ?, ?)
  `)

  const attrRe = /(\w[\w-]*)="([^"]*)"/g

  let totalCount = 0
  for (const { source_id, content } of cacheRows) {
    let progCount = 0
    let pos = 0

    while (true) {
      const startIdx = content.indexOf('<programme ', pos)
      if (startIdx === -1) break

      const endIdx = content.indexOf('</programme>', startIdx)
      if (endIdx === -1) break

      pos = endIdx + 12
      const raw = content.substring(startIdx, pos)

      // Extract attributes from opening tag only
      const tagEnd = content.indexOf('>', startIdx)
      const openTag = content.substring(startIdx, tagEnd + 1)

      let channelId = '', start = '', stop = ''
      attrRe.lastIndex = 0
      let m
      while ((m = attrRe.exec(openTag)) !== null) {
        if (m[1] === 'channel') channelId = m[2]
        else if (m[1] === 'start') start = m[2]
        else if (m[1] === 'stop') stop = m[2]
      }

      if (channelId) {
        insertProg.run(source_id, channelId, start, stop, raw)
        progCount++
      }
    }

    console.log(`[Migration 017] Backfilled ${progCount} programmes from source ${source_id}`)
    totalCount += progCount
  }

  console.log(`[Migration 017] ✓ Backfilled ${totalCount} total programmes from ${cacheRows.length} EPG source(s)`)
}

export function down(db) {
  console.log('[Migration 017] Removing epg_programmes table')
  db.exec('DROP TABLE IF EXISTS epg_programmes')
}
