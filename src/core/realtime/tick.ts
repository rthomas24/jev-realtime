import type { Quote } from '@shared/ipc'
import type { Fill, Ledger } from '@shared/ledger'
import { fillEconomics as fillEconomicsRaw, money, newId } from '@shared/ledger'
import { settlesOn } from '@shared/settlement'
import { etClock, isRegularSession, sessionLabel } from '@shared/marketTime'
import { isContinuousMarket, REALTIME_RECENT_TICKS, realtimeEquity, type RealtimeAction, type RealtimeConfig, type RealtimeDecision, type RealtimeState, type RealtimeTick, type RealtimeVerdict } from '@shared/realtimeAgents'
import { redactSecrets } from '../redact'
import type { Bar } from '../market/feed'
import type { TapeSnapshot } from '../market/tape'
import { submitPaperOrder, toPaperQuotes, type PaperQuote } from '../broker/paper'
import { analyzeSymbol } from '../market/indicators'
import { lastSessionBars } from '../market/feed'
import type { Decider } from './jev'
import { dayLossLocked, entriesClosed, entryBlocked, entrySize, exitTrigger, newExit, ratchetHigh, verdictIntent } from './policy'
import { buildSituation, type Asked, type SymbolInputs } from './situation'

/**
 * One real-time tick, host-neutral: quotes and bars in, a new state and a
 * tick record out. The order of operations is the safety argument —
 *
 *   1. mark the book and roll the day anchor;
 *   2. enforce the engine's exits (stop / trail / target / flatten) in code,
 *      BEFORE any model is consulted — a stop is not a suggestion;
 *   3. set the daily-loss buy lock from the marked equity;
 *   4. skip the model when nothing moved (a quiet tick costs nothing);
 *   5. ask the model ONE question set over every symbol that can still act;
 *   6. read each verdict through the thresholds and the entry rules, and
 *      book paper fills through the same `submitPaperOrder` the thread agents use.
 *
 * Every decision is recorded, including the refusals, so the page can say why
 * a tick did nothing — the question the thread agents' decision log answers.
 */

