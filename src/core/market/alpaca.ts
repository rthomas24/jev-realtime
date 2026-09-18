import type { Quote } from '@shared/ipc'
import { isRegularSession } from '@shared/marketTime'
import { normSymbols, type Bar, type BarInterval, type PriceFeed } from './feed'

/**
 * The platform's market feed, served by Alpaca Market Data (Basic plan).
 *
 * WHY THIS VENDOR (research 2026-09-03, `docs/research/market-data-feed.md`):
 * one platform-held key prices every symbol for every account; snapshots take
 * a comma-separated symbol list, so cost is one request per ~100 DISTINCT
 * symbols per minute rather than per user; 200 requests/min on the free plan;
 * bars back to 2016 for the technicals block; IEX prints in real time with a
 * 15-minute-delayed consolidated tape as the fallback for names IEX rarely
 * trades. Finnhub's free plan is one symbol per call and non-commercial;
 * Twelve Data's is 800 calls a day; Polygon's is end-of-day. ⚠️ Alpaca's
 * standard terms do not permit REDISTRIBUTING its data; before this feed serves
 * a paying fleet at scale the operator needs Alpaca's data agreement (Broker
 * API partners get licensed data) or a display-licensed vendor behind this same
 * interface — which is why nothing outside this file knows the vendor's name.
 *
 * Node-free: plain `fetch`, injectable for tests. The key is the PLATFORM's
 * and lives only in the runner and the api (`server/src/lib/marketFeed.ts`);
 * the desktop reaches this feed through `/api/market/*` and never sees it.
 */
export interface AlpacaFeedOptions {
  keyId: string
  secretKey: string
  /** Primary feed. `iex` is what the free plan serves in real time. */
  feed?: 'iex' | 'sip' | 'delayed_sip'
  /** Where a symbol the primary feed has no fresh print for is retried. `null` = no fallback. */
  fallbackFeed?: 'delayed_sip' | 'sip' | null
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

const DEFAULT_BASE = 'https://data.alpaca.markets'
/** Symbols per snapshot request. The endpoint documents no cap; keep URLs short. */
const SNAPSHOT_CHUNK = 100
/**
 * A quote younger than this is served from memory. Ten agents watching AAPL in
 * the same minute cost one request, and a run that quotes a symbol twice costs
 * nothing the second time — the same global de-duplication the cloud sweep
 * does per account, done once for the whole process.
 */
const QUOTE_TTL_MS = 5_000
/** During the session, an IEX print older than this is "no fresh print" and the symbol goes to the fallback feed. */
const STALE_PRINT_MS = 20 * 60_000
const BARS_PAGE_LIMIT = 10_000
const BARS_MAX_PAGES = 5

/** One symbol's snapshot as Alpaca's stocks and crypto endpoints both shape it. */
export interface AlpacaSnapshot {
  latestTrade?: { p?: number; t?: string }
  latestQuote?: { bp?: number; ap?: number; t?: string }
  minuteBar?: { c?: number; t?: string }
  dailyBar?: { o?: number; c?: number; t?: string }
  prevDailyBar?: { c?: number }
}
type Snapshot = AlpacaSnapshot

export interface AlpacaRawBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** A snapshot as the quote shape every consumer takes; null without a usable price. */
export function alpacaSnapshotToQuote(symbol: string, s: AlpacaSnapshot, at: number): Quote | null {
  const last = s.latestTrade?.p ?? s.minuteBar?.c ?? s.dailyBar?.c
  if (!(typeof last === 'number' && last > 0)) return null
  const prevClose = s.prevDailyBar?.c
  const q: Quote = { symbol, last, ts: s.latestTrade?.t ?? new Date(at).toISOString() }
  if (typeof s.latestQuote?.bp === 'number' && s.latestQuote.bp > 0) q.bid = s.latestQuote.bp
  if (typeof s.latestQuote?.ap === 'number' && s.latestQuote.ap > 0) q.ask = s.latestQuote.ap
  if (typeof prevClose === 'number' && prevClose > 0) {
    q.prevClose = prevClose
    q.changePct = Math.round(((last - prevClose) / prevClose) * 10_000) / 100
  }
  return q
}

/** Raw bars as the engine's `Bar` (epoch seconds), junk rows dropped. */
export function alpacaBars(rows: AlpacaRawBar[] | null | undefined): Bar[] {
  const out: Bar[] = []
  for (const b of rows ?? []) if (b && b.c > 0) out.push({ t: Math.floor(Date.parse(b.t) / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
  return out
}

export function alpacaFeed(opts: AlpacaFeedOptions): PriceFeed {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
  const f = opts.fetch ?? fetch
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => undefined)
  const primary = opts.feed ?? 'iex'
  const fallback = opts.fallbackFeed === undefined ? (primary === 'iex' ? 'delayed_sip' : null) : opts.fallbackFeed
  const headers = { 'APCA-API-KEY-ID': opts.keyId, 'APCA-API-SECRET-KEY': opts.secretKey, Accept: 'application/json' }
  const cache = new Map<string, { at: number; quote: Quote }>()

  const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${base}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await f(url.toString(), { headers })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`market feed ${res.status} on ${path}: ${body.slice(0, 160)}`)
    }
    return (await res.json()) as T
  }

