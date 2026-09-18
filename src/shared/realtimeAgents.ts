import type { Fill, FillEconomics, Ledger } from './ledger'
import { emptyLedger, money } from './ledger'
import { parseHHMM, type SessionLabel } from './marketTime'

/**
 * Real-time agents (2026-09-17). A paper agent that is checked every few
 * seconds through the session and decided by a System One model (TypeSafe's
 * Jev) rather than a reasoning model: the engine computes every number, hands
 * the model a described situation, and reads back a typed verdict with
 * probabilities. Code owns the workflow — exits, sizing, entry windows, the
 * daily-loss lock — exactly as it does for the thread agents; only the
 * "what now?" judgment is the model's, and only within the thresholds here.
 *
 * Desktop-only and paper-only for now: the loop lives in the desktop engine,
 * the book is the same paper ledger the thread agents keep (`applyFill`,
 * settlement, `fillEconomics`), and nothing here reaches the cloud or a broker.
 *
 * Pure and Node-free: mirrored to the phone with the rest of `src/shared`.
 */

export const REALTIME_MIN_INTERVAL_SEC = 1
export const REALTIME_MAX_INTERVAL_SEC = 300
export const REALTIME_DEFAULT_INTERVAL_SEC = 15
export const REALTIME_MAX_SYMBOLS = 8
export const REALTIME_MAX_AGENTS = 6
/** Ticks kept on the state for the page's tape; the full log is the host's jsonl. */
export const REALTIME_RECENT_TICKS = 150
/** The smallest paper entry worth booking. */
export const REALTIME_MIN_ORDER_USD = 5

/** The model's name as the UI says it — a product fact, not the vendor's. */
export const REALTIME_MODEL_LABEL = 'Jev (System One)'
/** Between decisions the page still wants a moving price: the host samples quotes this often while any agent runs in session. */
export const REALTIME_PRICE_POLL_MS = 3_000
/** Samples the page keeps per symbol (30 minutes at one a second). */
export const REALTIME_SAMPLES_MAX = 1800
/** Ticks the page keeps per agent beyond the state's own ring — the feed scrolls through all of them. */
export const REALTIME_PAGE_TICKS_MAX = 3000
/** A tape snapshot older than this is not a price; the tick falls back to the polled feed. */
export const REALTIME_TAPE_STALE_MS = 15_000

/**
 * What an agent trades. Stocks are US equities on the regular session with
 * T+1 settlement; crypto is spot pairs (`BTC/USD`) that trade around the
 * clock and settle at once. The class is fixed at creation — one book, one
 * kind of thing in it — and every session rule reads it: a crypto agent has
 * no open, no close, no flatten time and no entry window.
 */
export type AssetClass = 'stocks' | 'crypto'
export const REALTIME_ASSET_CLASS_LABEL: Record<AssetClass, string> = { stocks: 'Stocks', crypto: 'Crypto' }
/** Markets with no session: always open, no flatten, instant settlement. */
export function isContinuousMarket(assetClass: AssetClass | undefined): boolean {
  return assetClass === 'crypto'
}
/** The quote currencies a crypto pair may be priced in; a bare `BTC` means `BTC/USD`. */
const CRYPTO_QUOTES = ['USD', 'USDT', 'USDC', 'BTC']

/** The live data stream behind one-second decisions: the operator's own market-data key, on this computer only. */
export type RealtimeStreamFeed = 'iex' | 'sip' | 'test'
export interface RealtimeStreamKeyRequest {
  keyId: string
  secret: string
  feed: RealtimeStreamFeed
}
export type RealtimeStreamState = 'off' | 'connecting' | 'live' | 'reconnecting' | 'error'
/** One stream connection's state: stocks and crypto are separate sockets on the same key. */
export interface RealtimeStreamLeg {
  state: RealtimeStreamState
  /** The last error or the reason it is off, when there is one. */
  detail?: string
  /** Symbols currently subscribed. */
  symbols: string[]
  lastMessageAt?: string
  /** Trades received since the stream opened. */
  trades: number
}
export interface RealtimeStreamStatus extends RealtimeStreamLeg {
  /** A key is stored. */
  configured: boolean
  /** The stocks feed; crypto has one feed. */
  feed: RealtimeStreamFeed
  /** The crypto socket (`v1beta3/crypto/us`), opened whenever a crypto agent runs — around the clock. */
  crypto: RealtimeStreamLeg
}
export const REALTIME_STREAM_LEG_OFF: RealtimeStreamLeg = { state: 'off', symbols: [], trades: 0 }
export const REALTIME_STREAM_FEED_LABEL: Record<RealtimeStreamFeed, string> = { iex: 'IEX (free, real time)', sip: 'SIP (all exchanges, paid plan)', test: 'Test stream (fake prints, 24/7)' }

