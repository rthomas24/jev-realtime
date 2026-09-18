import type { Quote } from '@shared/ipc'

/**
 * A symbol's tape as a live stream delivers it: every print and every quote
 * of the last few minutes, kept in a bounded window, read back as the facts a
 * one-second decision needs — the last price and its age, the touch and its
 * width, how the price moved over the last 10 s / 60 s / 5 min, who is
 * hitting the book (prints at the ask vs at the bid), and the last few
 * prints in order. Pure and vendor-free: the stream module feeds it, the
 * tick reads it, the situation describes it.
 */
export interface TapeTrade {
  /** Epoch ms. */
  t: number
  p: number
  s: number
}

export interface TapeQuote {
  t: number
  bid: number
  ask: number
  bidSize: number
  askSize: number
}

export interface TapeSnapshot {
  symbol: string
  last: number
  lastTradeAt: number
  bid: number | null
  ask: number | null
  bidSize: number | null
  askSize: number | null
  /** (ask − bid) / last, in percent; null without a two-sided quote. */
  spreadPct: number | null
  /** % change of the last print against the print nearest that long ago; null when the window has no print that old. */
  returns: { s10: number | null; s60: number | null; m5: number | null }
  /** Prints in the last 60 s classified by aggressor: at/above the ask = buyer, at/below the bid = seller. */
  flow60: { buyShares: number; sellShares: number; prints: number }
  printsPerMinute: number
  /** The last few prints, oldest first. */
  recent: number[]
  /** The instant of the newest trade or quote. */
  updatedAt: number
}

const WINDOW_MS = 5 * 60_000
const MAX_TRADES = 3000
const RECENT_N = 12

export class SymbolTape {
  private trades: TapeTrade[] = []
  /** The newest print, kept past the window so a quiet symbol still has a last price. */
  private lastTrade: TapeTrade | null = null
  private quote: TapeQuote | null = null
  /** Buyer/seller shares per trade, decided against the quote in force when it printed. */
  private sides: ('buy' | 'sell' | null)[] = []

  constructor(readonly symbol: string) {}

  trade(t: TapeTrade): void {
    if (!(t.p > 0) || !(t.s >= 0)) return
    this.lastTrade = t
    this.trades.push(t)
    const q = this.quote
    this.sides.push(q && q.ask > 0 && t.p >= q.ask ? 'buy' : q && q.bid > 0 && t.p <= q.bid ? 'sell' : null)
    if (this.trades.length > MAX_TRADES) {
      const drop = this.trades.length - MAX_TRADES
      this.trades.splice(0, drop)
      this.sides.splice(0, drop)
    }
  }

  setQuote(q: TapeQuote): void {
    if (!(q.bid > 0) && !(q.ask > 0)) return
    this.quote = q
  }

  get hasTrades(): boolean {
    return this.trades.length > 0
  }

  snapshot(now: number): TapeSnapshot | null {
    // Drop what is older than the window (from the front; the list is time-ordered).
    const cutoff = now - WINDOW_MS
    let drop = 0
    while (drop < this.trades.length && this.trades[drop].t < cutoff) drop++
    if (drop) {
      this.trades.splice(0, drop)
      this.sides.splice(0, drop)
    }
    const last = this.lastTrade
    const q = this.quote
    if (!last && !q) return null
    const lastPx = last?.p ?? (q && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : (q?.bid || q?.ask) ?? 0)
    if (!(lastPx > 0)) return null
    const ret = (ms: number): number | null => {
      const target = now - ms
      // The newest print at or before `target`; null when nothing that old is in the window.
      let ref: TapeTrade | null = null
      for (let i = this.trades.length - 1; i >= 0; i--) {
        if (this.trades[i].t <= target) {
          ref = this.trades[i]
          break
        }
      }
      return ref && last ? ((last.p - ref.p) / ref.p) * 100 : null
    }
    let buyShares = 0
    let sellShares = 0
    let prints = 0
    const since60 = now - 60_000
    for (let i = this.trades.length - 1; i >= 0 && this.trades[i].t >= since60; i--) {
      prints++
      const side = this.sides[i]
      if (side === 'buy') buyShares += this.trades[i].s
      else if (side === 'sell') sellShares += this.trades[i].s
    }
    const spanMs = this.trades.length >= 2 ? Math.max(1_000, now - this.trades[0].t) : 60_000
    return {
      symbol: this.symbol,
      last: lastPx,
      lastTradeAt: last?.t ?? q!.t,
      bid: q && q.bid > 0 ? q.bid : null,
      ask: q && q.ask > 0 ? q.ask : null,
      bidSize: q ? q.bidSize : null,
      askSize: q ? q.askSize : null,
      spreadPct: q && q.bid > 0 && q.ask > q.bid ? ((q.ask - q.bid) / lastPx) * 100 : null,
      returns: { s10: ret(10_000), s60: ret(60_000), m5: ret(WINDOW_MS - 1) },
      flow60: { buyShares, sellShares, prints },
      printsPerMinute: Math.round((this.trades.length / spanMs) * 60_000),
      recent: this.trades.slice(-RECENT_N).map((x) => x.p),
      updatedAt: Math.max(last?.t ?? 0, q?.t ?? 0)
    }
  }
}

/** The tape as the quote shape every other consumer takes. */
export function tapeQuote(s: TapeSnapshot): Quote {
  return { symbol: s.symbol, last: s.last, bid: s.bid ?? undefined, ask: s.ask ?? undefined, ts: new Date(s.updatedAt).toISOString() }
}