  const toQuote = alpacaSnapshotToQuote

  /** A print is fresh enough to fill a paper order against. Outside the session nothing is fresh, and nothing needs to be. */
  const fresh = (s: Snapshot, at: number): boolean => {
    if (!s.latestTrade?.t) return false
    if (!isRegularSession(new Date(at))) return true
    return at - Date.parse(s.latestTrade.t) < STALE_PRINT_MS
  }

  const snapshots = async (symbols: string[], feed: string): Promise<Record<string, Snapshot>> => {
    const out: Record<string, Snapshot> = {}
    for (let i = 0; i < symbols.length; i += SNAPSHOT_CHUNK) {
      const chunk = symbols.slice(i, i + SNAPSHOT_CHUNK)
      Object.assign(out, await get<Record<string, Snapshot>>('/v2/stocks/snapshots', { symbols: chunk.join(','), feed }))
    }
    return out
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
      const retry: string[] = []
      const snaps = await snapshots(want, primary)
      for (const s of want) {
        const snap = snaps[s]
        if (snap && fresh(snap, at)) {
          const q = toQuote(s, snap, at)
          if (q) {
            quotes.push(q)
            cache.set(s, { at, quote: q })
            got.add(s)
            continue
          }
        }
        retry.push(s)
      }
      // Symbols the primary feed had no fresh print for. Thin names may not
      // trade on IEX for an hour; the delayed consolidated tape still has them.
      // Best-effort: a fallback failure only leaves those symbols unpriced.
      if (retry.length && fallback) {
        try {
          const snaps2 = await snapshots(retry, fallback)
          for (const s of retry) {
            const q = snaps2[s] ? toQuote(s, snaps2[s], at) : null
            if (q) {
              quotes.push(q)
              cache.set(s, { at, quote: q })
              got.add(s)
            }
          }
        } catch (err) {
          log('warn', `market feed fallback (${fallback}) failed: ${(err as Error).message}`)
        }
      } else if (retry.length) {
        // No fallback configured: a stale primary print is still a price. Use it
        // rather than refusing — "stale" is the prompt's word for it outside
        // the session, and the caller can see `ts`.
        for (const s of retry) {
          const q = snaps[s] ? toQuote(s, snaps[s], at) : null
          if (q) {
            quotes.push(q)
            cache.set(s, { at, quote: q })
            got.add(s)
          }
        }
      }
      return { quotes, failed: want.filter((s) => !got.has(s)) }
    },
    async bars(symbols, startIso, interval: BarInterval) {
      const syms = normSymbols(symbols)
      const out: Record<string, Bar[]> = {}
      if (!syms.length) return out
      const timeframe = interval === 'day' ? '1Day' : '5Min'
      let token: string | undefined
      for (let page = 0; page < BARS_MAX_PAGES; page++) {
        const data = await get<{ bars?: Record<string, AlpacaRawBar[] | null>; next_page_token?: string | null }>('/v2/stocks/bars', {
          symbols: syms.join(','),
          timeframe,
          start: startIso,
          limit: String(BARS_PAGE_LIMIT),
          adjustment: 'raw',
          sort: 'asc',
          feed: primary === 'delayed_sip' ? 'sip' : primary,
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