/** One quote sample for the chart — every running agent's symbols in one row, no state behind it. */
export interface RealtimePriceSample {
  at: string
  prices: Record<string, number>
}

export interface RealtimeGuardrails {
  /** Largest position in one symbol, as a % of the allocation. */
  maxPositionPct: number
  /** Hard stop below the entry price, %. */
  stopLossPct: number
  /** Take-profit above the entry price, %. */
  takeProfitPct: number
  /** Trailing stop below the high since entry, %; null = none. */
  trailPct: number | null
  /** Day's loss (vs the day's opening equity, as % of allocation) that locks BUYS for the rest of the day. */
  maxDailyLossPct: number
  /** ET "HH:MM" — every position is closed at market from this minute. */
  flattenAt: string
  /** ET "HH:MM" — no entries before this minute (the opening range). */
  noEntriesBeforeEt: string
  /** ET "HH:MM" — no entries from this minute (nothing new near the close). */
  noEntriesAfterEt: string
  /** No entry more than this % above VWAP; null = not checked. */
  maxEntryExtensionPct: number | null
  /** Minimum probability the model must put on `buy` to open a position. */
  buyThreshold: number
  /** Minimum probability the model must put on `sell` to close one. */
  sellThreshold: number
  /** Probability on the "sharp reversal against the position" question that closes it on its own. */
  reversalThreshold: number
  /** Minutes after a sell before the same symbol may be bought again. */
  reentryCooldownMin: number
  /** The horizon the direction question is asked over, in minutes. */
  horizonMin: number
  /** A buy is refused when the model puts more than this on "the price is extended / chasing". */
  maxExtended: number
  /** A buy needs at least this setup-quality score (0 chop … 2 clean). */
  minSetup: number
}

export const REALTIME_DEFAULTS: RealtimeGuardrails = {
  maxPositionPct: 25,
  stopLossPct: 0.75,
  takeProfitPct: 1.5,
  trailPct: 0.6,
  maxDailyLossPct: 2,
  flattenAt: '15:55',
  noEntriesBeforeEt: '09:45',
  noEntriesAfterEt: '15:30',
  maxEntryExtensionPct: 1.5,
  buyThreshold: 0.7,
  sellThreshold: 0.6,
  reversalThreshold: 0.85,
  reentryCooldownMin: 10,
  horizonMin: 3,
  maxExtended: 0.6,
  minSetup: 1
}

export type RealtimeStatus = 'running' | 'paused'

export interface RealtimeConfig {
  id: string
  name: string
  /** Fixed at creation; older configs without it are stocks. */
  assetClass: AssetClass
  symbols: string[]
  allocation: number
  intervalSec: number
  guardrails: RealtimeGuardrails
  status: RealtimeStatus
  /** A sentence about the style the model should judge for ("momentum breakouts", "fade the opening spike"…). */
  style: string
  createdAt: string
  updatedAt: string
}

export type RealtimeAction = 'buy' | 'sell' | 'hold'

/**
 * What the model said about one symbol — several ATOMIC judgments the code
 * composes (TypeSafe's build guide: broad questions hide several judgments
 * behind one answer; atomic ones can be inspected, tuned and combined).
 * `action` and `probabilities` are the direction question read as buy / sell
 * / hold (up → buy, down → sell, flat → hold) so every older row and renderer
 * still reads; the rest are the other questions, each its own bar.
 */
