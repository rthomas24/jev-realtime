import type { Quote } from '@shared/ipc'
import type { Position } from '@shared/ledger'
import { money } from '@shared/ledger'
import { isContinuousMarket, type RealtimeConfig, type RealtimeExit } from '@shared/realtimeAgents'
import { formatMinutes, OPEN_MINUTES, sessionCloseMinutes, type EtClock } from '@shared/marketTime'
import type { Bar } from '../market/feed'
import type { TapeSnapshot } from '../market/tape'
import type { SymbolAnalysis } from '../market/indicators'
import type { JevQuestion } from './jev'
import { effectiveStop } from './policy'

/**
 * The situation the model is asked about, and the questions — written the
 * way TypeSafe's build guide asks for:
 *
 *  - STATE is only what the judgment needs, as named fields, every number
 *    computed here and handed over as a described fact ("0.4% above VWAP",
 *    "in the top fifth of today's range", "buyers lifting the offer") — a
 *    System One model reads numbers as text and is weak at comparing them;
 *  - QUESTIONS are ATOMIC: direction over the horizon, then separately
 *    whether the price is extended, how clean the setup is, whether the
 *    position's trend is intact and whether it is reversing — each its own
 *    answer with its own probability, composed in code (`policy.ts`), never
 *    one broad "what should I do?" that hides them;
 *  - every question for every symbol goes in ONE request (fan-out: parallel
 *    evaluation, no latency for the extra questions), speculative ones
 *    included, and code consumes only the applicable answers;
 *  - the model is given what a trader at the desk would have: what it owns,
 *    what the book has done today, how its OWN entries in this symbol have
 *    worked out, and how its last reads aged — each a fact code computed,
 *    each read by a question below;
 *  - the state carries nothing the questions do not read: the engine's
 *    exits, the cadence and the flatten time are enforced in code and never
 *    asked about, so they are not sent (unrelated state is context rot, and
 *    tokens); raw print lists are left out too — the model reads numbers as
 *    text and is weak at comparing them, so the tape is handed over in words;
 *  - instructions and criteria are STRUCTURED (`question` / `focus` /
 *    `inspect`, `what` / `not_for`, `summary` / `signals`) with the same
 *    field names across options, and refer to the state by path.
 *
 * Pure. `Asked` records which ids were handed out for which symbol, so the
 * reader never guesses from a key.
 */

/** One round trip the agent has already closed in this symbol today. */
export interface ClosedTrade {
  /** Gain or loss on the shares closed, in percent. */
  pct: number
  /** How long it was held, in minutes. */
  minutes: number
  /** How it ended, classified in code from the plan's own levels. */
  ending: 'stopped out' | 'hit the target' | 'closed by the model'
  /** Minutes since the sell. */
  agoMin: number
}

/** A verdict the model gave earlier on this symbol, and what the price did after it. */
export interface PastRead {
  agoSec: number
  /** The direction it picked, in the words it was asked in. */
  said: 'up' | 'down' | 'flat'
  probability: number
  /** Move since that read, in percent. */
  movedPct: number
}

/** The book as a whole, once per request — the `regime` question reads the day. */
export interface BookInputs {
  allocation: number
  cash: number
  positions: Position[]
  /** The day's P&L as a percentage of the allocation; null before the day anchor is set. */
  dayPct: number | null
  buyLocked: boolean
}

export interface SymbolInputs {
  symbol: string
  quote: Quote
  analysis: SymbolAnalysis | null
  /** Today's 5-minute bars, oldest first. */
  intraBars: Bar[]
  /** The live tape, when a stream is on. */
  tape?: TapeSnapshot | null
  prevLast?: number
  secondsSincePrev?: number
  position: Position | null
  exit: RealtimeExit | null
  /** Round trips already closed in this symbol today, newest first. */
  closed?: ClosedTrade[]
  /** The model's own last reads on this symbol, newest first. */
  reads?: PastRead[]
}

