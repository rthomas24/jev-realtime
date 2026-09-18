import { newId, type Fill, type Ledger, type PaperOrder, type Position } from '@shared/ledger'
import { etClock } from '@shared/marketTime'
import { settlesOn, type UnsettledLot } from '@shared/settlement'

/**
 * Paper ledger: simulated fills marked with real Robinhood quotes. Pure functions
 * returning a NEW ledger (never mutate the input) so callers can persist atomically.
 */
const DEFAULT_SLIPPAGE_BPS = 2

export interface PaperQuote {
  last: number
  bid?: number
  ask?: number
}

function applySlippage(price: number, side: 'buy' | 'sell', bps = DEFAULT_SLIPPAGE_BPS): number {
  const k = bps / 10_000
  return side === 'buy' ? price * (1 + k) : price * (1 - k)
}

export function execPrice(q: PaperQuote, side: 'buy' | 'sell'): number {
  const base = side === 'buy' ? (q.ask && q.ask > 0 ? q.ask : q.last) : q.bid && q.bid > 0 ? q.bid : q.last
  return applySlippage(base, side)
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** How a fill's proceeds settle: `tplus1` (US equities, the default) or `instant` (crypto — spendable at once). */
export interface FillOptions {
  settlement?: 'tplus1' | 'instant'
}

/** Apply a fill to the ledger (cash, position, realized P&L). */
export function applyFill(ledger: Ledger, fill: Omit<Fill, 'id' | 'realized' | 'ts'> & { ts?: string }, opts: FillOptions = {}): { ledger: Ledger; fill: Fill } {
  const positions: Position[] = ledger.positions.map((p) => ({ ...p }))
  const idx = positions.findIndex((p) => p.symbol === fill.symbol)
  let realized = 0
  let cash = ledger.cash
  const ts = fill.ts ?? new Date().toISOString()
  // Settlement (T+1). Lots that have matured by THIS fill's trade date are
  // dropped — the ledger cleans itself on every fill, so no host has to sweep
  // it — and a sell appends its proceeds as a new lot. Tracking is
  // unconditional; whether it binds a buy is `settlementModeFor`.
  const today = etClock(new Date(ts)).date
  const unsettled: UnsettledLot[] = (ledger.unsettled ?? []).filter((l) => l.settlesOn > today)
  const proceeds = fill.side === 'sell' ? round(fill.qty * fill.price, 2) : 0
  // Cash moves in CENTS, rounded per delta, so the book's invariant holds
  // exactly: a flat book's cash equals allocation + realizedPnl. Rounding the
  // running total instead (the old way: exact products in, one round out) let
  // each fill contribute up to half a cent of drift, and flat books settled a
  // penny or two off their own realized total — a small number that reads as a
  // big question ("where did 2 cents go?") in a file whose whole job is being
  // the truth about money. avgCost stays unrounded: it is a rate, not a
  // balance, and rounding it would move every later realized figure.
  if (fill.side === 'buy') {
    cash -= round(fill.qty * fill.price, 2)
    if (idx >= 0) {
      const p = positions[idx]
      const totalCost = p.avgCost * p.qty + fill.price * fill.qty
      p.qty = round(p.qty + fill.qty, 6)
      p.avgCost = totalCost / p.qty
    } else {
      positions.push({ symbol: fill.symbol, qty: round(fill.qty, 6), avgCost: fill.price })
    }
  } else {
    cash += proceeds
    if (idx >= 0) {
      const p = positions[idx]
      const closeQty = Math.min(p.qty, fill.qty)
      // Realized is the difference of the SAME cents cash moved by — rounded
      // proceeds minus rounded basis — not a rounding of the exact difference.
      // round(a) − round(b) and round(a − b) disagree by a cent often enough
      // that the old form left flat books a penny off their own realized
      // total. Full closes are now exact; a partial close can still carry a
      // sub-cent residual (its basis is rounded per slice), which is the
      // irreducible cost of keeping avgCost an unrounded rate.
      // Re-rounded: subtracting two cents-values still leaves float dust
      // (1426.38 − 1454.54 = −28.159999999999854), and this field is consumed
      // raw by cards, run books and the phone.
      realized = round(round(closeQty * fill.price, 2) - round(closeQty * p.avgCost, 2), 2)
      p.qty = round(p.qty - closeQty, 6)
      if (p.qty <= 1e-9) positions.splice(idx, 1)
    }
  }
  const done: Fill = {
    id: newId('fill_'),
    ts,
    symbol: fill.symbol,
    side: fill.side,
    qty: fill.qty,
    price: fill.price,
    // Already cents — rounded where it was computed, so the fill, the running
    // total, and cash all carry the same number.
    realized,
    orderId: fill.orderId
  }
  // Instant settlement (crypto) books no lot: the proceeds are spendable now.
  if (fill.side === 'sell' && opts.settlement !== 'instant') unsettled.push({ amount: proceeds, ts, settlesOn: settlesOn(ts), fillId: done.id })
  return {
    ledger: {
      ...ledger,
      cash: round(cash, 2),
      positions,
      fills: [...ledger.fills, done].slice(-500),
      realizedPnl: round(ledger.realizedPnl + realized, 2),
      unsettled
    },
    fill: done
  }
}

/** Index quotes by symbol in the shape the paper engine consumes. */
export function toPaperQuotes(quotes: Array<{ symbol: string; last: number; bid?: number; ask?: number }>): Record<string, PaperQuote> {
  return Object.fromEntries(quotes.map((q) => [q.symbol, { last: q.last, bid: q.bid, ask: q.ask }]))
}

export interface PaperSubmit {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  type: 'market' | 'limit'
  limitPrice?: number
  /** Honoured by the settle sweep: 'day' orders expire on a later ET date. Default 'day'. */
  tif?: 'day' | 'gtc'
  /** Exits to arm when this order fills — carried through a rest, not dropped. */
  stopLoss?: number
  takeProfit?: number
  trailPct?: number
}

export interface PaperSubmitResult {
  ledger: Ledger
  order: PaperOrder
  fill?: Fill
}

/** Submit a paper order: market fills now; limit fills if marketable else rests as open. */
export function submitPaperOrder(ledger: Ledger, o: PaperSubmit, quote: PaperQuote, opts: FillOptions = {}): PaperSubmitResult {
  const order: PaperOrder = {
    id: newId('po_'),
    ts: new Date().toISOString(),
    symbol: o.symbol,
    side: o.side,
    qty: o.qty,
    type: o.type,
    limitPrice: o.limitPrice,
    tif: o.tif,
    stopLoss: o.stopLoss,
    takeProfit: o.takeProfit,
    trailPct: o.trailPct,
    status: 'open'
  }
  const px = execPrice(quote, o.side)
  const marketable =
    o.type === 'market' ||
    (o.limitPrice !== undefined && (o.side === 'buy' ? px <= o.limitPrice : px >= o.limitPrice))
  if (marketable) {
    const fillPx = o.type === 'limit' && o.limitPrice !== undefined ? (o.side === 'buy' ? Math.min(px, o.limitPrice) : Math.max(px, o.limitPrice)) : px
    const { ledger: next, fill } = applyFill(ledger, { symbol: o.symbol, side: o.side, qty: o.qty, price: round(fillPx, 4), orderId: order.id }, opts)
    order.status = 'filled'
    return { ledger: next, order, fill }
  }
  return { ledger: { ...ledger, openOrders: [...ledger.openOrders, order] }, order }
}

/** Re-check resting limit orders against fresh quotes. Returns fills produced. */
/** A settled order and the price it actually filled at — what a trail seeds from. */
export type SettledOrder = PaperOrder & { fillPrice: number }

/**
 * `settled` names the orders that produced the fills, in the same order. The
 * caller needs it to arm exits that were carried on a resting order: a `Fill`
 * alone cannot say which order it came from, and therefore cannot say what
 * protection was promised when it was placed.
 */
export function settlePaperOpenOrders(
  ledger: Ledger,
  quotes: Record<string, PaperQuote>,
  now: Date = new Date()
): { ledger: Ledger; fills: Fill[]; settled: SettledOrder[]; dropped: PaperOrder[] } {
  let next = ledger
  const fills: Fill[] = []
  const settled: SettledOrder[] = []
  const remaining: PaperOrder[] = []
  const dropped: PaperOrder[] = []
  const today = etClock(now).date
  for (const o of ledger.openOrders) {
    // An order that can NEVER fill is not "resting", it is debris — a limit
    // with no positive price fails the marketable test forever. Guardrails now
    // refuse these at placement (`limit.missingPrice`); this clears any that
    // predate that, with the caller posting a note so the model stops believing
    // it holds a working order.
    if (o.type === 'limit' && !(o.limitPrice && o.limitPrice > 0)) {
      dropped.push({ ...o, status: 'cancelled' })
      continue
    }
    // 'day' means day. Every card printed the TIF and the ledger ignored it, so
    // day orders rested forever. Absent tif reads as 'day' — that is what every
    // pre-existing card said. Expired on a later ET DATE rather than at the
    // bell, so an after-hours placement still gets its next session.
    if ((o.tif ?? 'day') === 'day' && etClock(new Date(o.ts)).date < today) {
      dropped.push({ ...o, status: 'cancelled' })
      continue
    }
    const q = quotes[o.symbol]
    if (!q || o.limitPrice === undefined) {
      remaining.push(o)
      continue
    }
    const px = execPrice(q, o.side)
    const ok = o.side === 'buy' ? px <= o.limitPrice : px >= o.limitPrice
    if (!ok) {
      remaining.push(o)
      continue
    }
    // Fill at the price you would actually get, not at the limit. A resting buy
    // at $350 on a stock that gapped to $340 books at $340; booking it at $350
    // understated the book, and — worse — made the same order fill at two
    // different prices depending only on whether it happened to be marketable
    // when it was submitted. `submitPaperOrder` has always done it this way;
    // this is the resting path catching up with it.
    const fillPx = o.side === 'buy' ? Math.min(px, o.limitPrice) : Math.max(px, o.limitPrice)
    const r = applyFill(next, { symbol: o.symbol, side: o.side, qty: o.qty, price: round(fillPx, 4), orderId: o.id })
    next = r.ledger
    fills.push(r.fill)
    settled.push({ ...o, status: 'filled', fillPrice: round(fillPx, 4) })
  }
  return { ledger: { ...next, openOrders: remaining }, fills, settled, dropped }
}

export function cancelPaperOrder(ledger: Ledger, orderId: string): { ledger: Ledger; cancelled: boolean } {
  const has = ledger.openOrders.some((o) => o.id === orderId)
  if (!has) return { ledger, cancelled: false }
  return { ledger: { ...ledger, openOrders: ledger.openOrders.filter((o) => o.id !== orderId) }, cancelled: true }
}

export function markToMarket(ledger: Ledger, quotes: Record<string, PaperQuote>): { equity: number; unrealized: number } {
  let mv = 0
  let unrealized = 0
  for (const p of ledger.positions) {
    const px = quotes[p.symbol]?.last ?? p.avgCost
    mv += p.qty * px
    unrealized += (px - p.avgCost) * p.qty
  }
  return { equity: round(ledger.cash + mv, 2), unrealized: round(unrealized, 2) }
}