export interface RealtimeVerdict {
  action: RealtimeAction
  probabilities: Partial<Record<RealtimeAction, number>>
  confidence: number
  /** P(the price is extended — a buy now would be chasing). Flat only. */
  extended?: number
  /** Setup quality, 0 chop … 2 clean, probability-weighted. Flat only. */
  setup?: number
  /** P(a sharp reversal against the open position). Holding only. */
  reversal?: number
  /** P(the move that justified the entry is still intact). Holding only. */
  trendIntact?: number
}

export type RealtimeIntent = 'buy' | 'sell' | 'hold' | 'exit' | 'none'
export type RealtimeOutcome = 'filled' | 'held' | 'blocked' | 'quiet' | 'error'

export type RealtimeRule =
  | 'jev.buy'
  | 'jev.sell'
  | 'jev.hold'
  | 'jev.reversal'
  | 'jev.trendBroken'
  | 'jev.extended'
  | 'jev.weakSetup'
  | 'jev.belowThreshold'
  | 'jev.error'
  | 'jev.noKey'
  | 'exit.stop'
  | 'exit.target'
  | 'exit.trail'
  | 'exit.flatten'
  | 'entry.beforeWindow'
  | 'entry.afterWindow'
  | 'entry.extended'
  | 'entry.cooldown'
  | 'lock.dailyLoss'
  | 'cap.cash'
  | 'size.tooSmall'
  | 'feed.unpriced'
  | 'session.closed'
  | 'quiet'

/** One phrase per rule — a `Record` over the closed set, so a new rule without one fails to compile. */
export const REALTIME_RULE_LABEL: Record<RealtimeRule, string> = {
  'jev.buy': 'Model said buy',
  'jev.sell': 'Model said sell',
  'jev.hold': 'Model said hold',
  'jev.reversal': 'Model saw a reversal',
  'jev.trendBroken': 'Model: trend broken',
  'jev.extended': 'Model: extended',
  'jev.weakSetup': 'Model: weak setup',
  'jev.belowThreshold': 'Below the threshold',
  'jev.error': 'Model unavailable',
  'jev.noKey': 'No TypeSafe key',
  'exit.stop': 'Stop-loss hit',
  'exit.target': 'Target hit',
  'exit.trail': 'Trailing stop hit',
  'exit.flatten': 'Flattened at the cut-off',
  'entry.beforeWindow': 'Before the entry window',
  'entry.afterWindow': 'After the entry window',
  'entry.extended': 'Too far above VWAP',
  'entry.cooldown': 'Re-entry cooldown',
  'lock.dailyLoss': 'Day loss lock',
  'cap.cash': 'No settled cash',
  'size.tooSmall': 'Order too small',
  'feed.unpriced': 'No price',
  'session.closed': 'Market closed',
  quiet: 'Nothing moved'
}

export interface RealtimeDecision {
  symbol: string
  /** The last price the decision was made against; null when unpriced. */
  price: number | null
  verdict?: RealtimeVerdict
  intent: RealtimeIntent
  outcome: RealtimeOutcome
  rule: RealtimeRule
  detail: string
  fill?: Fill
  econ?: FillEconomics
}

export interface RealtimeTick {
  id: string
  at: string
  session: SessionLabel
  decisions: RealtimeDecision[]
  /** Cash + positions marked at this tick's quotes. */
  equity: number
  unrealized: number
  /** Round trip of the model call, when one was made. */
  latencyMs?: number
  usage?: { input: number; output: number }
  /** Set when the whole tick did nothing, and why. */
  skipped?: string
  error?: string
}

/** The engine's exit levels for one open position — enforced in code every tick. */
export interface RealtimeExit {
  entryPrice: number
  enteredAt: string
  /** Hard stop (entry − stopLossPct). */
  stop: number
  target: number
  /** Highest price seen since entry — what a trail ratchets from. */
  high: number
}

export interface RealtimeState {
  ledger: Ledger
  exits: Record<string, RealtimeExit>
  /** ET date the day anchor belongs to. */
  dayDate: string | null
  dayStartEquity: number | null
  buyLocked: boolean
  lastSellAt: Record<string, string>
  lastQuotes: Record<string, number>
  lastTickAt: string | null
  lastError: string | null
  ticksToday: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  recent: RealtimeTick[]
}