export interface AskedSymbol {
  direction: string
  extended?: string
  setup?: string
  regime?: string
  repeat?: string
  reversal?: string
  intact?: string
}
export type Asked = Record<string, AskedSymbol>

export interface Situation {
  state: Record<string, unknown>
  questions: Record<string, JevQuestion>
  asked: Asked
}

const pct = (a: number, b: number): number => ((a - b) / b) * 100
const signed = (n: number, dp = 2): string => `${n > 0 ? 'up' : n < 0 ? 'down' : 'flat'}${n === 0 ? '' : ` ${Math.abs(n).toFixed(dp)}%`}`
const px = (n: number): string => money(n)

/** The state key for a symbol: a path segment the model can be pointed at (`BTC/USD` → `BTC_USD`). */
export function stateKey(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]+/g, '_')
}

function rangeWords(last: number, high: number | null, low: number | null): string | null {
  if (high === null || low === null || high <= low) return null
  const pos = (last - low) / (high - low)
  if (pos >= 0.98) return "at today's high"
  if (pos >= 0.8) return "in the top fifth of today's range"
  if (pos >= 0.5) return "in the upper half of today's range"
  if (pos >= 0.2) return "in the lower half of today's range"
  if (pos > 0.02) return "in the bottom fifth of today's range"
  return "at today's low"
}

function rsiWords(rsi: number | null): string | null {
  if (rsi === null) return null
  const r = Math.round(rsi)
  if (r >= 75) return `${r} — overbought`
  if (r >= 60) return `${r} — strong`
  if (r > 40) return `${r} — neutral`
  if (r > 25) return `${r} — weak`
  return `${r} — oversold`
}

function volumeWords(v: number | null): string | null {
  if (v === null) return null
  if (v >= 2) return `very heavy — ${v.toFixed(1)}× the usual pace`
  if (v >= 1.3) return `heavy — ${v.toFixed(1)}× the usual pace`
  if (v >= 0.7) return `normal — ${v.toFixed(1)}× the usual pace`
  return `light — ${v.toFixed(1)}× the usual pace`
}

/**
 * What the agent has already done here today, in words: each closed trade's
 * result and how it ended, then the tally — counted in code, because the
 * model does not count — and how its own last reads aged.
 */
function describeToday(s: SymbolInputs): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  const closed = s.closed ?? []
  if (closed.length) {
    out.closed_trades = closed.map((t) => `${signed(t.pct)} over ${t.minutes < 1 ? 'under a minute' : `${Math.round(t.minutes)} minute${Math.round(t.minutes) === 1 ? '' : 's'}`}, ${t.ending}, ${t.agoMin < 1 ? 'just now' : `${Math.round(t.agoMin)} min ago`}`)
    const winners = closed.filter((t) => t.pct > 0).length
    const stopped = closed.filter((t) => t.ending === 'stopped out').length
    out.how_they_went =
      closed.length === 1
        ? `One trade here today: ${closed[0].pct > 0 ? 'it made money' : 'it lost money'}.`
        : `${closed.length} trades here today: ${winners === 0 ? 'none made money' : winners === closed.length ? 'all made money' : `${winners} made money, ${closed.length - winners} lost`}${stopped ? `, ${stopped === closed.length ? 'every one was stopped out' : `${stopped} stopped out`}` : ''}.`
  } else out.closed_trades = 'None — nothing has been traded in this symbol today.'
  const reads = s.reads ?? []
  if (reads.length) {
    out.earlier_reads = reads.map((r) => `${r.agoSec < 90 ? `${Math.round(r.agoSec)} s ago` : `${Math.round(r.agoSec / 60)} min ago`} the judgment was "${r.said}" at ${Math.round(r.probability * 100)}%; the price is ${signed(r.movedPct, 3)} since.`)
  }
  return Object.keys(out).length ? out : null
}

