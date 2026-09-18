import type { Quote } from '@shared/ipc'
import { normSymbols, type Bar, type BarInterval, type PriceFeed } from './feed'
import type { MarketStream, StreamEvents } from './alpacaStream'
import type { TapeQuote, TapeTrade } from './tape'

/**
 * Crypto spot prices from Coinbase Exchange's PUBLIC market data — the
 * WebSocket feed for the tape and the REST API for tickers and candles —
 * with no API key, no account and no plan.
 *
 * WHY THIS SOURCE (research 2026-09-17, measured live): the feed at
 * `wss://ws-feed.exchange.coinbase.com` accepts a subscription with no
 * authentication and delivered 45 BTC-USD prints in ten seconds, each with
 * the best bid and ask at that instant; `api.exchange.coinbase.com`
 * answers tickers and 5-minute / daily candles the same way (400+ USD
 * pairs). Alpaca's crypto data is keyless for polling but its socket needs
 * a key, and its own venue is thin (dozens of BTC prints a day); Kraken's
 * public socket is comparable to Coinbase's but Coinbase is the larger US
 * venue; Binance is geo-fenced; CoinGecko is minutes-old polled data. A
 * crypto agent therefore runs on a fresh install with nothing entered and
 * still sees a one-second tape.
 *
 * Symbols are the engine's `BASE/QUOTE`; Coinbase's product ids are
 * `BASE-QUOTE`. The parsers are pure so the wire format is pinned by a
 * check without a socket; the socket is the global `WebSocket` (Node 22+).
 */
export const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com'
const DEFAULT_BASE = 'https://api.exchange.coinbase.com'

/** `BTC/USD` → `BTC-USD`. */
export const coinbaseProductId = (symbol: string): string => symbol.toUpperCase().replace('/', '-')
/** `BTC-USD` → `BTC/USD`. */
export const coinbaseSymbol = (productId: string): string => productId.toUpperCase().replace('-', '/')

export type CoinbaseMessage =
  | { kind: 'trade'; symbol: string; trade: TapeTrade }
  | { kind: 'quote'; symbol: string; quote: TapeQuote }
  | { kind: 'subscriptions'; symbols: string[] }
  | { kind: 'heartbeat'; symbol: string }
  | { kind: 'error'; message: string }
  | { kind: 'other'; type: string }

/**
 * One frame from the feed (one JSON object per frame) as typed events.
 * A `ticker` carries the last print AND the touch, so it yields a quote
 * (best bid/ask with sizes); a `match` / `last_match` is a print. Malformed
 * input yields nothing.
 */
export function parseCoinbaseMessages(raw: string): CoinbaseMessage[] {
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return []
  }
  if (!m || typeof m !== 'object') return []
  const o = m as Record<string, unknown>
  const type = String(o.type ?? '')
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
  const at = (v: unknown): number => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN
    return Number.isFinite(t) ? t : Date.now()
  }
  const symbol = typeof o.product_id === 'string' ? coinbaseSymbol(o.product_id) : ''
  if ((type === 'match' || type === 'last_match') && symbol) return [{ kind: 'trade', symbol, trade: { t: at(o.time), p: num(o.price), s: num(o.size) } }]
  if (type === 'ticker' && symbol) return [{ kind: 'quote', symbol, quote: { t: at(o.time), bid: num(o.best_bid), ask: num(o.best_ask), bidSize: num(o.best_bid_size), askSize: num(o.best_ask_size) } }]
  if (type === 'heartbeat' && symbol) return [{ kind: 'heartbeat', symbol }]
  if (type === 'subscriptions') {
    const channels = Array.isArray(o.channels) ? (o.channels as { name?: string; product_ids?: string[] }[]) : []
    const ids = new Set<string>()
    for (const c of channels) for (const id of c.product_ids ?? []) ids.add(coinbaseSymbol(id))
    return [{ kind: 'subscriptions', symbols: [...ids] }]
  }
  if (type === 'error') return [{ kind: 'error', message: [o.message, o.reason].filter((v) => typeof v === 'string' && v).join(': ') || 'error' }]
  return [{ kind: 'other', type }]
}

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** The feed heartbeats every second per product; nothing for this long means the socket is dead. */
const STALE_MS = 30_000
const CHANNELS = ['ticker', 'matches', 'heartbeat']