export function emptyRealtimeState(allocation: number): RealtimeState {
  return {
    ledger: emptyLedger(allocation),
    exits: {},
    dayDate: null,
    dayStartEquity: null,
    buyLocked: false,
    lastSellAt: {},
    lastQuotes: {},
    lastTickAt: null,
    lastError: null,
    ticksToday: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    recent: []
  }
}

/** What crosses IPC and Realtime: the config and the state, nothing else. */
export interface RealtimeSummary {
  config: RealtimeConfig
  state: RealtimeState
}

export interface RealtimeCreateRequest {
  name: string
  /** Default `stocks`. */
  assetClass?: AssetClass
  symbols: string[]
  allocation: number
  intervalSec: number
  style: string
  guardrails?: Partial<RealtimeGuardrails>
}

export type RealtimeUpdateRequest = Partial<Pick<RealtimeConfig, 'name' | 'symbols' | 'intervalSec' | 'style'>> & { guardrails?: Partial<RealtimeGuardrails> }

/** Whether the TypeSafe key is stored and, when tested, what the service said. */
export interface RealtimeKeyStatus {
  hasKey: boolean
  /** Model ids the account can use, from the last successful test; absent until tested. */
  models?: string[]
  /** The last test's failure, when it failed. */
  error?: string
  testedAt?: string
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Every guardrail inside its sane range; unknown or absent fields take the default. */
export function clampRealtimeGuardrails(g: Partial<RealtimeGuardrails> | undefined): RealtimeGuardrails {
  const d = REALTIME_DEFAULTS
  const src = g ?? {}
  const hhmm = (v: unknown, fallback: string): string => (typeof v === 'string' && parseHHMM(v) !== null ? v : fallback)
  const trail = src.trailPct === null ? null : num(src.trailPct, d.trailPct ?? 0)
  const ext = src.maxEntryExtensionPct === null ? null : num(src.maxEntryExtensionPct, d.maxEntryExtensionPct ?? 0)
  return {
    maxPositionPct: clamp(num(src.maxPositionPct, d.maxPositionPct), 1, 100),
    stopLossPct: clamp(num(src.stopLossPct, d.stopLossPct), 0.1, 20),
    takeProfitPct: clamp(num(src.takeProfitPct, d.takeProfitPct), 0.1, 50),
    trailPct: trail === null ? null : clamp(trail, 0.1, 20),
    maxDailyLossPct: clamp(num(src.maxDailyLossPct, d.maxDailyLossPct), 0.1, 50),
    flattenAt: hhmm(src.flattenAt, d.flattenAt),
    noEntriesBeforeEt: hhmm(src.noEntriesBeforeEt, d.noEntriesBeforeEt),
    noEntriesAfterEt: hhmm(src.noEntriesAfterEt, d.noEntriesAfterEt),
    maxEntryExtensionPct: ext === null ? null : clamp(ext, 0.1, 20),
    buyThreshold: clamp(num(src.buyThreshold, d.buyThreshold), 0.5, 0.99),
    sellThreshold: clamp(num(src.sellThreshold, d.sellThreshold), 0.5, 0.99),
    reversalThreshold: clamp(num(src.reversalThreshold, d.reversalThreshold), 0.5, 0.99),
    reentryCooldownMin: clamp(Math.round(num(src.reentryCooldownMin, d.reentryCooldownMin)), 0, 240),
    horizonMin: clamp(Math.round(num(src.horizonMin, d.horizonMin)), 1, 60),
    maxExtended: clamp(num(src.maxExtended, d.maxExtended), 0.05, 1),
    minSetup: clamp(num(src.minSetup, d.minSetup), 0, 2)
  }
}

/**
 * One crypto pair as the feed names it: `BASE/QUOTE`, upper-cased. Accepts
 * what people type — `btc`, `BTC/USD`, `BTC-USD`, `BTCUSD`, `eth_usdt` — and
 * reads a bare coin as priced in USD. Null when it cannot be a pair.
 */
export function normCryptoSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '')
  if (!s) return null
  let base: string
  let quote: string
  const sep = /^([A-Z0-9]+)[/\-_:]([A-Z]+)$/.exec(s)
  if (sep) {
    base = sep[1]
    quote = sep[2]
  } else if (/^[A-Z0-9]+$/.test(s)) {
    const q = CRYPTO_QUOTES.find((c) => s.length > c.length + 1 && s.endsWith(c))
    base = q ? s.slice(0, -q.length) : s
    quote = q ?? 'USD'
  } else return null
  if (!/^[A-Z0-9]{2,10}$/.test(base) || !/^[A-Z]{3,5}$/.test(quote) || base === quote) return null
  return `${base}/${quote}`
}