export interface TickInputs {
  cfg: RealtimeConfig
  state: RealtimeState
  now: Date
  quotes: Quote[]
  /** Symbols the feed could not price this tick. */
  failed: string[]
  /** 5-minute bars per symbol (the last few sessions; today's are picked out here). */
  intraBars: Record<string, Bar[]>
  /** Daily bars per symbol, for the daily trend / RSI / typical range. */
  dayBars: Record<string, Bar[]>
  /** Live tape snapshots per symbol, when a stream is on (absent = polled quotes only). */
  tapes?: Record<string, TapeSnapshot>
  /** Null when no TypeSafe key is stored. */
  decider: Decider | null
  /** Budget for the model round trip. */
  modelTimeoutMs: number
  /** Overrides the clock's session check (the test stream prints around the clock). Default: the regular session, or always for a continuous market (crypto). */
  sessionOpen?: boolean
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface TickResult {
  state: RealtimeState
  tick: RealtimeTick
}

const r2 = (n: number): number => Math.round(n * 100) / 100

export async function runRealtimeTick(i: TickInputs): Promise<TickResult> {
  const { cfg, now } = i
  const g = cfg.guardrails
  // A continuous market (crypto): no session, no flatten, no entry window,
  // instant settlement. Every rule below reads this one flag.
  const continuous = isContinuousMarket(cfg.assetClass)
  const fillEconomics = (before: Ledger, after: Ledger, fill: Fill) => fillEconomicsRaw(before, after, fill, continuous ? undefined : settlesOn)
  const clock = etClock(now)
  const nowIso = now.toISOString()
  const log = i.log ?? (() => undefined)
  let state: RealtimeState = { ...i.state, exits: { ...i.state.exits }, lastSellAt: { ...i.state.lastSellAt }, lastQuotes: { ...i.state.lastQuotes } }
  let ledger: Ledger = state.ledger
  const decisions: RealtimeDecision[] = []
  const tick: RealtimeTick = { id: newId('rt_'), at: nowIso, session: continuous ? 'open' : sessionLabel(now), decisions, equity: 0, unrealized: 0 }
  const finish = (): TickResult => {
    const marked = realtimeEquity({ ledger, lastQuotes: state.lastQuotes })
    tick.equity = marked.equity
    tick.unrealized = marked.unrealized
    state = { ...state, ledger, lastTickAt: nowIso, recent: [...state.recent, tick].slice(-REALTIME_RECENT_TICKS) }
    return { state, tick }
  }

  // 0. Prices. A symbol without one gets no decision this tick, and the tick
  //    says so — silence would read as "the model chose to hold".
  const quoteMap = new Map(i.quotes.map((q) => [q.symbol, q]))
  const prevQuotes = { ...state.lastQuotes }
  const prevAt = state.lastTickAt ? Date.parse(state.lastTickAt) : null
  for (const q of i.quotes) if (q.last > 0) state.lastQuotes[q.symbol] = q.last
  for (const s of cfg.symbols) if (!quoteMap.get(s) || !(quoteMap.get(s)!.last > 0)) decisions.push({ symbol: s, price: null, intent: 'none', outcome: 'blocked', rule: 'feed.unpriced', detail: i.failed.includes(s) ? 'The feed could not price it this tick.' : 'No quote returned.' })
  const priced = cfg.symbols.filter((s) => (quoteMap.get(s)?.last ?? 0) > 0)
  const paperQuotes: Record<string, PaperQuote> = toPaperQuotes(i.quotes.filter((q) => q.last > 0))

  // 1. The day anchor: the first marked equity of each ET day.
  if (state.dayDate !== clock.date) {
    const { equity } = realtimeEquity({ ledger, lastQuotes: state.lastQuotes })
    state = { ...state, dayDate: clock.date, dayStartEquity: equity, buyLocked: false, ticksToday: 0 }
  }
  state.ticksToday += 1

  if (!(i.sessionOpen ?? (continuous || isRegularSession(now)))) {
    tick.skipped = 'Outside the regular session.'
    for (const s of priced) decisions.push({ symbol: s, price: quoteMap.get(s)!.last, intent: 'none', outcome: 'held', rule: 'session.closed', detail: 'Decisions are made during the regular session only.' })
    return finish()
  }

  // 2. Engine exits first. Trails ratchet from the high, and a level that is
  //    hit sells at market through the paper broker — no model in the loop.
  const book = (side: 'buy' | 'sell', symbol: string, qty: number): { fill: Fill; before: Ledger } | null => {
    const q = paperQuotes[symbol]
    if (!q) return null
    const before = ledger
    const r = submitPaperOrder(ledger, { symbol, side, qty, type: 'market', tif: 'day' }, q, { settlement: continuous ? 'instant' : 'tplus1' })
    if (!r.fill) return null
    ledger = r.ledger
    return { fill: r.fill, before }
  }
  const exited = new Set<string>()
  for (const p of ledger.positions) {
    const last = quoteMap.get(p.symbol)?.last
    const exit = state.exits[p.symbol]
    if (!last || !exit) continue
    const ratcheted = ratchetHigh(exit, last)
    state.exits[p.symbol] = ratcheted
    const hit = exitTrigger(ratcheted, last, g, clock, continuous)
    if (!hit) continue
    const r = book('sell', p.symbol, p.qty)
    if (!r) continue
    delete state.exits[p.symbol]
    state.lastSellAt[p.symbol] = nowIso
    exited.add(p.symbol)
    decisions.push({ symbol: p.symbol, price: last, intent: 'exit', outcome: 'filled', rule: hit.rule, detail: hit.detail, fill: r.fill, econ: fillEconomics(r.before, ledger, r.fill) })
  }

  // 3. The day-loss lock, on the book as it stands after the exits.
  const marked = realtimeEquity({ ledger, lastQuotes: state.lastQuotes })
  if (!state.buyLocked && dayLossLocked(g, cfg.allocation, state.dayStartEquity, marked.equity)) {
    state.buyLocked = true
    log('info', `${cfg.name}: buys locked for ${clock.date} — day P&L ${money(marked.equity - (state.dayStartEquity ?? marked.equity))}`)
  }

  // 4. Who still needs a decision. Flat symbols only while entries are open;
  //    the refusal is recorded per symbol so the tape explains the silence.
  const closed = entriesClosed(g, state, clock, continuous)
  const held = new Set(ledger.positions.map((p) => p.symbol))
  const candidates: string[] = []
  for (const s of priced) {
    if (exited.has(s)) continue
    if (held.has(s)) {
      candidates.push(s)
      continue
    }
    if (closed) {
      decisions.push({ symbol: s, price: quoteMap.get(s)!.last, intent: 'none', outcome: 'held', rule: closed.rule, detail: closed.detail })
      continue
    }
    candidates.push(s)
  }
  if (!candidates.length) {
    if (!decisions.some((d) => d.fill)) tick.skipped = closed ? closed.detail : 'Nothing to decide.'
    return finish()
  }

  // A quiet tick: every candidate's price is exactly where it was last time.
  // Same prices, same situation, same answer — the model is not asked.
  const moved = candidates.some((s) => prevQuotes[s] === undefined || prevQuotes[s] !== quoteMap.get(s)!.last)
  if (!moved) {
    for (const s of candidates) decisions.push({ symbol: s, price: quoteMap.get(s)!.last, intent: 'none', outcome: 'quiet', rule: 'quiet', detail: 'Unchanged since the last check.' })
    tick.skipped = 'No price changed since the last check.'
    return finish()
  }

  if (!i.decider) {
    for (const s of candidates) decisions.push({ symbol: s, price: quoteMap.get(s)!.last, intent: 'none', outcome: 'blocked', rule: 'jev.noKey', detail: 'Add a TypeSafe API key on the Real time page to let the model decide.' })
    tick.skipped = 'No TypeSafe key.'
    return finish()
  }

  // 5. One request over every candidate.
  const inputs: SymbolInputs[] = candidates.map((s) => {
    const q = quoteMap.get(s)!
    const intraAll = i.intraBars[s] ?? []
    const intraLast = lastSessionBars(intraAll)
    const intra = intraLast.length && etClock(new Date(intraLast[intraLast.length - 1].t * 1000)).date === clock.date ? intraLast : []
    const day = i.dayBars[s] ?? []
    const analysis = day.length || intra.length ? analyzeSymbol(s, day, intra, q.prevClose, { continuous }) : null
    const pos = ledger.positions.find((p) => p.symbol === s) ?? null
    return {
      symbol: s,
      quote: q,
      analysis,
      intraBars: intra,
      tape: i.tapes?.[s] ?? null,
      prevLast: prevQuotes[s],
      secondsSincePrev: prevAt !== null ? (now.getTime() - prevAt) / 1000 : undefined,
      position: pos,
      exit: state.exits[s] ?? null
    }
  })
  const situation = buildSituation(cfg, inputs, clock, now.getTime(), closed === null)
  const t0 = Date.now()
  let verdicts: Record<string, RealtimeVerdict> = {}
  try {
    const r = await i.decider.decide(situation.state, situation.questions, { timeoutMs: i.modelTimeoutMs })
    tick.latencyMs = Date.now() - t0
    tick.usage = r.usage
    state = { ...state, modelCalls: state.modelCalls + 1, inputTokens: state.inputTokens + r.usage.input, outputTokens: state.outputTokens + r.usage.output, lastError: null }
    verdicts = readVerdicts(r.answers as Record<string, unknown>, situation.asked)
  } catch (e) {
    tick.latencyMs = Date.now() - t0
    const msg = redactSecrets((e as Error)?.message ?? String(e)).slice(0, 300)
    tick.error = msg
    state = { ...state, lastError: msg }
    log('warn', `${cfg.name}: model call failed — ${msg}`)
    for (const s of candidates) decisions.push({ symbol: s, price: quoteMap.get(s)!.last, intent: 'none', outcome: 'error', rule: 'jev.error', detail: msg })
    return finish()
  }

  // 6. Verdicts through the thresholds and the rules, then the book.
  for (const s of candidates) {
    const last = quoteMap.get(s)!.last
    const v = verdicts[s]
    if (!v) {
      decisions.push({ symbol: s, price: last, intent: 'none', outcome: 'error', rule: 'jev.error', detail: 'The model returned no answer for this symbol.' })
      continue
    }
    const holding = held.has(s)
    const read = verdictIntent(v, holding, g)
    if (read.intent === 'hold') {
      decisions.push({ symbol: s, price: last, verdict: v, intent: 'hold', outcome: 'held', rule: read.rule, detail: read.detail })
      continue
    }
    if (read.intent === 'sell') {
      const pos = ledger.positions.find((p) => p.symbol === s)
      const r = pos ? book('sell', s, pos.qty) : null
      if (!r) {
        decisions.push({ symbol: s, price: last, verdict: v, intent: 'sell', outcome: 'error', rule: 'jev.error', detail: 'The sell could not be booked.' })
        continue
      }
      delete state.exits[s]
      state.lastSellAt[s] = nowIso
      decisions.push({ symbol: s, price: last, verdict: v, intent: 'sell', outcome: 'filled', rule: read.rule, detail: read.detail, fill: r.fill, econ: fillEconomics(r.before, ledger, r.fill) })
      continue
    }
    // buy
    const analysis = inputs.find((x) => x.symbol === s)?.analysis ?? null
    const blocked = entryBlocked(s, g, state, last, analysis?.vwap ?? null, now)
    if (blocked) {
      decisions.push({ symbol: s, price: last, verdict: v, intent: 'buy', outcome: 'blocked', rule: blocked.rule, detail: `${read.detail} ${blocked.detail}` })
      continue
    }
    const size = entrySize(g, cfg.allocation, ledger, clock.date, paperQuotes[s].ask && paperQuotes[s].ask! > 0 ? paperQuotes[s].ask! : last, continuous)
    if ('rule' in size) {
      decisions.push({ symbol: s, price: last, verdict: v, intent: 'buy', outcome: 'blocked', rule: size.rule, detail: `${read.detail} ${size.detail}` })
      continue
    }
    const r = book('buy', s, size.qty)
    if (!r) {
      decisions.push({ symbol: s, price: last, verdict: v, intent: 'buy', outcome: 'error', rule: 'jev.error', detail: 'The buy could not be booked.' })
      continue
    }
    state.exits[s] = newExit(r.fill.price, g, nowIso)
    decisions.push({ symbol: s, price: last, verdict: v, intent: 'buy', outcome: 'filled', rule: read.rule, detail: `${read.detail} ${money(size.notional)} — stop ${money(state.exits[s].stop)}, target ${money(state.exits[s].target)}.`, fill: r.fill, econ: fillEconomics(r.before, ledger, r.fill) })
  }
  return finish()
}

/**
 * Read the model's answers back by the ids the situation handed out — never
 * by parsing a key. The direction choice (`up` / `down` / `flat`) is stored
 * as buy / sell / hold; the other judgments ride beside it.
 */
export function readVerdicts(answers: Record<string, unknown>, asked: Asked): Record<string, RealtimeVerdict> {
  const out: Record<string, RealtimeVerdict> = {}
  const noul = (key: string | undefined): number | undefined => {
    if (!key) return undefined
    const n = answers[key] as { type?: string; noul?: number } | undefined
    return n && n.type === 'noul' && typeof n.noul === 'number' ? r2(n.noul) : undefined
  }
  for (const [symbol, q] of Object.entries(asked)) {
    const a = answers[q.direction] as { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined
    if (!a || a.type !== 'choice' || !a.choice) continue
    const pr = a.probabilities ?? {}
    const probabilities: Partial<Record<RealtimeAction, number>> = { buy: r2(Number(pr.up ?? 0)), sell: r2(Number(pr.down ?? 0)), hold: r2(Number(pr.flat ?? 0)) }
    const action: RealtimeAction = a.choice === 'up' ? 'buy' : a.choice === 'down' ? 'sell' : 'hold'
    const v: RealtimeVerdict = { action, probabilities, confidence: r2(Number(a.confidence ?? 0)) }
    const ext = noul(q.extended)
    if (ext !== undefined) v.extended = ext
    const rev = noul(q.reversal)
    if (rev !== undefined) v.reversal = rev
    const intact = noul(q.intact)
    if (intact !== undefined) v.trendIntact = intact
    if (q.setup) {
      const s = answers[q.setup] as { type?: string; score?: number } | undefined
      if (s && s.type === 'score' && typeof s.score === 'number') v.setup = r2(s.score)
    }
    out[symbol] = v
  }
  return out
}
