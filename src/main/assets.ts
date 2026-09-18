import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssetInfo } from '@shared/tickers'
import { writeJson } from './store/json'
import { alpacaKey } from './store/alpacaKey'

/**
 * The full tradable asset list from the operator's own Alpaca key, so the
 * picker completes any US equity and any crypto pair by symbol or name —
 * the built-in catalogue only knows the popular ones. Fetched once a day
 * (the list moves slowly), kept on disk so a restart does not refetch, and
 * absent — never an error — when there is no key or the request fails: the
 * picker still works from the catalogue.
 *
 * The trading API is where assets live (`/v2/assets`); a paper key answers
 * on `paper-api`, a live key on `api`. Both are tried, paper first.
 */
const TTL_MS = 24 * 3600_000
const HOSTS = ['https://paper-api.alpaca.markets', 'https://api.alpaca.markets']

interface Cached {
  at: number
  keyId: string
  assets: AssetInfo[]
}

let memo: Cached | null = null
let inflight: Promise<AssetInfo[]> | null = null

function file(): string {
  return join(app.getPath('userData'), 'assets.json')
}

function fromDisk(): Cached | null {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Cached) : null
  } catch {
    return null
  }
}

async function fetchClass(host: string, keyId: string, secret: string, cls: 'us_equity' | 'crypto'): Promise<AssetInfo[] | null> {
  const res = await fetch(`${host}/v2/assets?status=active&asset_class=${cls}`, { headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' } })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`assets ${res.status}`)
  const rows = (await res.json()) as { symbol?: string; name?: string; tradable?: boolean }[]
  return rows
    .filter((r) => r.symbol && r.tradable !== false)
    .map((r) => ({ symbol: String(r.symbol), name: String(r.name ?? '').replace(/\s+/g, ' ').trim(), kind: cls === 'crypto' ? ('crypto' as const) : ('stocks' as const) }))
}

/** The list, or `[]` when it cannot be had. Never throws. */
export async function liveAssets(): Promise<AssetInfo[]> {
  const k = alpacaKey.get()
  if (!k) return []
  const fresh = (c: Cached | null): boolean => c !== null && c.keyId === k.keyId && Date.now() - c.at < TTL_MS
  if (memo && fresh(memo)) return memo.assets
  const disk = fromDisk()
  if (disk && fresh(disk)) {
    memo = disk
    return disk.assets
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      for (const host of HOSTS) {
        const equities = await fetchClass(host, k.keyId, k.secret, 'us_equity')
        if (equities === null) continue
        const crypto = (await fetchClass(host, k.keyId, k.secret, 'crypto').catch(() => [])) ?? []
        const assets = [...equities, ...crypto]
        memo = { at: Date.now(), keyId: k.keyId, assets }
        try {
          writeJson(file(), memo)
        } catch {
          /* the memo is enough for this run */
        }
        return assets
      }
      console.warn('[assets] the key was not accepted by either trading host — the picker keeps the built-in list')
      return disk?.assets ?? []
    } catch (e) {
      console.warn('[assets] fetch failed', (e as Error).message)
      return disk?.assets ?? []
    } finally {
      inflight = null
    }
  })()
  return inflight
}