/** Recent price changes from the intraday bars: "last 5 minutes: up 0.3%". */
function recentMoves(last: number, bars: Bar[]): Record<string, string> {
  const out: Record<string, string> = {}
  const at = (barsAgo: number): number | null => (bars.length > barsAgo ? bars[bars.length - 1 - barsAgo].c : null)
  const spans: [string, number][] = [
    ['last_5_minutes', 1],
    ['last_15_minutes', 3],
    ['last_30_minutes', 6],
    ['last_hour', 12]
  ]
  for (const [key, n] of spans) {
    const ref = at(n)
    if (ref && ref > 0) out[key] = signed(pct(last, ref))
  }
  return out
}

/** The shape of the last few completed bars, in words. */
function barPattern(bars: Bar[]): string | null {
  const done = bars.slice(-4)
  if (done.length < 3) return null
  const last3 = done.slice(-3)
  const rising = last3.filter((b) => b.c > b.o).length
  const hh = done.every((b, i) => i === 0 || b.h > done[i - 1].h)
  const hl = done.every((b, i) => i === 0 || b.l > done[i - 1].l)
  const lh = done.every((b, i) => i === 0 || b.h < done[i - 1].h)
  const ll = done.every((b, i) => i === 0 || b.l < done[i - 1].l)
  const parts: string[] = []
  if (rising === 3) parts.push('three consecutive rising 5-minute bars')
  else if (rising === 0) parts.push('three consecutive falling 5-minute bars')
  else parts.push(`${rising} of the last three 5-minute bars closed up`)
  if (hh && hl) parts.push('higher highs and higher lows over the last 20 minutes')
  else if (lh && ll) parts.push('lower highs and lower lows over the last 20 minutes')
  const lastBar = done[done.length - 1]
  const body = Math.abs(lastBar.c - lastBar.o)
  const range = lastBar.h - lastBar.l
  if (range > 0 && body / range < 0.25) parts.push('the latest bar is a small-bodied, indecisive candle')
  return parts.join('; ')
}

/** The live tape in words: the touch, the last seconds, who is hitting the book. `unit` is "shares" or "units". */
function describeTape(t: TapeSnapshot, nowMs: number, unit: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const age = Math.max(0, (nowMs - t.lastTradeAt) / 1000)
  out.last_print = `${px(t.last)}, ${age < 1 ? 'under a second' : `${age.toFixed(0)} s`} ago`
  if (t.bid !== null && t.ask !== null) {
    out.touch = `bid ${px(t.bid)} × ${t.bidSize ?? '?'} / ask ${px(t.ask)} × ${t.askSize ?? '?'}${t.spreadPct !== null ? ` — ${t.spreadPct.toFixed(3)}% wide` : ''}`
    if (t.bidSize && t.askSize) {
      const r = t.askSize / t.bidSize
      out.book_lean = r >= 2 ? `${r.toFixed(1)}× more ${unit} offered than bid at the touch (sellers stacked)` : r <= 0.5 ? `${(1 / r).toFixed(1)}× more ${unit} bid than offered at the touch (buyers stacked)` : 'roughly balanced at the touch'
    }
  }
  const moves: Record<string, string> = {}
  if (t.returns.s10 !== null) moves.last_10_seconds = signed(t.returns.s10, 3)
  if (t.returns.s60 !== null) moves.last_60_seconds = signed(t.returns.s60, 3)
  if (t.returns.m5 !== null) moves.last_5_minutes = signed(t.returns.m5, 2)
  if (Object.keys(moves).length) out.moves = moves
  const f = t.flow60
  const classified = f.buyShares + f.sellShares
  if (classified > 0) {
    const buyPct = Math.round((f.buyShares / classified) * 100)
    out.flow_last_minute = `${f.prints} prints, ${classified.toLocaleString('en-US', { maximumFractionDigits: 4 })} classified ${unit}: ${buyPct >= 65 ? `buyers lifting the offer (${buyPct}% at the ask)` : buyPct <= 35 ? `sellers hitting the bid (${100 - buyPct}% at the bid)` : `two-sided (${buyPct}% at the ask)`}`
  } else if (f.prints > 0) out.flow_last_minute = `${f.prints} prints, mostly inside the spread`
  out.pace = t.printsPerMinute >= 60 ? `very active — about ${t.printsPerMinute} prints a minute` : t.printsPerMinute >= 15 ? `active — about ${t.printsPerMinute} prints a minute` : `quiet — about ${t.printsPerMinute} prints a minute`
  return out
}