/** The public feed as the same `MarketStream` the stocks socket is: subscribe to symbols, prints and quotes come back, reconnect on its own. */
export function coinbaseStream(opts: { events: StreamEvents; url?: string; log?: (level: 'info' | 'warn' | 'error', msg: string) => void }): MarketStream {
  const log = opts.log ?? (() => undefined)
  let ws: WebSocket | null = null
  let wanted: string[] = []
  let subscribed: string[] = []
  let open = false
  let closed = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let stale: ReturnType<typeof setTimeout> | null = null

  const armStale = (): void => {
    if (stale) clearTimeout(stale)
    stale = setTimeout(() => {
      if (!closed) {
        log('warn', 'feed went quiet — reconnecting')
        reconnect()
      }
    }, STALE_MS)
  }
  const send = (msg: unknown): void => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
  }
  const syncSubscription = (): void => {
    if (!open) return
    const add = wanted.filter((s) => !subscribed.includes(s))
    const drop = subscribed.filter((s) => !wanted.includes(s))
    if (drop.length) send({ type: 'unsubscribe', product_ids: drop.map(coinbaseProductId), channels: CHANNELS })
    if (add.length) send({ type: 'subscribe', product_ids: add.map(coinbaseProductId), channels: CHANNELS })
  }
  const teardown = (): void => {
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      ws = null
    }
    open = false
    subscribed = []
    if (stale) clearTimeout(stale)
    stale = null
  }
  const reconnect = (): void => {
    if (closed) return
    teardown()
    opts.events.state('reconnecting')
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
    attempt++
    if (retry) clearTimeout(retry)
    retry = setTimeout(connect, delay)
  }
  function connect(): void {
    if (closed) return
    opts.events.state(attempt === 0 ? 'connecting' : 'reconnecting')
    let sock: WebSocket
    try {
      sock = new WebSocket(opts.url ?? COINBASE_WS_URL)
    } catch (e) {
      opts.events.state('error', (e as Error).message)
      reconnect()
      return
    }
    ws = sock
    sock.onopen = () => {
      armStale()
      open = true
      attempt = 0
      opts.events.state('live')
      syncSubscription()
    }
    sock.onmessage = (ev: MessageEvent) => {
      armStale()
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
      for (const m of parseCoinbaseMessages(text)) {
        switch (m.kind) {
          case 'subscriptions':
            subscribed = m.symbols
            break
          case 'trade':
            opts.events.trade(m.symbol, m.trade)
            break
          case 'quote':
            opts.events.quote(m.symbol, m.quote)
            break
          case 'error':
            // The feed rejects a subscription it does not know (a made-up pair) and keeps the socket: say so, keep going.
            log('warn', `feed error: ${m.message}`)
            opts.events.state('live', m.message)
            break
          default:
            break
        }
      }
    }
    sock.onclose = () => {
      if (!closed) reconnect()
    }
    sock.onerror = () => {
      if (!closed) reconnect()
    }
  }
  connect()
  return {
    get symbols() {
      return subscribed
    },
    subscribe(symbols) {
      wanted = [...new Set(symbols.map((s) => s.toUpperCase()))]
      syncSubscription()
    },
    close() {
      closed = true
      if (retry) clearTimeout(retry)
      teardown()
    }
  }
}

/** A quote younger than this is served from memory (the public limit is 10 requests a second; a symbol costs one). */
const QUOTE_TTL_MS = 2_000
/** Candles per request, the API's cap. */
const CANDLES_MAX = 300
/** 5-minute candles are only ever read for the current ET day; two days covers it in two requests. */
const INTRA_MAX_MS = 48 * 3_600_000

export interface CoinbaseFeedOptions {
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/** The public REST side: tickers (marked at the mid, the book being the live number) and candles as the engine's bars. */
export function coinbaseFeed(opts: CoinbaseFeedOptions = {}): PriceFeed {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
  const f = opts.fetch ?? fetch
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => undefined)
  const cache = new Map<string, { at: number; quote: Quote }>()

  const get = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${base}${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await f(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'jev-realtime' } })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`coinbase ${res.status} on ${path}: ${body.slice(0, 160)}`)
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
      const failed: string[] = []
      await Promise.all(
        syms.map(async (s) => {
          const hit = cache.get(s)
          if (hit && at - hit.at < QUOTE_TTL_MS) {
            quotes.push(hit.quote)
            return
          }
          try {
            const t = await get<{ price?: string; bid?: string; ask?: string; time?: string }>(`/products/${coinbaseProductId(s)}/ticker`)
            const bid = Number(t.bid) || 0
            const ask = Number(t.ask) || 0
            const price = Number(t.price) || 0
            const last = bid > 0 && ask >= bid ? (bid + ask) / 2 : price
            if (!(last > 0)) throw new Error('no price')
            const q: Quote = { symbol: s, last, ts: t.time ?? new Date(at).toISOString() }
            if (bid > 0) q.bid = bid
            if (ask > 0) q.ask = ask
            quotes.push(q)
            cache.set(s, { at, quote: q })
          } catch (e) {
            log('warn', `${s}: ${(e as Error).message}`)
            failed.push(s)
          }
        })
      )
      return { quotes, failed }
    },
    async bars(symbols, startIso, interval: BarInterval) {
      const syms = normSymbols(symbols)
      const out: Record<string, Bar[]> = {}
      if (!syms.length) return out
      const granularity = interval === 'day' ? 86_400 : 300
      const end = now()
      const start = Math.max(Date.parse(startIso) || 0, interval === 'day' ? 0 : end - INTRA_MAX_MS)
      const window = CANDLES_MAX * granularity * 1000
      for (const s of syms) {
        const bars: Bar[] = []
        // Oldest window first; each request is at most `CANDLES_MAX` candles.
        for (let from = start; from < end; from += window) {
          const to = Math.min(end, from + window)
          const rows = await get<[number, number, number, number, number, number][]>(`/products/${coinbaseProductId(s)}/candles`, { granularity: String(granularity), start: new Date(from).toISOString(), end: new Date(to).toISOString() })
          // Rows are [time, low, high, open, close, volume], newest first.
          for (const r of rows) if (Array.isArray(r) && r[4] > 0) bars.push({ t: r[0], o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] })
        }
        bars.sort((a, b) => a.t - b.t)
        out[s] = bars
      }
      return out
    }
  }
}
