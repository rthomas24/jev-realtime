import type { Ledger } from '@shared/ledger'
import { money } from '@shared/ledger'
import { parseHHMM, sessionCloseMinutes, type EtClock } from '@shared/marketTime'
import { REALTIME_MIN_ORDER_USD, type RealtimeAction, type RealtimeExit, type RealtimeGuardrails, type RealtimeRule, type RealtimeState, type RealtimeVerdict } from '@shared/realtimeAgents'
import { settledCash } from '@shared/settlement'

/**
 * The code-owned half of every decision. The model says buy / sell / hold with
 * a probability; these rules decide whether that verdict may become an order,
 * how big, and which exits the engine will enforce on it regardless of what
 * the model says next. Pure, so `check-realtime-tick.ts` can pin each one.
 */

export interface Refusal {
  rule: RealtimeRule
  detail: string
}

/** The stop the engine enforces: the hard stop, or the trail from the high — whichever is higher. */
export function effectiveStop(exit: RealtimeExit, g: RealtimeGuardrails): number {
  const trail = g.trailPct !== null ? exit.high * (1 - g.trailPct / 100) : 0
  return Math.max(exit.stop, trail)
}

/** The minute every position is closed: the plan's `flattenAt`, or five minutes before an early close, whichever is first. */
export function flattenMinute(g: RealtimeGuardrails, date: string): number {
  const planned = parseHHMM(g.flattenAt) ?? 15 * 60 + 55
  return Math.min(planned, sessionCloseMinutes(date) - 5)
}

/**
 * Which engine exit fires at this price and minute, if any. Checked BEFORE
 * the model is asked. A `continuous` market (crypto) has no close, so no
 * flatten: only the levels can close it.
 */
export function exitTrigger(exit: RealtimeExit, last: number, g: RealtimeGuardrails, clock: EtClock, continuous = false): Refusal | null {
  if (!continuous && clock.minutes >= flattenMinute(g, clock.date)) return { rule: 'exit.flatten', detail: `Closed at market at the ${g.flattenAt} ET cut-off.` }
  const stop = effectiveStop(exit, g)
  if (last <= stop) {
    const trailing = g.trailPct !== null && stop > exit.stop
    return trailing
      ? { rule: 'exit.trail', detail: `${money(last)} is at or below the trailing stop ${money(stop)} (${g.trailPct}% under the ${money(exit.high)} high).` }
      : { rule: 'exit.stop', detail: `${money(last)} is at or below the stop ${money(stop)} (${g.stopLossPct}% under the ${money(exit.entryPrice)} entry).` }
  }
  if (last >= exit.target) return { rule: 'exit.target', detail: `${money(last)} is at or above the target ${money(exit.target)} (${g.takeProfitPct}% over the entry).` }
  return null
}

/** A fresh exit set for a fill just made. */
export function newExit(fillPrice: number, g: RealtimeGuardrails, nowIso: string): RealtimeExit {
  const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
  return { entryPrice: fillPrice, enteredAt: nowIso, stop: r4(fillPrice * (1 - g.stopLossPct / 100)), target: r4(fillPrice * (1 + g.takeProfitPct / 100)), high: fillPrice }
}

/** The trail ratchets from the high; the high only ever rises. */
export function ratchetHigh(exit: RealtimeExit, last: number): RealtimeExit {
  return last > exit.high ? { ...exit, high: last } : exit
}

/**
 * Whether entries are open AT ALL at this minute for this book — the rules
 * that hold for every symbol. Checked before any flat symbol is described to
 * the model, because a verdict that cannot be acted on is not worth asking for.
 */
