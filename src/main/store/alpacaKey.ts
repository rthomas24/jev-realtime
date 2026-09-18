import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RealtimeStreamFeed } from '@shared/realtimeAgents'
import { decryptString, encryptString } from '../lib/secureFile'

/**
 * The operator's own market-data stream key (Alpaca), for the real-time
 * agents' one-second tape. Encrypted at rest like every other secret on this
 * computer; only "configured" and the chosen feed cross to the renderer.
 * Distinct from the PLATFORM's Alpaca key, which lives on the server and
 * never reaches an install.
 */
function file(): string {
  const dir = join(app.getPath('userData'), 'credentials')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'market-stream.bin')
}

export interface StoredStreamKey {
  keyId: string
  secret: string
  feed: RealtimeStreamFeed
}

let cache: StoredStreamKey | null | undefined

export const alpacaKey = {
  get(): StoredStreamKey | null {
    if (cache !== undefined) return cache
    try {
      cache = existsSync(file()) ? (JSON.parse(decryptString(readFileSync(file()))) as StoredStreamKey) : null
    } catch {
      cache = null
    }
    return cache
  },
  set(next: StoredStreamKey | null): void {
    cache = next
    if (!next) rmSync(file(), { force: true })
    else writeFileSync(file(), encryptString(JSON.stringify(next)))
  }
}
