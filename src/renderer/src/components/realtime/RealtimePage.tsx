import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Check, Circle, CircleAlert, KeyRound, Loader2, Pause, Play, Plus, Radio, RefreshCw, RotateCcw, Settings2, Trash2, Zap } from 'lucide-react'
import { useRealtime, type PricePoint } from '@renderer/store/realtimeStore'
import { cn, clockTime, countdown, money, relTime, signedMoney } from '@renderer/lib/format'
import { EmptyState, SectionHead } from '@renderer/components/common/Primitives'
import { Field, Segmented, Sheet } from '@renderer/components/common/Sheet'
import { formatEt, nextSessionOpen, sessionLabel, type SessionLabel } from '@shared/marketTime'
import { shortSymbol } from '@shared/tickers'
import {
  clampRealtimeGuardrails,
  isContinuousMarket,
  REALTIME_ASSET_CLASS_LABEL,
  REALTIME_STREAM_LEG_OFF,
  type AssetClass,
  type RealtimeStreamLeg,
  REALTIME_DEFAULT_INTERVAL_SEC,
  REALTIME_DEFAULTS,
  REALTIME_MAX_INTERVAL_SEC,
  REALTIME_MAX_SYMBOLS,
  REALTIME_MIN_INTERVAL_SEC,
  REALTIME_MODEL_LABEL,
  REALTIME_STREAM_FEED_LABEL,
  realtimeConfigProblem,
  realtimeDayPnl,
  realtimeEquity,
  type RealtimeConfig,
  type RealtimeGuardrails,
  type RealtimeStreamFeed,
  type RealtimeSummary,
  type RealtimeTick
} from '@shared/realtimeAgents'
import { RealtimeChart } from './RealtimeChart'
import { TickerPicker, type Picked } from './TickerPicker'
import { DecisionPanel } from './DecisionPanel'
import { Feed } from './Feed'

/**
 * Real time: a watchlist. Every stock the operator watches is a row on the
 * left — ticker, live price, the session's move, a sparkline, the position
 * if there is one — and clicking a row opens it on the right: the live price
 * as the hero, the model's current verdict with its probabilities, and a
 * dense feed of every check. Each row is its own paper agent underneath
 * (allocation, cadence, standing order, thresholds), which is what "watch a
 * stock" creates. The two keys the loop needs sit at the bottom.
 */

const RESTART_MSG = 'The app needs a restart to pick up the Real time engine — quit it and run `npm run dev` again.'
const SESSION_LABEL: Record<SessionLabel, string> = { open: 'Market open', pre: 'Pre-market', after: 'After hours', closed: 'Market closed' }

interface Clock {
  session: SessionLabel
  nextOpen: Date
  now: number
}

/** The session and the next bell, re-read every 30 s so a countdown stays honest. */
function useSession(): Clock {
  const read = (): Clock => {
    const d = new Date()
    return { session: sessionLabel(d), nextOpen: nextSessionOpen(d), now: d.getTime() }
  }
  const [s, setS] = useState(read)
  useEffect(() => {
    const t = setInterval(() => setS(read()), 30_000)
    return () => clearInterval(t)
  }, [])
  return s
}

/** "Market closed · opens Tomorrow 9:30 AM ET" — the pill's whole sentence. */
function sessionSentence(c: Clock): string {
  if (c.session === 'open') return 'Market open'
  return `${SESSION_LABEL[c.session]} · opens ${formatEt(c.nextOpen, true)}`
}

/* ───────────────────────────── the key ───────────────────────────── */

function KeyRow(): JSX.Element {
  const key = useRealtime((s) => s.key)
  const setKey = useRealtime((s) => s.setKey)
  const clearKey = useRealtime((s) => s.clearKey)
  const testKey = useRealtime((s) => s.testKey)
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const stored = Boolean(key?.hasKey)
  useEffect(() => setEditing(!stored), [stored])
  const bridgeMissing = typeof window.tb.realtime?.setKey !== 'function'
  const notice = err ?? (bridgeMissing ? RESTART_MSG : null)
  const save = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await setKey(value.trim())
      setValue('')
      setEditing(false)
      await testKey()
    } catch (e) {
      setErr(bridgeMissing ? RESTART_MSG : ((e as Error)?.message ?? String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="shrink-0 hair-t px-5 py-2 flex items-center gap-3 text-xs">
      <KeyRound size={12} className="text-muted shrink-0" />
      <span className="font-medium shrink-0">TypeSafe key</span>
      {editing ? (
        <>
          <input
            className="input mono text-xs h-7 flex-1 max-w-[420px]"
            type="password"
            autoComplete="off"
            aria-label="TypeSafe API key"
            placeholder="Paste your TypeSafe key — stored encrypted on this computer, never sent anywhere but TypeSafe"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
          <button className="btn btn-primary btn-sm" disabled={busy || !value.trim()} onClick={() => void save()}>
            Save
          </button>
          {stored && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </>
      ) : (
        <>
          <span className="pill pill-up">
            <Check size={11} /> Stored
          </span>
          {key?.testedAt && <span className={cn('truncate', key.error ? 'text-down' : 'text-muted')}>{key.error ? `Test failed: ${key.error}` : `Works — ${key.models?.length ? key.models.join(', ') : 'no models listed'} · tested ${relTime(key.testedAt)}`}</span>}
          <span className="flex-1" />
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void testKey().finally(() => setBusy(false))
            }}
          >
            <RefreshCw size={11} className={cn(busy && 'animate-spin')} /> Test
          </button>
          <button className="btn btn-ghost btn-sm text-down" onClick={() => void clearKey()}>
            Remove
          </button>
        </>
      )}
      {notice && <span className="text-down truncate">{notice}</span>}
      <button className="text-muted hover:text-text shrink-0 ml-auto" onClick={() => void window.tb.openExternal('https://docs.typesafe.ai/')}>
        Docs
      </button>
    </div>
  )
}