export function entriesClosed(g: RealtimeGuardrails, state: Pick<RealtimeState, 'buyLocked'>, clock: EtClock, continuous = false): Refusal | null {
  // A continuous market has no entry window and no flatten; the day-loss lock still holds (its day is the ET date).
  if (!continuous) {
    const before = parseHHMM(g.noEntriesBeforeEt)
    const after = parseHHMM(g.noEntriesAfterEt)
    if (before !== null && clock.minutes < before) return { rule: 'entry.beforeWindow', detail: `No entries before ${g.noEntriesBeforeEt} ET.` }
    if (after !== null && clock.minutes >= after) return { rule: 'entry.afterWindow', detail: `No entries from ${g.noEntriesAfterEt} ET.` }
    if (clock.minutes >= flattenMinute(g, clock.date)) return { rule: 'entry.afterWindow', detail: `Past the ${g.flattenAt} ET flatten.` }
  }
  if (state.buyLocked) return { rule: 'lock.dailyLoss', detail: `Buys are locked for the day: the book is down more than ${g.maxDailyLossPct}% of its allocation.` }
  return null
}

/**
 * The per-symbol entry rule: extension above VWAP. There is deliberately no
 * cooldown after a sell — a symbol that was just sold is judged on the tape
 * in front of it like any other, and the model's threshold is the only gate.
 */
export function entryBlocked(g: RealtimeGuardrails, last: number, vwap: number | null): Refusal | null {
  if (g.maxEntryExtensionPct !== null && vwap && vwap > 0) {
    const ext = ((last - vwap) / vwap) * 100
    if (ext > g.maxEntryExtensionPct) return { rule: 'entry.extended', detail: `${ext.toFixed(2)}% above VWAP ${money(vwap)}; the limit is ${g.maxEntryExtensionPct}%.` }
  }
  return null
}

/** Shares (or units) to buy: the smaller of the per-symbol cap and the settled cash, or a refusal. With `instantSettlement` (crypto) every dollar of cash is settled. */
export function entrySize(g: RealtimeGuardrails, allocation: number, ledger: Ledger, etDate: string, price: number, instantSettlement = false): { qty: number; notional: number } | Refusal {
  const settled = instantSettlement ? Math.max(0, ledger.cash) : settledCash(ledger, etDate)
  const cap = allocation * (g.maxPositionPct / 100)
  const notional = Math.min(cap, settled)
  if (settled < REALTIME_MIN_ORDER_USD) return { rule: 'cap.cash', detail: `Settled cash is ${money(settled)}${ledger.cash - settled > 0.005 ? ` (${money(ledger.cash - settled)} settles tomorrow)` : ''}.` }
  if (notional < REALTIME_MIN_ORDER_USD) return { rule: 'size.tooSmall', detail: `${money(notional)} is under the ${money(REALTIME_MIN_ORDER_USD)} minimum.` }
  const qty = Math.floor((notional / price) * 1e4) / 1e4
  if (qty <= 0) return { rule: 'size.tooSmall', detail: `${money(notional)} buys no shares at ${money(price)}.` }
  return { qty, notional: Math.round(qty * price * 100) / 100 }
}

/**
 * Whether this tick may skip the model: every candidate has moved less than
 * `askMinMovePct` since the model last saw it, is held (or not) exactly as it
 * was then, and the last ask is younger than `askAtLeastEverySec`. The model
 * answers the same situation the same way, so the last verdict stands and
 * the tokens are kept. The sentence for the row, or null: ask.
 */
export function quietBand(lastAsk: RealtimeState['lastAsk'], candidates: readonly string[], priceOf: (symbol: string) => number, held: ReadonlySet<string>, g: RealtimeGuardrails, now: Date): string | null {
  if (!lastAsk || g.askMinMovePct <= 0) return null
  const ageSec = (now.getTime() - Date.parse(lastAsk.at)) / 1000
  if (!(ageSec >= 0) || ageSec >= g.askAtLeastEverySec) return null
  let biggest = 0
  for (const s of candidates) {
    const then = lastAsk.prices[s]
    if (then === undefined || !(then > 0)) return null
    if (held.has(s) !== lastAsk.held.includes(s)) return null
    const move = Math.abs((priceOf(s) - then) / then) * 100
    if (move >= g.askMinMovePct) return null
    biggest = Math.max(biggest, move)
  }
  return `Moved ${biggest.toFixed(3)}% since the model was asked ${ageSec < 1.5 ? 'a second' : `${Math.round(ageSec)} s`} ago — inside the ${g.askMinMovePct}% band, so the last verdict stands (re-asked at ≥ ${g.askMinMovePct}% or every ${g.askAtLeastEverySec} s).`
}