function describeSymbol(s: SymbolInputs, clock: EtClock, g: RealtimeConfig['guardrails'], nowMs: number, continuous: boolean): Record<string, unknown> {
  const last = s.quote.last
  const a = s.analysis
  const unit = continuous ? 'units' : 'shares'
  const price: Record<string, unknown> = { last: px(last) }
  if (!s.tape && s.quote.bid && s.quote.ask && s.quote.ask > s.quote.bid) price.spread = `${(((s.quote.ask - s.quote.bid) / last) * 100).toFixed(2)}% wide`
  // A crypto "day" rolls at midnight UTC; the prior close is named for what it is.
  if (s.quote.prevClose) price[continuous ? 'vs_previous_utc_day_close' : 'vs_yesterday_close'] = signed(pct(last, s.quote.prevClose))
  if (a?.dayOpen) price.vs_today_open = signed(pct(last, a.dayOpen))
  if (a?.vwap) price.vs_vwap = `${signed(pct(last, a.vwap))} — ${last >= a.vwap ? 'above' : 'below'} VWAP (${px(a.vwap)})`
  const rp = rangeWords(last, a?.dayHigh ?? null, a?.dayLow ?? null)
  if (rp) price.position_in_day_range = `${rp} (low ${px(a!.dayLow!)}, high ${px(a!.dayHigh!)})`
  if (a?.gapPct !== null && a?.gapPct !== undefined && Math.abs(a.gapPct) >= 0.3) price.opening_gap = `gapped ${a.gapPct > 0 ? 'up' : 'down'} ${Math.abs(a.gapPct).toFixed(2)}% at the open`
  if (s.prevLast && s.secondsSincePrev !== undefined) price.since_last_check = `${signed(pct(last, s.prevLast), 3)} in the last ${s.secondsSincePrev < 1.5 ? 'second' : `${Math.round(s.secondsSincePrev)} seconds`}`

  const moves = recentMoves(last, s.intraBars)
  const bars: Record<string, unknown> = {}
  if (Object.keys(moves).length) bars.moves = moves
  const pattern = barPattern(s.intraBars)
  if (pattern) bars.pattern = pattern
  const vol = volumeWords(a?.volVsAvg ?? null)
  if (vol) bars.volume_today = vol
  if (a?.openingRange) {
    const or = a.openingRange
    bars.opening_range = last > or.high ? `trading above the first-15-minute range (${px(or.low)}–${px(or.high)})` : last < or.low ? `trading below the first-15-minute range (${px(or.low)}–${px(or.high)})` : `still inside the first-15-minute range (${px(or.low)}–${px(or.high)})`
  }

  const trend: Record<string, unknown> = {}
  if (a?.ema9 !== null && a?.ema9 !== undefined && a.ema21 !== null) trend.daily = a.ema9 > a.ema21 ? 'daily uptrend (9-day average above the 21-day)' : 'daily downtrend (9-day average below the 21-day)'
  const rsi = rsiWords(a?.rsi14 ?? null)
  if (rsi) trend.rsi_14_day = rsi
  if (a?.dailyRangePct) trend.typical_daily_range = `${a.dailyRangePct.toFixed(2)}% on an average day`

  let position: unknown = 'none — flat in this symbol'
  if (s.position && s.exit) {
    const p = s.position
    const stop = effectiveStop(s.exit, g)
    const held = Math.max(0, (nowMs - Date.parse(s.exit.enteredAt)) / 60_000)
    position = {
      side: 'long',
      [unit]: String(p.qty),
      entered: `${held < 1 ? `${Math.round(held * 60)} seconds` : `${Math.round(held)} minute${Math.round(held) === 1 ? '' : 's'}`} ago at ${px(p.avgCost)}`,
      unrealized: signed(pct(last, p.avgCost)),
      high_since_entry: `${px(s.exit.high)} (${signed(pct(s.exit.high, p.avgCost))} from the entry)`,
      from_the_high: signed(pct(last, s.exit.high)),
      stop: `${px(stop)} — ${Math.abs(pct(last, stop)).toFixed(2)}% below the current price${stop > p.avgCost ? ', already above the entry (locked-in gain)' : ''}`,
      target: `${px(s.exit.target)} — ${Math.abs(pct(s.exit.target, last)).toFixed(2)}% above the current price`
    }
  } else if (s.position) {
    position = { side: 'long', [unit]: String(s.position.qty), unrealized: signed(pct(last, s.position.avgCost)) }
  }

  const sinceOpen = clock.minutes - OPEN_MINUTES
  const toClose = sessionCloseMinutes(clock.date) - clock.minutes
  const out: Record<string, unknown> = { price }
  if (s.tape) out.tape = describeTape(s.tape, nowMs, unit)
  const today = describeToday(s)
  if (today) out.today = today
  if (Object.keys(bars).length) out.five_minute_bars = bars
  if (Object.keys(trend).length) out.daily_trend = trend
  out.position = position
  out.time = continuous ? `${formatMinutes(clock.minutes)} ET, ${clock.weekday} — this market trades around the clock; "today" is the ET date` : `${formatMinutes(clock.minutes)} ET — ${sinceOpen} minutes since the open, ${toClose} minutes to the close`
  return out
}

