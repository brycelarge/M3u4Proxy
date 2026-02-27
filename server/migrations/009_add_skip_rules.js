export function up(db) {
  db.exec(`
    ALTER TABLE sources ADD COLUMN skip_rules TEXT;
  `)
  console.log('[Migration 009] Added skip_rules column to sources table')
}

export function down(db) {
  console.log('[Migration 009] Rollback not implemented for skip_rules')
}
