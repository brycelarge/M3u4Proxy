export function up(db) {
  console.log('[Migration 016] Adding logo column to epg_site_channels')

  // Check if column already exists
  const hasLogo = db.prepare(`
    SELECT COUNT(*) as c FROM pragma_table_info('epg_site_channels') WHERE name = 'logo'
  `).get().c > 0

  if (!hasLogo) {
    db.exec(`
      ALTER TABLE epg_site_channels ADD COLUMN logo TEXT NOT NULL DEFAULT ''
    `)
    console.log('[Migration 016] ✓ Added logo column to epg_site_channels')
  } else {
    console.log('[Migration 016] ✓ Logo column already exists, skipping')
  }
}

export function down(db) {
  console.log('[Migration 016] Removing logo column from epg_site_channels')
  // SQLite doesn't support DROP COLUMN directly, would need table recreation
  console.log('[Migration 016] ⚠ Rollback not implemented (SQLite limitation)')
}