/** Has the day's loss crossed the lock? Measured on marked equity against the day's opening equity, as % of allocation. */
export function dayLossLocked(g: RealtimeGuardrails, allocation: number, dayStartEquity: number | null, equity: number): boolean {
  if (dayStartEquity === null || allocation <= 0) return false
  return ((equity - dayStartEquity) / allocation) * 100 <= -g.maxDailyLossPct
}

/**
 * Compose the model's atomic judgments into one intent — the "combine
 * outputs in code" half of TypeSafe's guide. The direction question carries
 * the thresholds (`buy` = P(up), `sell` = P(down)); the others veto or
 * override: a flat book needs the price NOT extended and a setup at least
 * `minSetup`; a held one is closed on a reversal, on a trend the model no
 * longer sees intact, or on a down verdict past the threshold.
 */
export function verdictIntent(v: RealtimeVerdict, holding: boolean, g: RealtimeGuardrails): { intent: RealtimeAction; rule: RealtimeRule; detail: string } {
  const p = (a: RealtimeAction): number => v.probabilities[a] ?? 0
  const pctOf = (n: number): string => `${Math.round(n * 100)}%`
  if (holding) {
    if (v.reversal !== undefined && v.reversal >= g.reversalThreshold) return { intent: 'sell', rule: 'jev.reversal', detail: `Reversal ${pctOf(v.reversal)} ≥ ${pctOf(g.reversalThreshold)}.` }
    if (v.trendIntact !== undefined && v.trendIntact <= 1 - g.sellThreshold) return { intent: 'sell', rule: 'jev.trendBroken', detail: `Trend intact only ${pctOf(v.trendIntact)} (≤ ${pctOf(1 - g.sellThreshold)}).` }
    if (p('sell') >= g.sellThreshold) return { intent: 'sell', rule: 'jev.sell', detail: `Down ${pctOf(p('sell'))} ≥ ${pctOf(g.sellThreshold)}.` }
    if (v.action === 'sell') return { intent: 'hold', rule: 'jev.belowThreshold', detail: `Down ${pctOf(p('sell'))} is under the ${pctOf(g.sellThreshold)} threshold — holding.` }
    return { intent: 'hold', rule: 'jev.hold', detail: `Up ${pctOf(p('buy'))} · flat ${pctOf(p('hold'))} · down ${pctOf(p('sell'))}${v.reversal !== undefined ? ` · reversal ${pctOf(v.reversal)}` : ''}${v.trendIntact !== undefined ? ` · intact ${pctOf(v.trendIntact)}` : ''}.` }
  }
  if (p('buy') >= g.buyThreshold) {
    if (v.extended !== undefined && v.extended >= g.maxExtended) return { intent: 'hold', rule: 'jev.extended', detail: `Up ${pctOf(p('buy'))}, but extended ${pctOf(v.extended)} ≥ ${pctOf(g.maxExtended)} — not chasing.` }
    if (v.setup !== undefined && v.setup < g.minSetup) return { intent: 'hold', rule: 'jev.weakSetup', detail: `Up ${pctOf(p('buy'))}, but setup ${v.setup.toFixed(2)} < ${g.minSetup} — waiting for a cleaner one.` }
    return { intent: 'buy', rule: 'jev.buy', detail: `Up ${pctOf(p('buy'))} ≥ ${pctOf(g.buyThreshold)}${v.setup !== undefined ? `, setup ${v.setup.toFixed(2)}` : ''}${v.extended !== undefined ? `, extended ${pctOf(v.extended)}` : ''}.` }
  }
  if (v.action === 'buy') return { intent: 'hold', rule: 'jev.belowThreshold', detail: `Up ${pctOf(p('buy'))} is under the ${pctOf(g.buyThreshold)} threshold — staying flat.` }
  return { intent: 'hold', rule: 'jev.hold', detail: `Up ${pctOf(p('buy'))} · flat ${pctOf(p('hold'))} · down ${pctOf(p('sell'))}.` }
}
