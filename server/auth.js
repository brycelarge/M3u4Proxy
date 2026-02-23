/**
 * Password hashing using Node built-in crypto.scrypt
 * Format: scrypt$salt$hash (all hex)
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const KEYLEN = 64

export async function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptAsync(plain, salt, KEYLEN)
  return `scrypt$${salt}$${hash.toString('hex')}`
}

export async function verifyPassword(plain, stored) {
  // Legacy plaintext — plain comparison
  if (!stored.startsWith('scrypt$')) return stored === plain
  const [, salt, hashHex] = stored.split('$')
  const hashBuf  = Buffer.from(hashHex, 'hex')
  const derived  = await scryptAsync(plain, salt, KEYLEN)
  return timingSafeEqual(hashBuf, derived)
}

export function isHashed(stored) {
  return stored?.startsWith('scrypt$')
}