/* ───────────────────────────── the stream ───────────────────────────── */

const STREAM_STATE_LABEL: Record<string, string> = { off: 'Off', connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', error: 'Error' }

function StreamRow(): JSX.Element {
  const stream = useRealtime((s) => s.stream)
  const setStreamKey = useRealtime((s) => s.setStreamKey)
  const clearStreamKey = useRealtime((s) => s.clearStreamKey)
  const [editing, setEditing] = useState(false)
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [feed, setFeed] = useState<RealtimeStreamFeed>('iex')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const configured = Boolean(stream?.configured)
  useEffect(() => {
    setEditing(!configured)
    if (stream?.feed) setFeed(stream.feed)
  }, [configured, stream?.feed])
  const save = async (): Promise<void> => {
    if (!keyId.trim() || !secret.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await setStreamKey({ keyId: keyId.trim(), secret: secret.trim(), feed })
      setKeyId('')
      setSecret('')
      setEditing(false)
    } catch (e) {
      setErr(((e as Error)?.message ?? String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const state = stream?.state ?? 'off'
  const crypto = stream?.crypto ?? REALTIME_STREAM_LEG_OFF
  return (
    <div className="shrink-0 hair-t px-5 py-2 flex items-center gap-3 text-xs">
      <Radio size={12} className={cn('shrink-0', state === 'live' || crypto.state === 'live' ? 'text-up' : 'text-muted')} />
      <span className="font-medium shrink-0">Live data stream</span>
      {editing ? (
        <>
          <input className="input mono text-xs h-7 w-44" autoComplete="off" aria-label="Alpaca key id" placeholder="Key id" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
          <input
            className="input mono text-xs h-7 w-56"
            type="password"
            autoComplete="off"
            aria-label="Alpaca secret"
            placeholder="Secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
          <select className="select text-xs h-7" aria-label="Feed" value={feed} onChange={(e) => setFeed(e.target.value as RealtimeStreamFeed)}>
            {(Object.keys(REALTIME_STREAM_FEED_LABEL) as RealtimeStreamFeed[]).map((f) => (
              <option key={f} value={f}>
                {REALTIME_STREAM_FEED_LABEL[f]}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" disabled={busy || !keyId.trim() || !secret.trim()} onClick={() => void save()}>
            Save
          </button>
          {configured && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          <span className="text-muted truncate">Your own Alpaca Market Data key, stored encrypted on this computer. IEX is free and real time; Test prints a fake symbol 24/7.</span>
        </>
      ) : (
        <>
          <span className={cn('pill', state === 'live' ? 'pill-up' : state === 'error' ? 'pill-warn' : '')}>{STREAM_STATE_LABEL[state] ?? state}</span>
          <span className="text-muted truncate">
            {REALTIME_STREAM_FEED_LABEL[stream?.feed ?? 'iex']}
            {state === 'live' && stream ? ` · ${stream.symbols.join(' ')} · ${stream.trades.toLocaleString('en-US')} prints` : stream?.detail ? ` · ${stream.detail}` : ''}
          </span>
          {crypto.state !== 'off' || crypto.symbols.length ? (
            <>
              <span className="text-text-3">·</span>
              <span className={cn('pill', crypto.state === 'live' ? 'pill-up' : crypto.state === 'error' ? 'pill-warn' : '')}>Crypto {STREAM_STATE_LABEL[crypto.state] ?? crypto.state}</span>
              <span className="text-muted truncate">{crypto.state === 'live' ? `${crypto.symbols.join(' ')} · ${crypto.trades.toLocaleString('en-US')} prints` : (crypto.detail ?? '')}</span>
            </>
          ) : null}
          <span className="flex-1" />
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button className="btn btn-ghost btn-sm text-down" onClick={() => void clearStreamKey()}>
            Remove
          </button>
        </>
      )}
      {err && <span className="text-down truncate">{err}</span>}
      <button className="text-muted hover:text-text shrink-0 ml-auto" onClick={() => void window.tb.openExternal('https://alpaca.markets/')}>
        Get a free key
      </button>
    </div>
  )
}

/* ───────────────────────────── the form ───────────────────────────── */

interface FormState {
  name: string
  symbols: string
  /** What the picker chose; the class rides to the engine on create. */
  picked: Picked | null
  allocation: string
  intervalSec: number
  style: string
  g: RealtimeGuardrails
}

const INTERVALS = [1, 2, 5, 10, 15, 30, 60].filter((n) => n >= REALTIME_MIN_INTERVAL_SEC && n <= REALTIME_MAX_INTERVAL_SEC)
const NO_TICKS: RealtimeTick[] = []

function fromConfig(cfg?: RealtimeConfig): FormState {
  return {
    name: cfg?.name ?? '',
    symbols: cfg?.symbols.join(', ') ?? '',
    picked: cfg ? { symbol: cfg.symbols[0] ?? '', kind: kindOf(cfg), name: '' } : null,
    allocation: String(cfg?.allocation ?? 5000),
    intervalSec: cfg?.intervalSec ?? REALTIME_DEFAULT_INTERVAL_SEC,
    style: cfg?.style ?? '',
    g: cfg ? { ...cfg.guardrails } : { ...REALTIME_DEFAULTS }
  }
}

function NumberField({ label, hint, value, onChange, step = 0.1, min, max, suffix, nullable }: { label: string; hint?: string; value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; suffix?: string; nullable?: boolean }): JSX.Element {
  return (
    <label className="flex items-center gap-3 px-4 py-2 min-h-[var(--h-row)]">
      <span className="min-w-0 flex-1">
        <span className="block text-base">{label}</span>
        {hint && <span className="hint block mt-0.5">{hint}</span>}
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <input
          type="number"
          className="input w-24 nums text-right"
          step={step}
          min={min}
          max={max}
          placeholder={nullable ? 'off' : undefined}
          value={value === null ? '' : value}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '' && nullable) return onChange(null)
            const n = Number(raw)
            if (Number.isFinite(n)) onChange(n)
          }}
        />
        {suffix && <span className="text-xs text-muted w-5">{suffix}</span>}
      </span>
    </label>
  )
}

function TimeField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="flex items-center gap-3 px-4 py-2 min-h-[var(--h-row)]">
      <span className="min-w-0 flex-1">
        <span className="block text-base">{label}</span>
        {hint && <span className="hint block mt-0.5">{hint}</span>}
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <input type="time" className="input w-28 nums" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="text-xs text-muted w-5">ET</span>
      </span>
    </label>
  )
}

function AgentForm({ existing, onClose }: { existing?: RealtimeConfig; onClose: () => void }): JSX.Element {
  const createAgent = useRealtime((s) => s.create)
  const updateAgent = useRealtime((s) => s.update)
  const [f, setF] = useState<FormState>(() => fromConfig(existing))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<FormState>): void => setF((prev) => ({ ...prev, ...patch }))
  const setG = (patch: Partial<RealtimeGuardrails>): void => setF((prev) => ({ ...prev, g: { ...prev.g, ...patch } }))
  const symbols = f.symbols.split(/[\s,]+/).filter(Boolean)
  const allocation = Number(f.allocation)
  const kind: AssetClass = f.picked?.kind ?? (existing ? kindOf(existing) : 'stocks')
  const continuous = isContinuousMarket(kind)
  const name = f.name.trim() || (f.picked ? shortSymbol(f.picked) : symbols[0]) || ''
  const problem = realtimeConfigProblem({ name, symbols, allocation: existing ? undefined : allocation, intervalSec: f.intervalSec, assetClass: kind })
  const submit = async (): Promise<void> => {
    if (problem) return setError(problem)
    setBusy(true)
    try {
      const g = clampRealtimeGuardrails(f.g)
      const err = existing
        ? await updateAgent(existing.id, { name, symbols, intervalSec: f.intervalSec, style: f.style, guardrails: g })
        : await createAgent({ name, symbols, allocation, intervalSec: f.intervalSec, style: f.style, guardrails: g, assetClass: kind })
      if (err) setError(err)
      else onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      title={existing ? `Settings · ${existing.symbols.join(' ')}` : 'Watch a ticker'}
      onClose={onClose}
      width={520}
      footer={
        <div className="flex items-center gap-2">
          <span className="text-xs text-down flex-1 min-w-0 leading-snug" title={error ?? problem ?? undefined}>
            {error ?? (f.symbols ? problem : '')}
          </span>
          <button className="btn btn-ghost shrink-0" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary shrink-0" disabled={busy || Boolean(problem)} onClick={() => void submit()}>
            {existing ? 'Save' : 'Watch'}
          </button>
        </div>
      }
    >
      {existing ? (
        <Field label="Ticker" hint="Fixed for this row. Watch another with the button in the header.">
          <input className="input mono text-lg" value={f.symbols} readOnly aria-label="Ticker" />
        </Field>
      ) : (
        <Field label="What to watch" hint="Tap a chip, or search by ticker or company name. One row per name.">
          <TickerPicker value={f.picked} onPick={(p) => set({ picked: p, symbols: p.symbol })} />
        </Field>
      )}
      <Field label="Label" hint="Optional. Defaults to the ticker.">
        <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={f.picked ? shortSymbol(f.picked) : symbols[0] || 'NVDA'} aria-label="Label" />
      </Field>
      {!existing && (
        <Field label="Paper allocation" hint="Simulated money. A position is sized from this and the per-symbol limit below.">
          <div className="flex items-center gap-2">
            <span className="text-muted">$</span>
            <input type="number" className="input w-40 nums" min={100} step={100} value={f.allocation} onChange={(e) => set({ allocation: e.target.value })} aria-label="Allocation" />
          </div>
        </Field>
      )}
      <Field label="Check every" hint="How often it re-reads the tape and asks the model. One second needs the live stream; quiet ticks (no price change) skip the model.">
        <Segmented value={String(f.intervalSec)} onChange={(v) => set({ intervalSec: Number(v) })} options={INTERVALS.map((n) => ({ value: String(n), label: `${n}s` }))} />
      </Field>
      <Field label="Standing order" hint="One or two sentences the model judges for. Leave blank for disciplined intraday momentum.">
        <textarea className="input min-h-[64px] resize-y" value={f.style} onChange={(e) => set({ style: e.target.value })} placeholder="Buy breakouts above the opening range on heavy volume; take profits quickly; never chase an extended spike." aria-label="Standing order" />
      </Field>

      <SectionHead title="Exits the engine enforces" hint={continuous ? 'Checked in code on every tick, before the model is asked. The model cannot move them. Crypto trades around the clock, so nothing is flattened for a close.' : 'Checked in code on every tick, before the model is asked. The model cannot move them.'} className="mt-6" />
      <div className="card overflow-hidden divide-hair mb-5">
        <NumberField label="Stop-loss" value={f.g.stopLossPct} onChange={(v) => setG({ stopLossPct: v ?? REALTIME_DEFAULTS.stopLossPct })} suffix="%" min={0.1} max={20} />
        <NumberField label="Take-profit" value={f.g.takeProfitPct} onChange={(v) => setG({ takeProfitPct: v ?? REALTIME_DEFAULTS.takeProfitPct })} suffix="%" min={0.1} max={50} />
        <NumberField label="Trailing stop" hint="Below the high since entry. Blank turns it off." value={f.g.trailPct} onChange={(v) => setG({ trailPct: v })} suffix="%" min={0.1} max={20} nullable />
        {!continuous && <TimeField label="Flatten everything at" hint="Out at market whatever the price — nothing is held into the close." value={f.g.flattenAt} onChange={(v) => setG({ flattenAt: v })} />}
      </div>

      <SectionHead title="Entries" hint={continuous ? 'When a buy verdict may become an order. No session windows — crypto never closes.' : 'When a buy verdict may become an order.'} />
      <div className="card overflow-hidden divide-hair mb-5">
        <NumberField label="Max position per symbol" hint="As a share of the allocation." value={f.g.maxPositionPct} onChange={(v) => setG({ maxPositionPct: v ?? REALTIME_DEFAULTS.maxPositionPct })} suffix="%" step={1} min={1} max={100} />
        {!continuous && <TimeField label="No entries before" value={f.g.noEntriesBeforeEt} onChange={(v) => setG({ noEntriesBeforeEt: v })} />}
        {!continuous && <TimeField label="No entries after" value={f.g.noEntriesAfterEt} onChange={(v) => setG({ noEntriesAfterEt: v })} />}
        <NumberField label="Max above VWAP" hint="A buy further above VWAP than this is refused as chasing. Blank turns it off." value={f.g.maxEntryExtensionPct} onChange={(v) => setG({ maxEntryExtensionPct: v })} suffix="%" min={0.1} max={20} nullable />
        <NumberField label="Re-entry cooldown" hint="After a sell in the same symbol." value={f.g.reentryCooldownMin} onChange={(v) => setG({ reentryCooldownMin: v ?? REALTIME_DEFAULTS.reentryCooldownMin })} suffix="min" step={1} min={0} max={240} />
        <NumberField label="Day loss lock" hint="Down this much of the allocation on the day and buys stop until tomorrow. Sells and exits keep working." value={f.g.maxDailyLossPct} onChange={(v) => setG({ maxDailyLossPct: v ?? REALTIME_DEFAULTS.maxDailyLossPct })} suffix="%" min={0.1} max={50} />
      </div>

      <SectionHead title="Thresholds" hint="The model returns a probability for each answer. Code acts only past these." />
      <div className="card overflow-hidden divide-hair mb-2">
        <NumberField label="Buy when P(buy) ≥" value={f.g.buyThreshold} onChange={(v) => setG({ buyThreshold: v ?? REALTIME_DEFAULTS.buyThreshold })} step={0.05} min={0.5} max={0.99} />
        <NumberField label="Sell when P(sell) ≥" value={f.g.sellThreshold} onChange={(v) => setG({ sellThreshold: v ?? REALTIME_DEFAULTS.sellThreshold })} step={0.05} min={0.5} max={0.99} />
        <NumberField label="Sell on reversal ≥" hint="A separate yes/no question about a sharp reversal against the position; this alone closes it." value={f.g.reversalThreshold} onChange={(v) => setG({ reversalThreshold: v ?? REALTIME_DEFAULTS.reversalThreshold })} step={0.05} min={0.5} max={0.99} />
      </div>
    </Sheet>
  )
}

/* ───────────────────────────── readiness ───────────────────────────── */

interface Step {
  ok: boolean
  busy?: boolean
  warn?: boolean
  title: string
  detail: string
}

/**
 * What the chart shows before there is a price: the three things a check
 * needs, each with its state, the missing one named first. A blank "waiting
 * for the first price…" told the operator nothing about what to do; this
 * tells them, and counts down to the bell when that is the answer.
 */
function Readiness({ symbol, clock, continuous }: { symbol: string; clock: Clock; continuous: boolean }): JSX.Element {
  const key = useRealtime((s) => s.key)
  const stream = useRealtime((s) => s.stream)
  // Two sockets on one key: stocks (IEX/SIP/test) and crypto, which the
  // engine also serves keyless from the public feed — so a crypto row is
  // never blocked by a missing key, only slower.
  const leg: RealtimeStreamLeg = (continuous ? stream?.crypto : stream) ?? REALTIME_STREAM_LEG_OFF
  const streamState = leg.state
  const test = !continuous && stream?.feed === 'test'
  const tape: Step =
    streamState === 'live'
      ? { ok: true, title: 'Live tape', detail: `Stream live · ${continuous ? 'crypto' : (stream?.feed ?? 'iex').toUpperCase()}${leg.trades ? ` · ${leg.trades.toLocaleString('en-US')} prints` : ''}` }
      : streamState === 'error'
        ? { ok: false, warn: true, title: 'Live tape', detail: `Stream error — ${leg.detail ?? 'see the row below'}` }
        : streamState === 'connecting' || streamState === 'reconnecting'
          ? { ok: false, busy: true, title: 'Live tape', detail: `${streamState === 'connecting' ? 'Connecting' : 'Reconnecting'} to the stream…` }
          : continuous
            ? { ok: true, title: 'Live tape', detail: leg.detail ?? 'Polled from the public crypto feed every few seconds. Add your Alpaca key below for a live tape.' }
            : !stream?.configured
              ? { ok: false, title: 'Live tape', detail: 'Add your Alpaca Market Data key in the row below. The free plan streams IEX in real time; the Test feed prints a fake symbol around the clock.' }
              : { ok: false, title: 'Live tape', detail: leg.detail ?? 'Stream off.' }
  const steps: Step[] = [
    key?.hasKey
      ? { ok: true, warn: Boolean(key.error), title: 'Model', detail: key.error ? `TypeSafe key stored — the last test failed: ${key.error}` : `TypeSafe key stored${key.models?.[0] ? ` · ${key.models[0]}` : ''}` }
      : { ok: false, title: 'Model', detail: 'Add your TypeSafe key in the bottom row. Without it the engine still enforces exits but makes no new decisions.' },
    tape,
    continuous || clock.session === 'open' || (test && streamState === 'live')
      ? { ok: true, title: 'Market', detail: continuous ? 'Trades around the clock' : clock.session === 'open' ? 'Regular session open' : 'Test feed — checks run around the clock' }
      : { ok: false, title: 'Market', detail: `${SESSION_LABEL[clock.session]} — opens ${formatEt(clock.nextOpen, true)}, in ${countdown(clock.nextOpen.toISOString(), clock.now)}.` }
  ]
  const missing = steps.find((st) => !st.ok)
  const headline = missing ? (missing.busy ? `${symbol} is connecting` : `${symbol} is waiting`) : `${symbol} is live`
  const sub = !missing
    ? `Waiting for the first print of ${symbol}.`
    : missing.title === 'Market'
      ? 'Every check needs the tape, and the tape starts at the bell. The first price lands here the moment it opens.'
      : missing.busy
        ? 'The first price lands here the moment the stream is up.'
        : 'One thing to do before it can check.'
  const closedHint = !continuous && clock.session !== 'open' && !test && Boolean(stream?.configured) && streamState !== 'error'
  const kindLabel = continuous ? 'crypto' : 'stock'
  return (
    <div className="max-w-[520px] w-full px-8 pointer-events-auto">
      <div className="flex items-center gap-2.5 mb-1">
        <span className={cn('h-2 w-2 rounded-full shrink-0', missing ? (missing.busy ? 'bg-accent' : 'bg-text-3') : 'bg-up')} aria-hidden />
        <h3 className="text-lg font-semibold tracking-[-0.01em] text-text">{headline}</h3>
      </div>
      <p className="text-sm text-muted mb-5 leading-relaxed">
        {sub} <span className="text-text-3">Watching one {kindLabel}.</span>
      </p>
      <div className="card divide-hair text-left">
        {steps.map((st) => (
          <div key={st.title} className="flex items-start gap-3 px-4 py-3">
            <span className={cn('mt-0.5 shrink-0', st.ok ? (st.warn ? 'text-warn' : 'text-up') : st.warn ? 'text-down' : st.busy ? 'text-accent' : 'text-text-3')}>
              {st.ok ? <Check size={15} /> : st.warn ? <CircleAlert size={15} /> : st.busy ? <Loader2 size={15} className="animate-spin" /> : <Circle size={15} />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text">{st.title}</span>
              <span className="block text-xs text-muted mt-0.5 leading-relaxed">{st.detail}</span>
            </span>
          </div>
        ))}
      </div>
      {closedHint && (
        <p className="text-xs text-text-3 mt-3 leading-relaxed">
          To watch it decide now, save the same key with the <span className="text-muted">Test</span> feed: fake prints, 24/7, paper money.
        </p>
      )}
    </div>
  )
}

/* ───────────────────────────── the watchlist ───────────────────────────── */

/** A row's identity: the agent underneath and the symbol shown. Rows are per symbol, so an older multi-symbol agent still lists each of its names. */
interface WatchKey {
  id: string
  symbol: string
}

/** What a row trades. The store defaults configs written before the field to stocks. */
const kindOf = (cfg: RealtimeConfig): AssetClass => cfg.assetClass ?? 'stocks'

const SPARK_N = 90

function Sparkline({ points, tone }: { points: PricePoint[]; tone: 'up' | 'down' | 'muted' }): JSX.Element | null {
  const pts = points.slice(-SPARK_N)
  if (pts.length < 2) return null
  const w = 72
  const h = 22
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    if (p.p < lo) lo = p.p
    if (p.p > hi) hi = p.p
  }
  const range = hi - lo || 1
  const d = pts.map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 1 - ((p.p - lo) / range) * (h - 2)).toFixed(1)}`).join(' ')
  const color = tone === 'up' ? 'var(--color-up)' : tone === 'down' ? 'var(--color-down)' : 'var(--color-muted)'
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** The session's move for a symbol: the last sample against the first, once there are two. */
function sessionChange(points: PricePoint[]): number | null {
  if (points.length < 2) return null
  const a = points[0].p
  const b = points[points.length - 1].p
  return a > 0 ? ((b - a) / a) * 100 : null
}

function WatchRow({ s, symbol, points, active, onSelect }: { s: RealtimeSummary; symbol: string; points: PricePoint[]; active: boolean; onSelect: () => void }): JSX.Element {
  const { config, state } = s
  const last = points[points.length - 1]?.p ?? state.lastQuotes[symbol] ?? null
  const change = sessionChange(points)
  const position = state.ledger.positions.find((p) => p.symbol === symbol) ?? null
  const upnl = position && last ? (last - position.avgCost) * position.qty : null
  const running = config.status === 'running'
  const tone: 'up' | 'down' | 'muted' = change === null ? 'muted' : change >= 0 ? 'up' : 'down'
  return (
    <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined} className={cn('w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg', active ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="mono text-base font-semibold tracking-[-0.01em]">{symbol}</span>
          {!running && <span className="pill">Paused</span>}
          {state.buyLocked && <span className="pill pill-warn">Locked</span>}
        </span>
        <span className="block text-xs text-muted truncate mt-0.5">
          {position ? (
            <>
              long {position.qty} @ {money(position.avgCost)}
              {upnl !== null && <span className={cn('ml-1.5 font-medium', upnl >= 0 ? 'text-up' : 'text-down')}>{signedMoney(upnl)}</span>}
            </>
          ) : (
            `${REALTIME_ASSET_CLASS_LABEL[kindOf(config)]} · ${money(config.allocation, 0)} paper · every ${config.intervalSec}s${config.name !== symbol ? ` · ${config.name}` : ''}`
          )}
        </span>
      </span>
      <Sparkline points={points} tone={tone} />
      <span className="text-right shrink-0 w-[72px]">
        <span className="block mono text-sm nums">{last !== null ? money(last) : '—'}</span>
        <span className={cn('inline-block mt-0.5 rounded px-1.5 py-px text-2xs nums font-medium', change === null ? 'text-text-3' : change >= 0 ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
          {change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
        </span>
      </span>
    </button>
  )
}

function WatchList({ rows, active, onSelect, onNew }: { rows: { s: RealtimeSummary; symbol: string }[]; active: WatchKey | null; onSelect: (k: WatchKey) => void; onNew: () => void }): JSX.Element {
  const samples = useRealtime((x) => x.samples)
  const held = rows.filter((r) => r.s.state.ledger.positions.some((p) => p.symbol === r.symbol))
  const flat = rows.filter((r) => !held.includes(r))
  const stocks = flat.filter((r) => kindOf(r.s.config) === 'stocks')
  const crypto = flat.filter((r) => kindOf(r.s.config) === 'crypto')
  const section = (title: string, list: typeof rows): JSX.Element | null =>
    list.length ? (
      <div className="mb-3">
        <div className="eyebrow px-3 pb-1.5">{title}</div>
        {list.map((r) => (
          <WatchRow key={`${r.s.config.id}:${r.symbol}`} s={r.s} symbol={r.symbol} points={samples[r.symbol] ?? []} active={active?.id === r.s.config.id && active.symbol === r.symbol} onSelect={() => onSelect({ id: r.s.config.id, symbol: r.symbol })} />
        ))}
      </div>
    ) : null
  return (
    <aside className="panel w-[300px] shrink-0 min-h-0 flex flex-col hair-r">
      <div className="flex-1 min-h-0 overflow-y-auto py-3 px-2">
        {rows.length === 0 ? (
          <EmptyState icon={<Activity size={18} />} title="Nothing watched yet" body="Pick a ticker, a paper allocation and a cadence. The model answers up, down or flat on every check; the engine enforces the stops." action={<button className="btn btn-primary btn-sm" onClick={onNew}>Watch a stock</button>} />
        ) : (
          <>
            {section('Positions', held)}
            {section('Stocks', stocks)}
            {section('Crypto', crypto)}
          </>
        )}
      </div>
    </aside>
  )
}

/* ───────────────────────────── the detail ───────────────────────────── */

function Dashboard({ s, symbol, clock, onEdit }: { s: RealtimeSummary; symbol: string; clock: Clock; onEdit: () => void }): JSX.Element {
  const setStatus = useRealtime((x) => x.setStatus)
  const resetPaper = useRealtime((x) => x.resetPaper)
  const tickNow = useRealtime((x) => x.tickNow)
  const remove = useRealtime((x) => x.remove)
  const samples = useRealtime((x) => x.samples)
  const pageTicks = useRealtime((x) => x.ticks[s.config.id]) ?? NO_TICKS
  const key = useRealtime((x) => x.key)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null)
  const { config, state } = s
  const { equity } = realtimeEquity(state)
  const day = realtimeDayPnl(state)
  const running = config.status === 'running'
  const ticks = pageTicks.length ? pageTicks : state.recent
  const latencies = useMemo(() => ticks.map((t) => t.latencyMs).filter((n): n is number => typeof n === 'number'), [ticks])
  const lastLat = latencies.length ? latencies[latencies.length - 1] : null
  const avgLat = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null
  const fillsToday = state.ledger.fills.filter((f) => f.ts.slice(0, 10) === (state.dayDate ?? '')).length
  const firstToday = ticks.find((t) => t.at.slice(0, 10) === state.dayDate)?.at ?? null
  const latest = useMemo(() => {
    for (let i = ticks.length - 1; i >= 0; i--) {
      const d = ticks[i].decisions.find((x) => x.symbol === symbol)
      if (d) return d
    }
    return null
  }, [ticks, symbol])
  const position = state.ledger.positions.find((p) => p.symbol === symbol) ?? null
  const exit = state.exits[symbol] ?? null
  const effectiveStop = exit ? Math.max(exit.stop, config.guardrails.trailPct !== null ? exit.high * (1 - config.guardrails.trailPct / 100) : 0) : null
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="shrink-0 px-5 pt-3 pb-2 flex items-center gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <h2 className="mono text-xl font-semibold tracking-[-0.01em]">{symbol}</h2>
          {config.name !== symbol && <span className="text-sm text-muted truncate">{config.name}</span>}
          <span className={cn('pill', running ? 'pill-up' : '')}>{running ? 'Running' : 'Paused'}</span>
          <span className="pill pill-paper">Paper</span>
          {state.buyLocked && <span className="pill pill-warn">Buys locked</span>}
        </div>
        <span className="flex-1" />
        {confirm === 'reset' ? (
          <>
            <span className="text-xs text-muted">Reset the book to {money(config.allocation)}?</span>
            <button className="btn btn-danger btn-sm" onClick={() => void run(() => resetPaper(config.id)).then(() => setConfirm(null))}>
              Reset
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              Keep
            </button>
          </>
        ) : confirm === 'delete' ? (
          <>
            <span className="text-xs text-muted">Stop watching {symbol} and delete its log?</span>
            <button className="btn btn-danger-solid btn-sm" onClick={() => void run(() => remove(config.id))}>
              Delete
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void run(() => setStatus(config.id, running ? 'paused' : 'running'))}>
              {running ? <Pause size={12} /> : <Play size={12} />} {running ? 'Pause' : 'Resume'}
            </button>
            <button className="btn btn-outline btn-sm" disabled={busy} title="One check now, whatever the schedule says" onClick={() => void run(() => tickNow(config.id))}>
              <Zap size={12} /> Check now
            </button>
            <button className="btn-icon" title="Settings" aria-label="Settings" onClick={onEdit}>
              <Settings2 size={15} />
            </button>
            <button className="btn-icon" title="Reset the paper book" aria-label="Reset the paper book" onClick={() => setConfirm('reset')}>
              <RotateCcw size={15} />
            </button>
            <button className="btn-icon text-down" title="Stop watching" aria-label="Stop watching" onClick={() => setConfirm('delete')}>
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>

      <div className="shrink-0 px-5 pb-2.5 flex items-center gap-5 text-xs text-text-3 nums whitespace-nowrap">
        {lastLat !== null && <span>last {Math.round(lastLat)} ms</span>}
        {avgLat !== null && <span>avg {avgLat} ms</span>}
        {state.modelCalls > 0 && <span>{state.modelCalls} calls</span>}
        {state.ledger.fills.length > 0 && <span>{state.ledger.fills.length} fills</span>}
        {state.ticksToday > 0 && <span>{state.ticksToday} checks today</span>}
        <span>every {config.intervalSec}s</span>
        {!key?.hasKey && <span className="text-warn">no TypeSafe key — exits enforced, no new decisions</span>}
        {state.lastError && key?.hasKey && <span className="text-down truncate">{state.lastError}</span>}
        <span className="flex-1" />
        <span className="text-text">{money(equity)}</span>
        <span className={cn(state.ledger.realizedPnl > 0 ? 'text-up' : state.ledger.realizedPnl < 0 ? 'text-down' : '')}>realized {signedMoney(state.ledger.realizedPnl)}</span>
        <span className={cn(day === null ? '' : day > 0 ? 'text-up' : day < 0 ? 'text-down' : '')}>day {day === null ? '—' : signedMoney(day)}</span>
        {fillsToday > 0 && <span>{fillsToday} fills today</span>}
        <span>{firstToday ? `since ${clockTime(firstToday)}` : state.lastTickAt ? `last check ${relTime(state.lastTickAt)}` : 'no checks yet'}</span>
      </div>

      <div className="flex-1 min-h-0 flex gap-4 px-5 pb-4">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <RealtimeChart
            symbol={symbol}
            points={samples[symbol] ?? []}
            ticks={ticks}
            position={position}
            exit={exit}
            effectiveStop={effectiveStop}
            dayPnl={day}
            allocation={config.allocation}
            empty={<Readiness symbol={symbol} clock={clock} continuous={kindOf(config) === 'crypto'} />}
          />
        </div>
        <div className="w-[400px] shrink-0 min-h-0 flex flex-col card overflow-hidden">
          <div className="shrink-0">
            <DecisionPanel config={config} symbol={symbol} latest={latest} state={state} />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <Feed ticks={ticks} symbol={symbol} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── the page ───────────────────────────── */

const SELECTED_SYMBOL_KEY = 'rt:selected-symbol'

export function RealtimePage(): JSX.Element {
  const booted = useRealtime((s) => s.booted)
  const boot = useRealtime((s) => s.boot)
  const agents = useRealtime((s) => s.agents)
  const order = useRealtime((s) => s.order)
  const selectedId = useRealtime((s) => s.selectedId)
  const select = useRealtime((s) => s.select)
  const key = useRealtime((s) => s.key)
  const stream = useRealtime((s) => s.stream)
  const clock = useSession()
  const [symbolSel, setSymbolSel] = useState<string | null>(() => localStorage.getItem(SELECTED_SYMBOL_KEY))
  const [sheet, setSheet] = useState<{ kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string }>({ kind: 'none' })
  useEffect(() => {
    void boot()
  }, [boot])
  const rows = useMemo(() => order.flatMap((id) => (agents[id] ? agents[id].config.symbols.map((symbol) => ({ s: agents[id], symbol })) : [])), [agents, order])
  // The active row: the store's agent plus a symbol of it; anything stale falls back to the first row.
  const active: WatchKey | null = useMemo(() => {
    const own = rows.find((r) => r.s.config.id === selectedId && r.symbol === symbolSel) ?? rows.find((r) => r.s.config.id === selectedId) ?? rows[0]
    return own ? { id: own.s.config.id, symbol: own.symbol } : null
  }, [rows, selectedId, symbolSel])
  const onSelect = (k: WatchKey): void => {
    select(k.id)
    setSymbolSel(k.symbol)
    localStorage.setItem(SELECTED_SYMBOL_KEY, k.symbol)
  }
  const selected = active ? agents[active.id] : undefined
  const model = key?.models?.[0] ?? null
  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-bg">
      <header className="drag h-[var(--h-header)] shrink-0 flex items-center gap-3 px-5 hair-b">
        <div className="min-w-0 no-drag">
          <div className="text-lg font-semibold tracking-[-0.01em] leading-tight">Real time</div>
          <div className="text-xs text-muted">Paper, on a live tape, decided every second by {REALTIME_MODEL_LABEL}</div>
        </div>
        <span className="flex-1" />
        <span className={cn('pill no-drag', clock.session === 'open' ? 'pill-up' : '')} title={clock.session === 'open' ? undefined : `Opens in ${countdown(clock.nextOpen.toISOString(), clock.now)}`}>
          {sessionSentence(clock)}
        </span>
        {(stream?.state === 'live' || stream?.crypto.state === 'live') && (
          <span className="pill pill-up no-drag">
            {stream.state === 'live' && stream.crypto.state === 'live' ? 'Streams live' : stream.crypto.state === 'live' ? 'Crypto live' : 'Stream live'}
          </span>
        )}
        <span className={cn('pill no-drag', model ? 'pill-accent' : key?.hasKey ? '' : 'pill-warn')} title={model ? 'The model the stored key can use' : undefined}>
          {model ?? (key?.hasKey ? 'key stored' : 'no model key')}
        </span>
        <button className="btn btn-primary btn-sm no-drag" onClick={() => setSheet({ kind: 'new' })}>
          <Plus size={13} /> Watch a stock
        </button>
      </header>
      <div className="flex-1 min-h-0 flex">
        <WatchList rows={rows} active={active} onSelect={onSelect} onNew={() => setSheet({ kind: 'new' })} />
        {selected && active ? (
          <Dashboard key={`${active.id}:${active.symbol}`} s={selected} symbol={active.symbol} clock={clock} onEdit={() => setSheet({ kind: 'edit', id: active.id })} />
        ) : (
          <div className="flex-1 min-w-0 flex items-center justify-center">
            <EmptyState icon={<Activity size={18} />} title={booted ? 'Pick a stock' : 'Loading…'} body={booted ? 'Watch a stock to see its live price, the model’s verdicts and every check it makes.' : undefined} />
          </div>
        )}
      </div>
      <StreamRow />
      <KeyRow />
      {sheet.kind === 'new' && <AgentForm onClose={() => setSheet({ kind: 'none' })} />}
      {sheet.kind === 'edit' && agents[sheet.id] && <AgentForm existing={agents[sheet.id].config} onClose={() => setSheet({ kind: 'none' })} />}
    </section>
  )
}
