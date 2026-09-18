/**
 * The paper book — the same shapes and the same arithmetic HarborBots keeps
 * for its thread agents (`applyFill` in `core/broker/paper.ts` moves cash in
 * cents per delta so a flat book's cash equals allocation + realized exactly).
 * Only the pieces the real-time engine reads live here.
 */
import type { UnsettledLot } from './settlement'

export interface Position {
  symbol: string
  qty: number
  avgCost: number
}

export interface Fill {
  id: string
  ts: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  /** Realized P&L for sells (0 for buys). */
  realized: number
  orderId?: string
}

/** Exits a resting order would arm when it fills. Carried, never read, by the paper broker. */
export interface ExitSpec {
  stopLoss?: number
  takeProfit?: number
  trailPct?: number
}

export interface PaperOrder extends ExitSpec {
  id: string
  ts: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  type: 'market' | 'limit'
  limitPrice?: number
  tif?: 'day' | 'gtc'
  status: 'open' | 'filled' | 'cancelled'
}

export interface Ledger {
  cash: number
  positions: Position[]
  fills: Fill[]
  openOrders: PaperOrder[]
  realizedPnl: number
  /** Sale proceeds inside `cash` that have not settled yet (T+1). */
  unsettled?: UnsettledLot[]
}

export function emptyLedger(cash: number): Ledger {
  return { cash, positions: [], fills: [], openOrders: [], realizedPnl: 0 }
}

/** USD formatter shared by the engine's sentences and the UI. */
export function money(n: number | undefined | null, dp = 2): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '\u2014'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

export function newId(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${prefix}${Date.now().toString(36)}${rnd}`
}

export interface FillEconomics {
  /** Cash moved: shares × price. */
  notional: number
  /** Sells: profit or loss on the shares closed. */
  realized?: number
  /** Sells: the average cost those shares were closed against. */
  costBasis?: number
  /** Sells: `realized` as a percentage of the cost closed. */
  realizedPct?: number
  /** Shares held in this symbol AFTER the fill. */
  positionQty: number
  positionAvgCost: number
  /** The book's total realized P&L after this fill. */
  bookRealized: number
  /** Sells: the ET date the proceeds settle (T+1). */
  settlesOn?: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Build the card's economics from the ledger either side of a fill. Pure. */
export function fillEconomics(before: Ledger, after: Ledger, fill: Fill, settlesOn?: (ts: string) => string): FillEconomics {
  const pos = after.positions.find((p) => p.symbol === fill.symbol)
  const prior = before.positions.find((p) => p.symbol === fill.symbol)
  const econ: FillEconomics = {
    notional: round2(fill.qty * fill.price),
    positionQty: pos?.qty ?? 0,
    positionAvgCost: pos?.avgCost ?? 0,
    bookRealized: after.realizedPnl
  }
  if (fill.side === 'sell') {
    econ.realized = fill.realized
    if (settlesOn) econ.settlesOn = settlesOn(fill.ts)
    const basis = prior?.avgCost ?? 0
    if (basis > 0) {
      econ.costBasis = basis
      econ.realizedPct = round2((fill.realized / (basis * fill.qty)) * 100)
    }
  }
  return econ
}