/** Upper-cased, de-duplicated, capped — the same normalisation every feed does. Crypto pairs come out as `BASE/QUOTE`. */
export function normRealtimeSymbols(symbols: readonly string[], assetClass: AssetClass = 'stocks'): string[] {
  const norm = assetClass === 'crypto' ? symbols.map(normCryptoSymbol).filter((s): s is string => s !== null) : symbols.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.]{1,6}$/.test(s))
  return [...new Set(norm)].slice(0, REALTIME_MAX_SYMBOLS)
}

/** The one refusal sentence for a create/update, or null when it is fine. */
export function realtimeConfigProblem(r: { name?: string; symbols?: string[]; allocation?: number; intervalSec?: number; assetClass?: AssetClass }): string | null {
  const cls = r.assetClass ?? 'stocks'
  if (r.name !== undefined && !r.name.trim()) return 'Give the agent a name.'
  if (r.symbols !== undefined && normRealtimeSymbols(r.symbols, cls).length === 0) return cls === 'crypto' ? 'Add at least one pair (coins like BTC, ETH, SOL — priced in USD).' : 'Add at least one symbol (tickers like NVDA, AAPL).'
  if (r.symbols !== undefined && r.symbols.length > REALTIME_MAX_SYMBOLS) return `Up to ${REALTIME_MAX_SYMBOLS} symbols per real-time agent.`
  if (r.allocation !== undefined && !(r.allocation >= 100)) return 'Allocate at least $100 of paper money.'
  if (r.intervalSec !== undefined && (r.intervalSec < REALTIME_MIN_INTERVAL_SEC || r.intervalSec > REALTIME_MAX_INTERVAL_SEC))
    return `Check every ${REALTIME_MIN_INTERVAL_SEC}–${REALTIME_MAX_INTERVAL_SEC} seconds.`
  return null
}

/** Cash + positions marked at these prices (cost basis for a symbol with no price). */
export function realtimeEquity(state: Pick<RealtimeState, 'ledger' | 'lastQuotes'>): { equity: number; unrealized: number } {
  let mv = 0
  let unrealized = 0
  for (const p of state.ledger.positions) {
    const px = state.lastQuotes[p.symbol] ?? p.avgCost
    mv += p.qty * px
    unrealized += (px - p.avgCost) * p.qty
  }
  const r2 = (n: number): number => Math.round(n * 100) / 100
  return { equity: r2(state.ledger.cash + mv), unrealized: r2(unrealized) }
}

/** The day's P&L against the day anchor, as the page and the lock both read it. */
export function realtimeDayPnl(state: Pick<RealtimeState, 'ledger' | 'lastQuotes' | 'dayStartEquity'>): number | null {
  if (state.dayStartEquity === null) return null
  return Math.round((realtimeEquity(state).equity - state.dayStartEquity) * 100) / 100
}

/** One line per decision for the tape: "NVDA · Model said buy · filled 1.2 @ $182.40". */
export function describeRealtimeDecision(d: RealtimeDecision): string {
  const px = d.price !== null ? ` @ ${money(d.price)}` : ''
  if (d.fill) return `${d.symbol} · ${REALTIME_RULE_LABEL[d.rule]} · ${d.fill.side === 'buy' ? 'bought' : 'sold'} ${d.fill.qty} @ ${money(d.fill.price)}${d.econ?.realized !== undefined ? ` (${d.econ.realized >= 0 ? '+' : ''}${money(d.econ.realized)})` : ''}`
  return `${d.symbol} · ${REALTIME_RULE_LABEL[d.rule]}${px} · ${d.detail}`
}
