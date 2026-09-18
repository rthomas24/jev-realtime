import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Check, KeyRound, Pause, Play, Plus, Radio, RefreshCw, RotateCcw, Settings2, Trash2, Zap } from 'lucide-react'
import { useRealtime } from '@renderer/store/realtimeStore'
import { cn, clockTime, money, relTime, signedMoney } from '@renderer/lib/format'
import { EmptyState, SectionHead } from '@renderer/components/common/Primitives'
import { Field, Segmented, Sheet } from '@renderer/components/common/Sheet'
import { sessionLabel, type SessionLabel } from '@shared/marketTime'
import {
  clampRealtimeGuardrails,
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
import { DecisionPanel } from './DecisionPanel'
import { Feed } from './Feed'

/**
 * Real time: paper agents on this computer, checked every few seconds through
 * the session and decided by the System One model. One dashboard per agent —
 * the live price of one of its symbols as the hero, the model's current
 * verdict with its probabilities beside it, and a dense feed of every check —
 * with the fleet as a strip of chips above and the two keys below: the
 * market-data stream and the model.
 */

const RESTART_MSG = 'The app needs a restart to pick up the Real time engine — quit it and run `npm run dev` again.'
const SESSION_LABEL: Record<SessionLabel, string> = { open: 'Market open', pre: 'Pre-market', after: 'After hours', closed: 'Market closed' }

function useSession(): SessionLabel {
  const [s, setS] = useState<SessionLabel>(() => sessionLabel(new Date()))
  useEffect(() => {
    const t = setInterval(() => setS(sessionLabel(new Date())), 15_000)
    return () => clearInterval(t)
  }, [])
  return s
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
  return (
    <div className="shrink-0 hair-t px-5 py-2 flex items-center gap-3 text-xs">
      <Radio size={12} className={cn('shrink-0', state === 'live' ? 'text-up' : 'text-muted')} />
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
          <span className="text-muted truncate">Your own Alpaca Market Data key (free plan streams IEX in real time); stored encrypted on this computer.</span>
        </>
      ) : (
        <>
          <span className={cn('pill', state === 'live' ? 'pill-up' : state === 'error' ? 'pill-warn' : '')}>{STREAM_STATE_LABEL[state] ?? state}</span>
          <span className="text-muted truncate">
            {REALTIME_STREAM_FEED_LABEL[stream?.feed ?? 'iex']}
            {state === 'live' && stream ? ` · ${stream.symbols.join(' ')} · ${stream.trades.toLocaleString('en-US')} prints` : stream?.detail ? ` · ${stream.detail}` : ''}
          </span>
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
  const problem = realtimeConfigProblem({ name: f.name, symbols, allocation: existing ? undefined : allocation, intervalSec: f.intervalSec })
  const submit = async (): Promise<void> => {
    if (problem) return setError(problem)
    setBusy(true)
    try {
      const g = clampRealtimeGuardrails(f.g)
      const err = existing
        ? await updateAgent(existing.id, { name: f.name, symbols, intervalSec: f.intervalSec, style: f.style, guardrails: g })
        : await createAgent({ name: f.name, symbols, allocation, intervalSec: f.intervalSec, style: f.style, guardrails: g })
      if (err) setError(err)
      else onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      title={existing ? 'Real-time agent settings' : 'New real-time agent'}
      onClose={onClose}
      width={520}
      footer={
        <div className="flex items-center gap-2">
          <span className="text-xs text-down flex-1 min-w-0 leading-snug" title={error ?? problem ?? undefined}>
            {error ?? (f.name || f.symbols ? problem : '')}
          </span>
          <button className="btn btn-ghost shrink-0" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary shrink-0" disabled={busy || Boolean(problem)} onClick={() => void submit()}>
            {existing ? 'Save' : 'Create'}
          </button>
        </div>
      }
    >
      <Field label="Name">
        <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Open-range momentum" autoFocus aria-label="Name" />
      </Field>
      <Field label="Symbols" hint={`Up to ${REALTIME_MAX_SYMBOLS}. Every one is checked on every tick and asked about in one request.`}>
        <input className="input mono" value={f.symbols} onChange={(e) => set({ symbols: e.target.value })} placeholder="NVDA, AAPL, TSLA" aria-label="Symbols" />
      </Field>
      {!existing && (
        <Field label="Paper allocation" hint="Simulated money. A position is sized from this and the per-symbol limit below.">
          <div className="flex items-center gap-2">
            <span className="text-muted">$</span>
            <input type="number" className="input w-40 nums" min={100} step={100} value={f.allocation} onChange={(e) => set({ allocation: e.target.value })} aria-label="Allocation" />
          </div>
        </Field>
      )}
      <Field label="Check every" hint="How often it re-reads the tape and asks the model. One second needs the live stream below the dashboard; quiet ticks (no price change) skip the model.">
        <Segmented value={String(f.intervalSec)} onChange={(v) => set({ intervalSec: Number(v) })} options={INTERVALS.map((n) => ({ value: String(n), label: `${n}s` }))} />
      </Field>
      <Field label="Standing order" hint="One or two sentences the model judges for. Leave blank for disciplined intraday momentum.">
        <textarea className="input min-h-[64px] resize-y" value={f.style} onChange={(e) => set({ style: e.target.value })} placeholder="Buy breakouts above the opening range on heavy volume; take profits quickly; never chase an extended spike." aria-label="Standing order" />
      </Field>

      <SectionHead title="Exits the engine enforces" hint="Checked in code on every tick, before the model is asked. The model cannot move them." className="mt-6" />
      <div className="card overflow-hidden divide-hair mb-5">
        <NumberField label="Stop-loss" value={f.g.stopLossPct} onChange={(v) => setG({ stopLossPct: v ?? REALTIME_DEFAULTS.stopLossPct })} suffix="%" min={0.1} max={20} />
        <NumberField label="Take-profit" value={f.g.takeProfitPct} onChange={(v) => setG({ takeProfitPct: v ?? REALTIME_DEFAULTS.takeProfitPct })} suffix="%" min={0.1} max={50} />
        <NumberField label="Trailing stop" hint="Below the high since entry. Blank turns it off." value={f.g.trailPct} onChange={(v) => setG({ trailPct: v })} suffix="%" min={0.1} max={20} nullable />
        <TimeField label="Flatten everything at" hint="Out at market whatever the price — nothing is held into the close." value={f.g.flattenAt} onChange={(v) => setG({ flattenAt: v })} />
      </div>

      <SectionHead title="Entries" hint="When a buy verdict may become an order." />
      <div className="card overflow-hidden divide-hair mb-5">
        <NumberField label="Max position per symbol" hint="As a share of the allocation." value={f.g.maxPositionPct} onChange={(v) => setG({ maxPositionPct: v ?? REALTIME_DEFAULTS.maxPositionPct })} suffix="%" step={1} min={1} max={100} />
        <TimeField label="No entries before" value={f.g.noEntriesBeforeEt} onChange={(v) => setG({ noEntriesBeforeEt: v })} />
        <TimeField label="No entries after" value={f.g.noEntriesAfterEt} onChange={(v) => setG({ noEntriesAfterEt: v })} />
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

/* ───────────────────────────── the fleet strip ───────────────────────────── */

function AgentChip({ s, active, onSelect }: { s: RealtimeSummary; active: boolean; onSelect: () => void }): JSX.Element {
  const { equity } = realtimeEquity(s.state)
  const day = realtimeDayPnl(s.state)
  const running = s.config.status === 'running'
  return (
    <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined} className={cn('shrink-0 flex items-center gap-2.5 rounded-full pl-2.5 pr-3.5 h-9 text-left', active ? 'bg-surface-2 ring-1 ring-hairline-strong' : 'hover:bg-surface-2')}>
      <span className={cn('h-2 w-2 rounded-full shrink-0', running ? 'bg-up' : 'bg-text-3')} aria-hidden />
      <span className="min-w-0">
        <span className={cn('block text-sm leading-tight truncate', active ? 'font-medium' : 'font-normal')}>{s.config.name}</span>
        <span className="block text-2xs text-muted mono truncate leading-tight">{s.config.symbols.join(' ')}</span>
      </span>
      <span className="text-right shrink-0 nums">
        <span className="block text-xs leading-tight">{money(equity)}</span>
        <span className={cn('block text-2xs leading-tight', day === null ? 'text-muted' : day >= 0 ? 'text-up' : 'text-down')}>{day === null ? '—' : signedMoney(day)}</span>
      </span>
    </button>
  )
}

/* ───────────────────────────── the dashboard ───────────────────────────── */

function Dashboard({ s, onEdit }: { s: RealtimeSummary; onEdit: () => void }): JSX.Element {
  const setStatus = useRealtime((x) => x.setStatus)
  const resetPaper = useRealtime((x) => x.resetPaper)
  const tickNow = useRealtime((x) => x.tickNow)
  const remove = useRealtime((x) => x.remove)
  const samples = useRealtime((x) => x.samples)
  const pageTicks = useRealtime((x) => x.ticks[s.config.id]) ?? NO_TICKS
  const key = useRealtime((x) => x.key)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null)
  const [symbol, setSymbol] = useState(s.config.symbols[0])
  useEffect(() => {
    if (!s.config.symbols.includes(symbol)) setSymbol(s.config.symbols[0])
  }, [s.config.symbols, symbol])
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
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-5 pt-3 pb-2 flex items-center gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <h2 className="text-md font-semibold tracking-[-0.01em] truncate">{config.name}</h2>
          <span className={cn('pill', running ? 'pill-up' : '')}>{running ? 'Running' : 'Paused'}</span>
          <span className="pill pill-paper">Paper</span>
          {state.buyLocked && <span className="pill pill-warn">Buys locked</span>}
        </div>
        <Segmented size="sm" value={symbol} onChange={setSymbol} options={config.symbols.map((sym) => ({ value: sym, label: sym }))} />
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
            <span className="text-xs text-muted">Delete this agent and its log?</span>
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
            <button className="btn-icon text-down" title="Delete this agent" aria-label="Delete this agent" onClick={() => setConfirm('delete')}>
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>

      <div className="shrink-0 px-5 pb-2.5 flex items-center gap-5 text-xs text-text-3 nums whitespace-nowrap">
        <span>last {lastLat !== null ? `${Math.round(lastLat)} ms` : '— ms'}</span>
        <span>avg {avgLat !== null ? `${avgLat} ms` : '—'}</span>
        <span>{state.modelCalls} calls</span>
        <span>{state.ledger.fills.length} fills</span>
        <span>{state.ticksToday} checks today</span>
        <span>every {config.intervalSec}s</span>
        {!key?.hasKey && <span className="text-warn">no TypeSafe key — exits enforced, no new decisions</span>}
        {state.lastError && key?.hasKey && <span className="text-down truncate">{state.lastError}</span>}
        <span className="flex-1" />
        <span className="text-text">{money(equity)}</span>
        <span className={cn(state.ledger.realizedPnl > 0 ? 'text-up' : state.ledger.realizedPnl < 0 ? 'text-down' : '')}>realized {signedMoney(state.ledger.realizedPnl)}</span>
        <span className={cn(day === null ? '' : day > 0 ? 'text-up' : day < 0 ? 'text-down' : '')}>day {day === null ? '—' : signedMoney(day)}</span>
        <span>{fillsToday} fills today</span>
        <span>{firstToday ? `since ${clockTime(firstToday)}` : state.lastTickAt ? `last check ${relTime(state.lastTickAt)}` : 'no checks yet'}</span>
      </div>

      <div className="flex-1 min-h-0 flex gap-4 px-5 pb-4">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <RealtimeChart symbol={symbol} points={samples[symbol] ?? []} ticks={ticks} position={position} exit={exit} effectiveStop={effectiveStop} dayPnl={day} allocation={config.allocation} />
        </div>
        <div className="w-[440px] shrink-0 min-h-0 flex flex-col card overflow-hidden">
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

export function RealtimePage(): JSX.Element {
  const booted = useRealtime((s) => s.booted)
  const boot = useRealtime((s) => s.boot)
  const agents = useRealtime((s) => s.agents)
  const order = useRealtime((s) => s.order)
  const selectedId = useRealtime((s) => s.selectedId)
  const select = useRealtime((s) => s.select)
  const key = useRealtime((s) => s.key)
  const stream = useRealtime((s) => s.stream)
  const session = useSession()
  const [sheet, setSheet] = useState<{ kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string }>({ kind: 'none' })
  useEffect(() => {
    void boot()
  }, [boot])
  const selected = selectedId ? agents[selectedId] : undefined
  const model = key?.models?.[0] ?? null
  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-bg">
      <header className="drag h-[var(--h-header)] shrink-0 flex items-center gap-3 px-5 hair-b">
        <div className="min-w-0 no-drag">
          <div className="text-lg font-semibold tracking-[-0.01em] leading-tight">Real time</div>
          <div className="text-xs text-muted">Paper agents on a live tape, decided every second by {REALTIME_MODEL_LABEL}</div>
        </div>
        <div className="flex-1 min-w-0 no-drag flex items-center gap-1.5 overflow-x-auto py-1">
          {order.map((id) => agents[id] && <AgentChip key={id} s={agents[id]} active={id === selectedId} onSelect={() => select(id)} />)}
        </div>
        <span className={cn('pill no-drag', session === 'open' ? 'pill-up' : '')}>{SESSION_LABEL[session]}</span>
        {stream?.state === 'live' && <span className="pill pill-up no-drag">Stream live</span>}
        <span className={cn('pill no-drag', model ? 'pill-accent' : key?.hasKey ? '' : 'pill-warn')} title={model ? 'The model the stored key can use' : undefined}>
          {model ?? (key?.hasKey ? 'key stored' : 'no key')}
        </span>
        <button className="btn btn-primary btn-sm no-drag" onClick={() => setSheet({ kind: 'new' })}>
          <Plus size={13} /> New
        </button>
      </header>
      {selected ? (
        <Dashboard key={selected.config.id} s={selected} onEdit={() => setSheet({ kind: 'edit', id: selected.config.id })} />
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <EmptyState icon={<Activity size={18} />} title={booted ? (order.length ? 'Select an agent' : 'No real-time agents') : 'Loading…'} body={booted && !order.length ? 'Pick a few symbols, a paper allocation and a cadence. The model answers buy, sell or hold on every check; the engine enforces the stops.' : undefined} action={booted && !order.length ? <button className="btn btn-primary btn-sm" onClick={() => setSheet({ kind: 'new' })}>New real-time agent</button> : undefined} />
        </div>
      )}
      <StreamRow />
      <KeyRow />
      {sheet.kind === 'new' && <AgentForm onClose={() => setSheet({ kind: 'none' })} />}
      {sheet.kind === 'edit' && agents[sheet.id] && <AgentForm existing={agents[sheet.id].config} onClose={() => setSheet({ kind: 'none' })} />}
    </section>
  )
}
