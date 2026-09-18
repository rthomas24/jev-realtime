import type { Quote } from '@shared/ipc'
import { alpacaBars, alpacaSnapshotToQuote, type AlpacaRawBar, type AlpacaSnapshot } from './alpaca'
import { normSymbols, type Bar, type BarInterval, type PriceFeed } from './feed'

/**
 * Crypto spot prices, served by Alpaca's crypto market data (`v1beta3/crypto/us`).
 *
 * WHY THIS SOURCE (research 2026-09-17): the snapshot and bars endpoints
 * answer WITHOUT an API key — the whole polled path is free and keyless, so
 * a crypto agent runs on a fresh install with nothing entered; the operator's
 * free Alpaca key (the one the stocks stream already asks for) is accepted
 * too, and the same key opens the crypto WebSocket (`alpacaStream`, feed
 * `crypto`) for real prints and quotes on the one-second tape. Same symbol
 * list per request, same snapshot shape, same bar shape as the stocks feed,
 * so the engine sees one kind of feed. Coinbase's and Kraken's public
 * sockets are also free and keyless but would be a second vendor, a second
 * wire format and a second set of symbols for the same numbers; Binance is
 * geo-fenced; CoinGecko is polled, minutes old, on a small daily quota.
 *
 * Crypto trades around the clock: nothing here knows a session. The
 * location is `us-1` (Kraken US data via Alpaca), not Alpaca's own venue
 * (`us`): measured 2026-09-17, `us` printed 32 BTC trades in a day and its
 * last trade was minutes old while `us-1` printed 5,500 with the last one a
 * second old — a tape a one-second agent can read. Both are keyless. Even
 * so a thin pair may not print for a while, so a two-sided quote newer than
 * the last trade marks the pair at its mid (`markAtMid`) and the price
 * moves with the book. Alpaca's daily bars roll at midnight UTC, so
 * `prevClose` is the prior UTC day's close, which the situation names as such.
 *
 * Node-free: plain `fetch`, injectable for tests.
 */
export interface AlpacaCryptoFeedOptions {
  /** Optional: the operator's Alpaca key. Without one the public endpoints still answer. */
  keyId?: string
  secretKey?: string
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

const DEFAULT_BASE = 'https://data.alpaca.markets'
/** Kraken-backed location: see the header. The stream uses the same one (`alpacaStreamUrl('crypto')`). */
export const CRYPTO_LOC = 'us-1'
const LOC = CRYPTO_LOC
const SNAPSHOT_CHUNK = 100
/**
 * A quote younger than this is served from memory. Two seconds, not the
 * stocks feed's five: a crypto agent may run without a stream, and this is
 * then its whole cadence — while keyless requests stay well inside the
 * public rate limit (a one-second agent costs 30 a minute).
 */
const QUOTE_TTL_MS = 2_000
const BARS_PAGE_LIMIT = 10_000
const BARS_MAX_PAGES = 5

export function alpacaCryptoFeed(opts: AlpacaCryptoFeedOptions = {}): PriceFeed {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
  const f = opts.fetch ?? fetch
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => undefined)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.keyId && opts.secretKey) {
    headers['APCA-API-KEY-ID'] = opts.keyId
    headers['APCA-API-SECRET-KEY'] = opts.secretKey
  }
  const cache = new Map<string, { at: number; quote: Quote }>()

  const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${base}/v1beta3/crypto/${LOC}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await f(url.toString(), { headers })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`crypto feed ${res.status} on ${path}: ${body.slice(0, 160)}`)
    }
    return (await res.json()) as T
  }

  return {
    id: 'feed',
    async quotes(symbols) {
      const syms = normSymbols(symbols)
      if (!syms.length) return { quotes: [], failed: [] }
      const at = now()
      const quotes: Quote[] = []
      const want: string[] = []
      for (const s of syms) {
        const hit = cache.get(s)
        if (hit && at - hit.at < QUOTE_TTL_MS) quotes.push(hit.quote)
        else want.push(s)
      }
      if (!want.length) return { quotes, failed: [] }
      const got = new Set<string>()
      for (let i = 0; i < want.length; i += SNAPSHOT_CHUNK) {
        const chunk = want.slice(i, i + SNAPSHOT_CHUNK)
        const data = await get<{ snapshots?: Record<string, AlpacaSnapshot> }>('/snapshots', { symbols: chunk.join(',') })
        for (const [sym, snap] of Object.entries(data.snapshots ?? {})) {
          const symbol = sym.toUpperCase()
          const q = snap ? alpacaSnapshotToQuote(symbol, snap, at, { markAtMid: true }) : null
          if (!q) continue
          quotes.push(q)
          cache.set(symbol, { at, quote: q })
          got.add(symbol)
        }
      }
      const failed = want.filter((s) => !got.has(s))
      if (failed.length) log('warn', `crypto feed had no snapshot for ${failed.join(', ')}`)
      return { quotes, failed }
    },
    async bars(symbols, startIso, interval: BarInterval) {
      const syms = normSymbols(symbols)
      const out: Record<string, Bar[]> = {}
      if (!syms.length) return out
      const timeframe = interval === 'day' ? '1Day' : '5Min'
      let token: string | undefined
      for (let page = 0; page < BARS_MAX_PAGES; page++) {
        const data = await get<{ bars?: Record<string, AlpacaRawBar[] | null>; next_page_token?: string | null }>('/bars', {
          symbols: syms.join(','),
          timeframe,
          start: startIso,
          limit: String(BARS_PAGE_LIMIT),
          sort: 'asc',
          ...(token ? { page_token: token } : {})
        })
        for (const [sym, rows] of Object.entries(data.bars ?? {})) (out[sym.toUpperCase()] ??= []).push(...alpacaBars(rows))
        if (!data.next_page_token) break
        token = data.next_page_token
      }
      return out
    }
  }
}