/**
 * The book in words: its size, how much of it is at work and in what, and
 * how the day has gone. The `regime` question reads the day; the rest is the
 * frame a trader would have in front of them.
 */
function describeBook(b: BookInputs, cfg: RealtimeConfig, continuous: boolean): Record<string, unknown> {
  const unit = continuous ? 'units' : 'shares'
  const atWork = b.positions.reduce((sum, p) => sum + p.qty * p.avgCost, 0)
  const pctAtWork = b.allocation > 0 ? Math.round((atWork / b.allocation) * 100) : 0
  const out: Record<string, unknown> = {
    paper_size: `${money(b.allocation, 0)} of paper money`,
    at_work: b.positions.length === 0 ? 'Nothing open — the whole book is in cash.' : `${pctAtWork}% of the book is in ${b.positions.length === 1 ? 'one position' : `${b.positions.length} positions`}: ${b.positions.map((p) => `${p.symbol} ${p.qty} ${unit} from ${money(p.avgCost)}`).join(', ')}.`
  }
  if (b.dayPct !== null) out.today = `The book is ${signed(b.dayPct)} on the day, counting what is still open.`
  if (b.buyLocked) out.note = 'Buying is locked for the rest of the day after the day-loss limit; only exits are left.'
  return out
}

/**
 * Build the state and the questions for every symbol that needs a decision.
 * Flat symbols get direction + extended + setup; held ones direction +
 * reversal + intact. `flatAllowed` false (entries closed by a rule) drops the
 * flat ones entirely — a question whose answer cannot be used is tokens for
 * nothing.
 */
