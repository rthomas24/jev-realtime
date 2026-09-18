import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RealtimeKeyStatus } from '@shared/realtimeAgents'
import { decryptString, encryptString } from '../lib/secureFile'

/**
 * The operator's TypeSafe API key — what the real-time agents decide with.
 * Encrypted at rest like the intel MCP keys (`mcpKeys.ts`); only `hasKey`
 * and the last test's result cross to the renderer, never the value.
 */
function file(): string {
  const dir = join(app.getPath('userData'), 'credentials')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'typesafe.bin')
}

interface Stored {
  key: string
  models?: string[]
  testedAt?: string
  error?: string
}

let cache: Stored | null | undefined

function load(): Stored | null {
  if (cache !== undefined) return cache
  try {
    cache = existsSync(file()) ? (JSON.parse(decryptString(readFileSync(file()))) as Stored) : null
  } catch {
    cache = null
  }
  return cache
}
function persist(next: Stored | null): void {
  cache = next
  if (!next) rmSync(file(), { force: true })
  else writeFileSync(file(), encryptString(JSON.stringify(next)))
}

export const typesafeKey = {
  /** The secret itself — for the engine only. */
  value(): string | null {
    return load()?.key ?? null
  },
  status(): RealtimeKeyStatus {
    const s = load()
    return { hasKey: Boolean(s?.key), models: s?.models, testedAt: s?.testedAt, error: s?.error }
  },
  set(key: string): RealtimeKeyStatus {
    const k = key.trim()
    persist(k ? { key: k } : null)
    return this.status()
  },
  clear(): RealtimeKeyStatus {
    return this.set('')
  },
  /** Record what the service said when the key was tried. */
  noteTest(result: { models?: string[]; error?: string }): RealtimeKeyStatus {
    const s = load()
    if (s) persist({ key: s.key, models: result.models, error: result.error, testedAt: new Date().toISOString() })
    return this.status()
  }
}
