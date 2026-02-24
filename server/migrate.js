/**
 * Database Migration Runner
 * Automatically runs pending migrations on startup
 */

import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, 'migrations')

/**
 * Run all pending migrations
 */
export async function runMigrations(db) {
  console.log('[Migrations] Checking for pending migrations...')
  
  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)
  
  // Get list of applied migrations
  const applied = db.prepare('SELECT name FROM migrations').all().map(r => r.name)
  
  // Get list of migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
  
  if (files.length === 0) {
    console.log('[Migrations] No migration files found')
    return
  }
  
  // Run pending migrations
  let ranCount = 0
  for (const file of files) {
    const name = file.replace('.js', '')
    
    if (applied.includes(name)) {
      continue // Already applied
    }
    
    console.log(`[Migrations] Running migration: ${name}`)
    
    try {
      // Import and run migration
      const migration = await import(join(MIGRATIONS_DIR, file))
      
      if (typeof migration.up !== 'function') {
        console.error(`[Migrations] Migration ${name} has no 'up' function`)
        continue
      }
      
      // Run migration in a transaction
      const runMigration = db.transaction(() => {
        migration.up(db)
        db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name)
      })
      
      runMigration()
      ranCount++
      console.log(`[Migrations] ✓ Applied migration: ${name}`)
      
    } catch (err) {
      console.error(`[Migrations] ✗ Failed to apply migration ${name}:`, err.message)
      throw err // Stop on first error
    }
  }
  
  if (ranCount === 0) {
    console.log('[Migrations] All migrations up to date')
  } else {
    console.log(`[Migrations] Applied ${ranCount} migration(s)`)
  }
}
