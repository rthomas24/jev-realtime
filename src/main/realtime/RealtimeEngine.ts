import { newId } from '@shared/ledger'
import { isRegularSession, nextSessionOpen } from '@shared/marketTime'
import type { Quote } from '@shared/ipc'
import {
  clampRealtimeGuardrails,
  emptyRealtimeState,
  normRealtimeSymbols,
  REALTIME_MAX_AGENTS,
  REALTIME_PRICE_POLL_MS,
  REALTIME_TAPE_STALE_MS,
  realtimeConfigProblem,
  type RealtimeConfig,
  type RealtimeCreateRequest,
  type RealtimeKeyStatus,
  type RealtimeState,
  type RealtimeStreamKeyRequest,
  type RealtimeStreamStatus,
  type RealtimeSummary,
  type RealtimeUpdateRequest
} from '@shared/realtimeAgents'
import type { RealtimeEvent } from '@shared/ipc'
import type { Bar, PriceFeed } from '@core/market/feed'
import { alpacaFeed } from '@core/market/alpaca'
import { alpacaStream, type MarketStream } from '@core/market/alpacaStream'
import { SymbolTape, tapeQuote, type TapeSnapshot } from '@core/market/tape'
import { testTypesafeKey, typesafeDecider, type Decider } from '@core/realtime/jev'
import { runRealtimeTick } from '@core/realtime/tick'
import { redactSecrets } from '@core/redact'
import { alpacaKey } from '../store/alpacaKey'
import { typesafeKey } from '../store/typesafeKey'
import { realtimeStore } from './store'

/**
 * The desktop host for real-time agents: one setTimeout chain per running
 * agent (a tick re-arms itself when it ends, so two never overlap), prices
 * from the live TAPE (every print and quote, so a one-second cadence sees a
 * one-second tape) and, for a symbol the tape has not printed, the same key's
 * snapshot endpoint; bars cached per symbol so ten agents watching NVDA cost
 * one bars call, and the model behind one cached client per key.
 *
 * Off-session the chains sleep until the next open (checking once a minute)
 * and the stream is closed, so a night costs nothing — not a print, not a
 * token. The `test` feed is the exception: it prints a fake symbol around the
 * clock, and an agent on it ticks around the clock too, which is how the
 * whole path can be watched with the market closed.
 *
 * Writes: the tick log is appended every tick; `state.json` is written at
 * once when the book changed (a fill, an exit level, a lock, the day anchor)
 * and otherwise at most every `STATE_FLUSH_MS` — at one tick a second an
 * atomic write per tick would be a hundred kilobytes a second for nothing.
 */
const INTRA_BARS_TTL_MS = 60_000
const DAY_BARS_TTL_MS = 60 * 60_000
const OFF_SESSION_POLL_MS = 60_000
const FIRST_TICK_DELAY_MS = 1_500
const MODEL_TIMEOUT_MAX_MS = 8_000
const MODEL_TIMEOUT_MIN_MS = 2_500
const STATE_FLUSH_MS = 5_000
/** How often the tape is turned into a `realtime:price` sample for the page while a stream is live. */
const TAPE_SAMPLE_MS = 1_000

type Listener = (e: RealtimeEvent) => void

interface BarsEntry {
  at: number
  bars: Bar[]
}

class RealtimeEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private busy = new Set<string>()
  private listeners = new Set<Listener>()
  private intra = new Map<string, BarsEntry>()
  private day = new Map<string, BarsEntry>()
  private decider: { key: string; d: Decider } | null = null
  private priceTimer: ReturnType<typeof setInterval> | null = null
  private pricing = false
  // ── the stream ──
  private stream: MarketStream | null = null
  private streamStatusValue: RealtimeStreamStatus = { configured: false, feed: 'iex', state: 'off', symbols: [], trades: 0 }
  private tapes = new Map<string, SymbolTape>()
  private tapeTimer: ReturnType<typeof setInterval> | null = null
  // ── state writes ──
  private dirty = new Map<string, ReturnType<typeof setTimeout>>()

  init(): void {
    for (const s of realtimeStore.list()) if (s.config.status === 'running') this.arm(s.config.id, FIRST_TICK_DELAY_MS)
    // The polled price stream for the page when there is no live tape: one
    // quote call for every running agent's symbols, every few seconds, in
    // session, while someone listens. Ephemeral by design.
    if (!this.priceTimer) this.priceTimer = setInterval(() => void this.pricePoll(), REALTIME_PRICE_POLL_MS)
    if (!this.tapeTimer) this.tapeTimer = setInterval(() => this.tapeSample(), TAPE_SAMPLE_MS)
    this.syncStream()
  }

  disposeAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.priceTimer) clearInterval(this.priceTimer)
    this.priceTimer = null
    if (this.tapeTimer) clearInterval(this.tapeTimer)
    this.tapeTimer = null
    this.stream?.close()
    this.stream = null
    for (const [id, t] of this.dirty) {
      clearTimeout(t)
      const st = realtimeStore.getState(id)
      if (st) realtimeStore.saveState(id, st)
    }
    this.dirty.clear()
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn)
    this.syncStream()
    return () => this.listeners.delete(fn)
  }
  private emit(e: RealtimeEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.warn('[realtime] listener failed', err)
      }
    }
  }
  private emitUpdated(id: string): void {
    const config = realtimeStore.getConfig(id)
    const state = realtimeStore.getState(id)
    if (config && state) this.emit({ type: 'realtime:updated', summary: { config, state } })
  }

  list(): RealtimeSummary[] {
    return realtimeStore.list()
  }
  get(id: string): RealtimeSummary | null {
    const config = realtimeStore.getConfig(id)
    const state = realtimeStore.getState(id)
    return config && state ? { config, state } : null
  }

  create(req: RealtimeCreateRequest): RealtimeSummary {
    const symbols = normRealtimeSymbols(req.symbols ?? [])
    const problem = realtimeConfigProblem({ name: req.name, symbols, allocation: req.allocation, intervalSec: req.intervalSec })
    if (problem) throw new Error(problem)
    if (realtimeStore.list().length >= REALTIME_MAX_AGENTS) throw new Error(`Up to ${REALTIME_MAX_AGENTS} real-time agents on this computer.`)
    const now = new Date().toISOString()
    const cfg: RealtimeConfig = {
      id: newId('rt_'),
      name: req.name.trim(),
      symbols,
      allocation: Math.round(req.allocation * 100) / 100,
      intervalSec: Math.round(req.intervalSec),
      guardrails: clampRealtimeGuardrails(req.guardrails),
      status: 'running',
      style: (req.style ?? '').trim().slice(0, 400),
      createdAt: now,
      updatedAt: now
    }
    const summary = realtimeStore.create(cfg)
    this.emit({ type: 'realtime:updated', summary })
    this.arm(cfg.id, FIRST_TICK_DELAY_MS)
    this.syncStream()
    return summary
  }

  update(id: string, patch: RealtimeUpdateRequest): RealtimeSummary {
    const cfg = realtimeStore.getConfig(id)
    if (!cfg) throw new Error('No such real-time agent.')
    const symbols = patch.symbols !== undefined ? normRealtimeSymbols(patch.symbols) : cfg.symbols
    const problem = realtimeConfigProblem({ name: patch.name, symbols: patch.symbols !== undefined ? symbols : undefined, intervalSec: patch.intervalSec })
    if (problem) throw new Error(problem)
    const next: RealtimeConfig = {
      ...cfg,
      name: patch.name !== undefined ? patch.name.trim() : cfg.name,
      symbols,
      intervalSec: patch.intervalSec !== undefined ? Math.round(patch.intervalSec) : cfg.intervalSec,
      style: patch.style !== undefined ? patch.style.trim().slice(0, 400) : cfg.style,
      guardrails: patch.guardrails ? clampRealtimeGuardrails({ ...cfg.guardrails, ...patch.guardrails }) : cfg.guardrails,
      updatedAt: new Date().toISOString()
    }
    realtimeStore.saveConfig(next)
    this.emitUpdated(id)
    if (next.status === 'running') this.arm(id, next.intervalSec * 1000)
    this.syncStream()
    return this.get(id)!
  }

  delete(id: string): void {
    this.clearTimer(id)
    const t = this.dirty.get(id)
    if (t) clearTimeout(t)
    this.dirty.delete(id)
    realtimeStore.delete(id)
    this.emit({ type: 'realtime:deleted', id })
    this.syncStream()
  }

  setStatus(id: string, status: 'running' | 'paused'): RealtimeSummary {
    const cfg = realtimeStore.getConfig(id)
    if (!cfg) throw new Error('No such real-time agent.')
    realtimeStore.saveConfig({ ...cfg, status, updatedAt: new Date().toISOString() })
    if (status === 'running') this.arm(id, FIRST_TICK_DELAY_MS)
    else {
      this.clearTimer(id)
      this.flush(id)
    }
    this.emitUpdated(id)
    this.syncStream()
    return this.get(id)!
  }

  /** Back to the allocation with an empty book; the tick log is kept. */
  resetPaper(id: string): RealtimeSummary {
    const cfg = realtimeStore.getConfig(id)
    if (!cfg) throw new Error('No such real-time agent.')
    const t = this.dirty.get(id)
    if (t) clearTimeout(t)
    this.dirty.delete(id)
    realtimeStore.saveState(id, emptyRealtimeState(cfg.allocation))
    this.emitUpdated(id)
    return this.get(id)!
  }

  /** One tick now, whatever the schedule says — the page's "Check now". */
  async tickNow(id: string): Promise<RealtimeSummary> {
    await this.tick(id, true)
    this.flush(id)
    return this.get(id)!
  }

  // ── the model key ──

  keyStatus(): RealtimeKeyStatus {
    return typesafeKey.status()
  }
  setKey(key: string): RealtimeKeyStatus {
    this.decider = null
    return typesafeKey.set(key)
  }
  clearKey(): RealtimeKeyStatus {
    this.decider = null
    return typesafeKey.clear()
  }
  async testKey(): Promise<RealtimeKeyStatus> {
    const key = typesafeKey.value()
    if (!key) return typesafeKey.status()
    try {
      const r = await testTypesafeKey(key)
      return typesafeKey.noteTest({ models: r.models })
    } catch (e) {
      return typesafeKey.noteTest({ error: redactSecrets((e as Error)?.message ?? String(e)).slice(0, 200) })
    }
  }

  // ── the stream key ──

  streamStatus(): RealtimeStreamStatus {
    const k = alpacaKey.get()
    return { ...this.streamStatusValue, configured: Boolean(k), feed: k?.feed ?? this.streamStatusValue.feed, symbols: this.stream?.symbols ?? [] }
  }
  setStreamKey(req: RealtimeStreamKeyRequest): RealtimeStreamStatus {
    const keyId = String(req.keyId ?? '').trim()
    const secret = String(req.secret ?? '').trim()
    const feed = req.feed === 'sip' || req.feed === 'test' ? req.feed : 'iex'
    if (!keyId || !secret) throw new Error('Both the key id and the secret are needed.')
    alpacaKey.set({ keyId, secret, feed })
    this.stream?.close()
    this.stream = null
    this.tapes.clear()
    this.setStreamState('off', undefined, feed)
    this.syncStream(true)
    // A feed change moves every agent's schedule (the test feed ticks off-session).
    for (const s of realtimeStore.list()) if (s.config.status === 'running') this.arm(s.config.id, FIRST_TICK_DELAY_MS)
    return this.streamStatus()
  }
  clearStreamKey(): RealtimeStreamStatus {
    alpacaKey.set(null)
    this.stream?.close()
    this.stream = null
    this.tapes.clear()
    this.setStreamState('off', 'No stream key.', 'iex')
    return this.streamStatus()
  }
  private setStreamState(state: RealtimeStreamStatus['state'], detail?: string, feed?: RealtimeStreamStatus['feed']): void {
    const prev = this.streamStatusValue
    this.streamStatusValue = { ...prev, state, detail, feed: feed ?? prev.feed, configured: Boolean(alpacaKey.get()) }
    if (prev.state !== state || prev.detail !== detail) this.emit({ type: 'realtime:stream', status: this.streamStatus() })
  }

  /** Whether this agent may tick now: the session clock, or the test feed, which prints around the clock. */
  private inSession(now: Date): boolean {
    return isRegularSession(now) || (alpacaKey.get()?.feed === 'test' && this.stream !== null)
  }

  /**
   * Open, retarget or close the ONE stream connection from what is running:
   * open while a key is stored and any agent runs in session, subscribed to
   * the union of their symbols; closed otherwise. Idempotent, called after
   * every change that could move that answer.
   */
  private syncStream(force = false): void {
    const key = alpacaKey.get()
    const running = realtimeStore.list().filter((s) => s.config.status === 'running')
    const symbols = [...new Set(running.flatMap((s) => s.config.symbols))]
    const want = Boolean(key) && symbols.length > 0 && (key?.feed === 'test' || isRegularSession(new Date()))
    if (!want) {
      const why = key ? (symbols.length ? 'Market closed — the stream opens at the bell.' : 'No running agent.') : 'No stream key.'
      if (this.stream) {
        this.stream.close()
        this.stream = null
      }
      if (this.streamStatusValue.state !== 'off' || this.streamStatusValue.detail !== why) this.setStreamState('off', why)
      return
    }
    if (!this.stream || force) {
      this.stream?.close()
      this.streamStatusValue = { ...this.streamStatusValue, trades: 0 }
      this.stream = alpacaStream({
        keyId: key!.keyId,
        secret: key!.secret,
        feed: key!.feed,
        log: (level, msg) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[realtime stream] ${msg}`),
        events: {
          trade: (symbol, t) => {
            this.tape(symbol).trade(t)
            this.streamStatusValue.trades += 1
            this.streamStatusValue.lastMessageAt = new Date().toISOString()
          },
          quote: (symbol, q) => {
            this.tape(symbol).setQuote(q)
            this.streamStatusValue.lastMessageAt = new Date().toISOString()
          },
          state: (state, detail) => this.setStreamState(state, detail)
        }
      })
    }
    this.stream.subscribe(symbols)
  }
  private tape(symbol: string): SymbolTape {
    let t = this.tapes.get(symbol)
    if (!t) {
      t = new SymbolTape(symbol)
      this.tapes.set(symbol, t)
    }
    return t
  }
  /** Fresh tape snapshots for these symbols (absent where the tape is silent or stale). */
  private tapeSnapshots(symbols: string[], now: number): Record<string, TapeSnapshot> {
    const out: Record<string, TapeSnapshot> = {}
    if (!this.stream || this.streamStatusValue.state !== 'live') return out
    for (const s of symbols) {
      const snap = this.tapes.get(s)?.snapshot(now)
      if (snap && now - snap.updatedAt <= REALTIME_TAPE_STALE_MS) out[s] = snap
    }
    return out
  }
  /** Once a second while the stream is live: the tape's last prices as one sample for the page. */
  private tapeSample(): void {
    if (!this.stream || this.streamStatusValue.state !== 'live' || this.listeners.size === 0) return
    const now = Date.now()
    const prices: Record<string, number> = {}
    for (const [symbol, tape] of this.tapes) {
      const snap = tape.snapshot(now)
      if (snap && now - snap.updatedAt <= REALTIME_TAPE_STALE_MS) prices[symbol] = snap.last
    }
    if (Object.keys(prices).length) this.emit({ type: 'realtime:price', sample: { at: new Date(now).toISOString(), prices } })
  }

  // ── the loop ──

  private clearTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
  }

  private arm(id: string, delayMs: number): void {
    this.clearTimer(id)
    const cfg = realtimeStore.getConfig(id)
    if (!cfg || cfg.status !== 'running') return
    const now = new Date()
    let delay = delayMs
    if (!this.inSession(now)) {
      // Sleep to the open, a minute at a time so a paused-then-resumed agent
      // or a system clock jump is picked up without a wake-up storm.
      const untilOpen = nextSessionOpen(now).getTime() - now.getTime()
      delay = Math.max(1_000, Math.min(OFF_SESSION_POLL_MS, untilOpen))
    }
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        const c = realtimeStore.getConfig(id)
        if (!c || c.status !== 'running') return
        this.syncStream()
        if (!this.inSession(new Date())) {
          this.arm(id, c.intervalSec * 1000)
          return
        }
        const started = Date.now()
        void this.tick(id).finally(() => {
          const after = realtimeStore.getConfig(id)
          if (!after || after.status !== 'running' || this.timers.has(id)) return
          // The next tick is due `intervalSec` after this one STARTED, so a
          // slow model call does not stretch the cadence — and never sooner
          // than 250 ms after it ended, so a slow one cannot pin the loop.
          this.arm(id, Math.max(250, started + after.intervalSec * 1000 - Date.now()))
        })
      }, delay)
    )
  }

  private async currentDecider(): Promise<Decider | null> {
    const key = typesafeKey.value()
    if (!key) return null
    if (this.decider && this.decider.key === key) return this.decider.d
    const d = await typesafeDecider(key)
    this.decider = { key, d }
    return d
  }

  private feedCache: { key: string; feed: PriceFeed } | null = null
  /** The polled side of the same Alpaca key: snapshots for symbols the tape has not printed, bars for the technicals. */
  private async priceFeed(): Promise<PriceFeed | null> {
    const k = alpacaKey.get()
    if (!k) return null
    const id = `${k.keyId}:${k.feed}`
    if (this.feedCache?.key !== id) {
      this.feedCache = {
        key: id,
        feed: alpacaFeed({ keyId: k.keyId, secretKey: k.secret, feed: k.feed === 'sip' ? 'sip' : 'iex', log: (level, msg) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[feed] ${msg}`) })
      }
    }
    return this.feedCache.feed
  }

  private async pricePoll(): Promise<void> {
    if (this.pricing || this.listeners.size === 0 || !isRegularSession(new Date())) return
    // The live tape already samples itself once a second.
    if (this.stream && this.streamStatusValue.state === 'live') return
    const running = realtimeStore.list().filter((s) => s.config.status === 'running')
    if (!running.length) return
    const symbols = [...new Set(running.flatMap((s) => s.config.symbols))]
    this.pricing = true
    try {
      const feed = await this.priceFeed()
      if (!feed) return
      const { quotes } = await feed.quotes(symbols)
      const prices = Object.fromEntries(quotes.filter((q) => q.last > 0).map((q) => [q.symbol, q.last]))
      if (Object.keys(prices).length) this.emit({ type: 'realtime:price', sample: { at: new Date().toISOString(), prices } })
    } catch (e) {
      console.warn('[realtime] price poll failed', redactSecrets((e as Error).message))
    } finally {
      this.pricing = false
    }
  }

  private async bars(feed: PriceFeed, symbols: string[], kind: 'intra' | 'day'): Promise<Record<string, Bar[]>> {
    const cache = kind === 'intra' ? this.intra : this.day
    const ttl = kind === 'intra' ? INTRA_BARS_TTL_MS : DAY_BARS_TTL_MS
    const now = Date.now()
    const stale = symbols.filter((s) => !cache.has(s) || now - cache.get(s)!.at > ttl)
    if (stale.length) {
      try {
        const start = new Date(now - (kind === 'intra' ? 4 : 90) * 86_400_000).toISOString()
        const fresh = await feed.bars(stale, start, kind === 'intra' ? '5minute' : 'day')
        for (const s of stale) cache.set(s, { at: now, bars: fresh[s] ?? cache.get(s)?.bars ?? [] })
      } catch (e) {
        console.warn(`[realtime] ${kind} bars failed`, redactSecrets((e as Error).message))
        for (const s of stale) if (!cache.has(s)) cache.set(s, { at: now - ttl + 10_000, bars: [] })
      }
    }
    return Object.fromEntries(symbols.map((s) => [s, cache.get(s)?.bars ?? []]))
  }

  /** Persist now if the book changed, else within `STATE_FLUSH_MS`. */
  private persist(id: string, state: RealtimeState, changed: boolean): void {
    realtimeStore.cacheState(id, state)
    if (changed) {
      this.flush(id)
      return
    }
    if (!this.dirty.has(id)) this.dirty.set(id, setTimeout(() => this.flush(id), STATE_FLUSH_MS))
  }
  private flush(id: string): void {
    const t = this.dirty.get(id)
    if (t) clearTimeout(t)
    this.dirty.delete(id)
    const st = realtimeStore.getState(id)
    if (st) realtimeStore.saveState(id, st)
  }

  private async tick(id: string, manual = false): Promise<void> {
    if (this.busy.has(id)) return
    const cfg = realtimeStore.getConfig(id)
    const state = realtimeStore.getState(id)
    if (!cfg || !state) return
    this.busy.add(id)
    try {
      const now = new Date()
      const regular = isRegularSession(now)
      const inSession = this.inSession(now)
      const testFeed = alpacaKey.get()?.feed === 'test'
      const tapes = this.tapeSnapshots(cfg.symbols, now.getTime())
      // Symbols the tape prices need no polled quote; the rest fall back.
      const missing = cfg.symbols.filter((s) => !tapes[s])
      let quotes: Quote[] = Object.values(tapes).map(tapeQuote)
      let failed: string[] = missing
      let intraBars: Record<string, Bar[]> = {}
      let dayBars: Record<string, Bar[]> = {}
      let sourceError: string | null = null
      const feed = await this.priceFeed()
      if (!feed && missing.length === cfg.symbols.length) sourceError = alpacaKey.get() ? 'No prices: the stream is not live and no polled source is available.' : 'No prices: add your Alpaca key below — it drives both the live stream and the polled quotes.'
      if (feed) {
        try {
          const [polled, intra, day] = await Promise.all([
            missing.length && !testFeed ? feed.quotes(missing) : Promise.resolve({ quotes: [] as Quote[], failed: missing }),
            regular ? this.bars(feed, cfg.symbols, 'intra') : Promise.resolve({}),
            regular ? this.bars(feed, cfg.symbols, 'day') : Promise.resolve({})
          ])
          quotes = [...quotes, ...polled.quotes]
          failed = polled.failed
          intraBars = intra
          dayBars = day
        } catch (e) {
          sourceError = `Quotes failed: ${redactSecrets((e as Error).message).slice(0, 200)}`
        }
      }
      const decider = await this.currentDecider().catch((e) => {
        sourceError = sourceError ?? `Model client failed: ${redactSecrets((e as Error).message).slice(0, 200)}`
        return null
      })
      const modelTimeoutMs = Math.max(MODEL_TIMEOUT_MIN_MS, Math.min(MODEL_TIMEOUT_MAX_MS, cfg.intervalSec * 800))
      const r = await runRealtimeTick({
        cfg,
        state,
        now,
        quotes,
        failed,
        intraBars,
        dayBars,
        tapes,
        decider,
        modelTimeoutMs,
        // The test feed prints around the clock: let it decide off-session too.
        sessionOpen: inSession,
        log: (level, msg) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[realtime] ${msg}`)
      })
      const next = sourceError ? { ...r.state, lastError: sourceError } : r.state
      if (sourceError) r.tick.error = r.tick.error ?? sourceError
      const changed = manual || r.tick.decisions.some((d) => d.fill) || next.buyLocked !== state.buyLocked || next.dayDate !== state.dayDate || JSON.stringify(next.exits) !== JSON.stringify(state.exits)
      this.persist(id, next, changed)
      realtimeStore.appendTick(id, r.tick)
      // The tick's own quotes as a sample stamped with the tick's instant, so
      // the chart has a point exactly where the decision cell sits.
      const prices = Object.fromEntries(quotes.filter((q) => q.last > 0).map((q) => [q.symbol, q.last]))
      if (Object.keys(prices).length) this.emit({ type: 'realtime:price', sample: { at: r.tick.at, prices } })
      const { recent: _recent, ...slim } = next
      this.emit({ type: 'realtime:tick', id, tick: r.tick, state: slim })
    } catch (e) {
      console.error('[realtime] tick failed', e)
      const msg = redactSecrets((e as Error)?.message ?? String(e)).slice(0, 300)
      realtimeStore.saveState(id, { ...state, lastError: msg, lastTickAt: new Date().toISOString() })
      this.emitUpdated(id)
    } finally {
      this.busy.delete(id)
    }
  }
}

export const realtimeEngine = new RealtimeEngine()
