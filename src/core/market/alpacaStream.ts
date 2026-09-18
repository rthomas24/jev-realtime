import type { TapeQuote, TapeTrade } from './tape'

/**
 * Alpaca Market Data's WebSocket stream (`wss://stream.data.alpaca.markets/v2/<feed>`
 * for stocks, `.../v1beta3/crypto/us` for crypto), as a small client with
 * reconnect. Why this vendor: the polled feeds are already Alpaca
 * (`alpaca.ts`, `alpacaCrypto.ts`), the free plan streams IEX prints and
 * quotes in real time and crypto prints and quotes around the clock, and a
 * `test` feed prints a fake symbol (`FAKEPACA`) 24/7 so the whole path can be
 * watched with the market closed. One connection per account is allowed PER
 * ENDPOINT, so the host holds one stocks socket and one crypto socket; the
 * crypto one speaks the same auth, subscribe, trade and quote messages
 * (crypto trades add a taker side, `tks`, which the tape does not need).
 *
 * ⚠️ The key here is the OPERATOR's own (entered on the Real time page, kept
 * on this computer), never the platform's — the platform's key never reaches
 * an install, and the free plan's data is for the key holder's own use.
 *
 * `parseAlpacaMessages` is pure so the wire format is pinned by a check
 * without a socket; the socket is the global `WebSocket` (Node ≥ 22).
 */
export type AlpacaFeed = 'iex' | 'sip' | 'test' | 'crypto'

export interface StreamEvents {
  trade(symbol: string, t: TapeTrade): void
  quote(symbol: string, q: TapeQuote): void
  state(state: 'connecting' | 'live' | 'reconnecting' | 'error', detail?: string): void
}

export interface MarketStream {
  /** Replace the subscription with exactly these symbols (unsubscribes the rest). */
  subscribe(symbols: string[]): void
  close(): void
  readonly symbols: string[]
}

export type AlpacaMessage =
  | { kind: 'trade'; symbol: string; trade: TapeTrade }
  | { kind: 'quote'; symbol: string; quote: TapeQuote }
  | { kind: 'connected' }
  | { kind: 'authenticated' }
  | { kind: 'subscription'; trades: string[]; quotes: string[] }
  | { kind: 'error'; code: number; msg: string }
  | { kind: 'other'; T: string }

/** One frame from the wire (always a JSON array of messages) as typed events. Malformed input yields nothing. */
export function parseAlpacaMessages(raw: string): AlpacaMessage[] {
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(arr) ? arr : [arr]
  const out: AlpacaMessage[] = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const T = String(o.T ?? '')
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
    const at = (v: unknown): number => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN
      return Number.isFinite(t) ? t : Date.now()
    }
    if (T === 't' && typeof o.S === 'string') out.push({ kind: 'trade', symbol: o.S, trade: { t: at(o.t), p: num(o.p), s: num(o.s) } })
    else if (T === 'q' && typeof o.S === 'string') out.push({ kind: 'quote', symbol: o.S, quote: { t: at(o.t), bid: num(o.bp), ask: num(o.ap), bidSize: num(o.bs), askSize: num(o.as) } })
    else if (T === 'success' && o.msg === 'connected') out.push({ kind: 'connected' })
    else if (T === 'success' && o.msg === 'authenticated') out.push({ kind: 'authenticated' })
    else if (T === 'subscription') out.push({ kind: 'subscription', trades: Array.isArray(o.trades) ? (o.trades as string[]) : [], quotes: Array.isArray(o.quotes) ? (o.quotes as string[]) : [] })
    else if (T === 'error') out.push({ kind: 'error', code: num(o.code), msg: String(o.msg ?? '') })
    else out.push({ kind: 'other', T })
  }
  return out
}

/** Alpaca's error codes that mean "stop, the operator has to act" rather than "try again". */
export function alpacaErrorIsFatal(code: number): boolean {
  // 401 not authenticated, 402 auth failed, 403 already authenticated, 405 symbol limit exceeded, 406 connection limit exceeded, 409 insufficient subscription
  return [401, 402, 405, 406, 409].includes(code)
}

export function alpacaStreamUrl(feed: AlpacaFeed): string {
  // `us-1`: the Kraken-backed crypto location, the same one the polled feed reads (see `alpacaCrypto.ts`).
  return feed === 'crypto' ? 'wss://stream.data.alpaca.markets/v1beta3/crypto/us-1' : `wss://stream.data.alpaca.markets/v2/${feed}`
}

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** Nothing for this long (Alpaca sends nothing on a quiet symbol, but the socket pings) — assume the socket is dead. */
const STALE_MS = 90_000

type Ws = WebSocket

export function alpacaStream(opts: { keyId: string; secret: string; feed: AlpacaFeed; events: StreamEvents; url?: string; log?: (level: 'info' | 'warn' | 'error', msg: string) => void }): MarketStream {
  const log = opts.log ?? (() => undefined)
  let ws: Ws | null = null
  let wanted: string[] = []
  let subscribed: string[] = []
  let authed = false
  let closed = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let stale: ReturnType<typeof setTimeout> | null = null
  let fatal = false

  const armStale = (): void => {
    if (stale) clearTimeout(stale)
    stale = setTimeout(() => {
      if (!closed && !fatal) {
        log('warn', 'stream went quiet — reconnecting')
        reconnect()
      }
    }, STALE_MS)
  }
  const send = (msg: unknown): void => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
  }
  const syncSubscription = (): void => {
    if (!authed) return
    const add = wanted.filter((s) => !subscribed.includes(s))
    const drop = subscribed.filter((s) => !wanted.includes(s))
    if (drop.length) send({ action: 'unsubscribe', trades: drop, quotes: drop })
    if (add.length) send({ action: 'subscribe', trades: add, quotes: add })
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
    authed = false
    subscribed = []
    if (stale) clearTimeout(stale)
    stale = null
  }
  const reconnect = (): void => {
    if (closed || fatal) return
    teardown()
    opts.events.state('reconnecting')
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
    attempt++
    if (retry) clearTimeout(retry)
    retry = setTimeout(connect, delay)
  }
  function connect(): void {
    if (closed || fatal) return
    opts.events.state(attempt === 0 ? 'connecting' : 'reconnecting')
    let sock: Ws
    try {
      sock = new WebSocket(opts.url ?? alpacaStreamUrl(opts.feed))
    } catch (e) {
      opts.events.state('error', (e as Error).message)
      reconnect()
      return
    }
    ws = sock
    sock.onopen = () => {
      armStale()
      send({ action: 'auth', key: opts.keyId, secret: opts.secret })
    }
    sock.onmessage = (ev: MessageEvent) => {
      armStale()
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
      for (const m of parseAlpacaMessages(text)) {
        switch (m.kind) {
          case 'authenticated':
            authed = true
            attempt = 0
            opts.events.state('live')
            syncSubscription()
            break
          case 'subscription':
            subscribed = [...new Set([...m.trades, ...m.quotes])]
            break
          case 'trade':
            opts.events.trade(m.symbol, m.trade)
            break
          case 'quote':
            opts.events.quote(m.symbol, m.quote)
            break
          case 'error':
            log('warn', `stream error ${m.code}: ${m.msg}`)
            if (alpacaErrorIsFatal(m.code)) {
              fatal = true
              opts.events.state('error', `${m.msg} (${m.code})`)
              teardown()
            }
            break
          default:
            break
        }
      }
    }
    sock.onclose = () => {
      if (!closed && !fatal) reconnect()
    }
    sock.onerror = () => {
      if (!closed && !fatal) reconnect()
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