export function buildSituation(cfg: RealtimeConfig, inputs: SymbolInputs[], clock: EtClock, nowMs: number, flatAllowed: boolean, book?: BookInputs): Situation {
  const g = cfg.guardrails
  const continuous = isContinuousMarket(cfg.assetClass)
  const instruments: Record<string, unknown> = {}
  const questions: Record<string, JevQuestion> = {}
  const asked: Asked = {}
  const horizon = `the next ${g.horizonMin} minute${g.horizonMin === 1 ? '' : 's'}`
  for (const s of inputs) {
    const holding = s.position !== null
    if (!holding && !flatAllowed) continue
    instruments[stateKey(s.symbol)] = describeSymbol(s, clock, g, nowMs, continuous)
    const ref = `instruments.${stateKey(s.symbol)}`
    // The path in backticks, as the docs point a question at a nested value.
    const path = `\`${ref}\``
    const q: AskedSymbol = { direction: `${s.symbol}__direction` }
    questions[q.direction] = {
      type: 'choice',
      instructions: {
        question: `Over ${horizon}, will the price of \`${ref}\` be higher, lower, or about where it is now?`,
        inspect: path,
        focus: `The judgment is the near-term path, not the day: weigh \`${ref}.tape\` (the last seconds — the touch, who is hitting the book, the last prints) most, then \`${ref}.five_minute_bars\`, then \`${ref}.daily_trend\`. A move that has already happened is not a move that is coming.`,
        note: `The trader's standing order is in \`trader.style\`. "About where it is" means inside the ordinary noise of the last minutes, not enough to trade.`
      },
      criteria: {
        up: { what: `Higher after ${horizon} by more than the noise of the last minutes.`, not_for: 'A spike that is already fading; a flat, two-sided tape.', signals: 'buyers lifting the offer, higher lows, price holding above VWAP or the opening range, rising prints' },
        down: { what: `Lower after ${horizon} by more than the noise of the last minutes.`, not_for: 'A dip that is already being bought; a flat, two-sided tape.', signals: 'sellers hitting the bid, lower highs, price losing VWAP or the opening range, falling prints' },
        flat: { what: `About where it is after ${horizon}: inside the ordinary noise.`, not_for: 'A tape with a clear lean either way.', signals: 'balanced flow, prints inside the spread, small-bodied bars, quiet pace' }
      }
    }
    if (holding) {
      q.reversal = `${s.symbol}__reversal`
      q.intact = `${s.symbol}__intact`
      questions[q.reversal] = {
        type: 'noul',
        instructions: { question: `Is \`${ref}\` showing a sharp reversal AGAINST the trader's long position right now?`, inspect: path, focus: 'A reversal is decisive, not a pause: a fast move down on heavy selling, a failed breakout, or the pattern that carried it up breaking.' },
        criteria: {
          true: { what: 'Yes — the tape has turned against the position decisively.', examples: ['sellers hitting the bid for most of the last minute and the price is falling through recent lows', 'a breakout above the opening range that failed and is now back inside it'] },
          false: { what: 'No — an ordinary pullback, chop, or continued strength.', examples: ['a small dip inside the trend with buyers still lifting the offer', 'a flat tape near the high'] }
        }
      }
      questions[q.intact] = {
        type: 'noul',
        instructions: { question: `Is the move that justified entering \`${ref}\` still intact?`, inspect: path, focus: 'Judge the position\'s reason to exist: trend, flow and the level it entered above. This is separate from whether a reversal is happening right now.' },
        criteria: {
          true: { what: 'Yes — the trend and the flow that carried the entry are still there.', signals: 'higher lows since the entry, buyers still active, price above the entry level and above VWAP' },
          false: { what: 'No — the reason to be in the trade has gone, even without a sharp reversal.', signals: 'momentum faded to a two-sided drift, price back below the entry level, flow turned to sellers' }
        }
      }
    } else {
      q.extended = `${s.symbol}__extended`
      q.setup = `${s.symbol}__setup`
      q.regime = `${s.symbol}__regime`
      q.repeat = `${s.symbol}__repeat`
      questions[q.extended] = {
        type: 'noul',
        instructions: { question: `Is the price of \`${ref}\` EXTENDED — has the move already happened, so that buying now would be chasing?`, inspect: path, focus: 'Distance from VWAP and from where the move started, how fast the last minutes ran, and whether the tape is already cooling.' },
        criteria: {
          true: { what: 'Yes — a buy here is late: far above VWAP or the opening range after a fast run, prints already fading.', examples: ['up 1.5% in the last 15 minutes and at the day high with flow going two-sided'] },
          false: { what: 'No — the price is near where the move is starting or resuming, not at the end of one.', examples: ['just reclaimed VWAP with buyers lifting the offer', 'a tight pullback holding a higher low'] }
        }
      }
      questions[q.setup] = {
        type: 'score',
        instructions: { question: `How clean is the long setup in \`${ref}\` right now?`, inspect: path, focus: 'One dimension only: how well trend, flow and structure line up for a long entry with a defined risk. Direction and extension are asked separately.' },
        criteria: [
          { summary: 'Chop — no setup.', signals: 'two-sided flow, small-bodied bars, price inside a range with no lean, quiet pace' },
          { summary: 'Mixed — some alignment, some against.', signals: 'trend up but flow two-sided, or flow strong but structure unclear' },
          { summary: 'Clean — trend, flow and structure agree, with a nearby level to risk against.', signals: 'higher lows, buyers lifting the offer, holding above VWAP or the opening range, active pace' }
        ]
      }
      questions[q.regime] = {
        type: 'score',
        instructions: {
          question: `Judged on how ${path} has actually traded today, how well is it carrying a move right now?`,
          inspect: [`\`${ref}.today\``, `\`${ref}.tape\``, `\`${ref}.five_minute_bars\``],
          focus: 'The venue, not this entry: when a push starts here, does it go somewhere, or does it come straight back? The trader\'s own closed trades in `today.closed_trades` are evidence — entries that were stopped out soon after they were opened are what chop looks like from the inside.',
          note: 'This is about the last hour or two of behaviour, not the daily trend.'
        },
        criteria: [
          { summary: 'Chopping — pushes fail and come straight back; an entry is stopped out soon after it is opened.', signals: 'price crossing back and forth over VWAP, long wicks both ways, flow flipping between buyers and sellers, trades here today stopped out within minutes' },
          { summary: 'Mixed — some follow-through, but moves are short-lived and give most of it back.', signals: 'a push that runs then fades to where it started, one winner and one loser on the day' },
          { summary: 'Trending — a push carries: pullbacks hold above where they started and the move continues.', signals: 'higher lows through the session, pullbacks bought, trades here today that ran to their target' }
        ]
      }
      questions[q.repeat] = {
        type: 'noul',
        instructions: {
          question: `Would buying ${path} right now repeat an entry that has ALREADY failed in it today?`,
          compare: [`\`${ref}.today.closed_trades\``, `\`${ref}.tape\``],
          focus: 'Compare the tape now with the conditions behind the losing trades listed in `today`. The judgment is sameness, not whether the trade would lose.'
        },
        criteria: {
          true: { what: 'Yes — the tape now looks like the tape that produced a loss here today.', examples: ['two entries stopped out earlier on pushes that faded, and this is another push of the same size into the same level', 'the losses came near the day high and the price is back at the day high'] },
          false: { what: 'No — either nothing has failed here today, or the tape is materially different from when it did.', not_for: 'Any buy at all in a symbol that has had a loss — the conditions have to actually match.', examples: ['no trades closed here today', 'the earlier losses came in a flat two-sided tape; buyers are now lifting the offer on heavy volume'] }
        }
      }
    }
    asked[s.symbol] = q
  }
  // Only what a judgment reads: the standing order and the one rule that
  // shapes a verdict. Stops, targets, the cadence and the flatten time are
  // the engine's and are never asked about.
  const state = {
    trader: {
      style: cfg.style || (continuous ? 'Disciplined short-term momentum trading in crypto spot pairs: buy strength that is confirmed by trend and flow, take profits at the target, cut losses at the stop.' : 'Disciplined intraday momentum trading: buy strength that is confirmed by trend and volume, take profits at the target, cut losses at the stop.'),
      rules: 'Long only, one position per instrument; a sell closes the whole position.'
    },
    session: continuous ? `Crypto spot market, open around the clock — ${clock.weekday} ${clock.date} in ET.` : `Regular US equity session, ${clock.weekday} ${clock.date}.`,
    ...(book ? { book: describeBook(book, cfg, continuous) } : {}),
    instruments
  }
  return { state, questions, asked }
}
