import { randomBytes } from 'node:crypto'

/**
 * Generate a 32-byte base64 secret for ENCRYPTION_KEY or UNSUBSCRIBE_SECRET.
 * Usage:  npm run keygen
 */
const key = randomBytes(32).toString('base64')
process.stdout.write(`${key}\n`)
