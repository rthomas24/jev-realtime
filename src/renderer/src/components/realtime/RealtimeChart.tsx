import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Position } from '@shared/ledger'
import { money } from '@shared/ledger'
import { realtimeRuleLabel, type RealtimeDecision, type RealtimeExit, type RealtimeTick } from '@shared/realtimeAgents'
import type { PricePoint } from '@renderer/store/realtimeStore'
import { cn, clockTime, signedMoney } from '@renderer/lib/format'
import { smoothPath } from './smooth'

/**
 * The hero: one symbol's live price as a calm sliding line, a strip of
 * decision cells underneath (one per check, coloured by what the engine did
 * with the model's verdict), a bead where a fill printed, the last price on
 * a tag that rides the line's end, and the two overlays — the price and the
 * stance top-left, the model's current word top-right.
 *
 * Every colour is a theme token, so all 17 palettes and both schemes draw it
 * the same way. Motion is transform/opacity only and keyed per point, so each
 * cue plays once on the instant it belongs to and never again.
 */
const STEP = 8 // px per sample
const ANCHOR_GAP = 96 // the newest point sits this far from the right edge
const PAD_TOP = 88
const PAD_BOTTOM = 64
const EASE = 0.12
const MIN_RANGE_PCT = 0.002 // 0.20% of price, so a quiet tape stays calm
const CELL_W = 6
const CELL_H = 16
const TAG_W = 66

type Kind = 'buy' | 'sell' | 'hold' | 'blocked' | 'quiet' | 'error' | 'none'

function kindOf(d: RealtimeDecision | undefined): Kind {
  if (!d) return 'none'
  if (d.fill) return d.fill.side
  if (d.outcome === 'error') return 'error'
  if (d.outcome === 'blocked') return 'blocked'
  if (d.outcome === 'quiet') return 'quiet'
  return 'hold'
}

const CELL_FILL: Record<Kind, string> = {
  buy: 'var(--color-up)',
  sell: 'var(--color-down)',
  hold: 'var(--color-surface-3)',
  blocked: 'var(--color-warn)',
  quiet: 'var(--color-line-faint)',
  error: 'var(--color-down)',
  none: 'transparent'
}

const WORD: Record<Kind, string> = { buy: 'Buying', sell: 'Selling', hold: 'Holding', blocked: 'Held back', quiet: 'Quiet', error: 'No answer', none: 'Waiting' }
const WORD_COLOR: Record<Kind, string> = {
  buy: 'var(--color-up)',
  sell: 'var(--color-down)',
  hold: 'var(--color-text)',
  blocked: 'var(--color-warn)',
  quiet: 'var(--color-muted)',
  error: 'var(--color-down)',
  none: 'var(--color-muted)'
}

const fmt = (n: number): string => (n >= 1000 ? n.toFixed(2) : n >= 100 ? n.toFixed(2) : n.toFixed(2))

export function RealtimeChart({
  symbol,
  points,
  ticks,
  position,
  exit,
  effectiveStop,
  dayPnl,
  allocation,
  empty
}: {
  symbol: string
  points: PricePoint[]
  ticks: RealtimeTick[]
  position: Position | null
  exit: RealtimeExit | null
  effectiveStop: number | null
  dayPnl: number | null
  allocation: number
  /** What to show before the first price — the page says why there is none yet. */
  empty?: ReactNode
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const scaleRef = useRef<{ lo: number; hi: number; t: number; symbol: string } | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '')

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: Math.round(r.width), h: Math.round(r.height) }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w, h } = size

  // Decisions for THIS symbol, keyed by the instant of their tick — the tick
  // emits a sample stamped with the same instant, so a cell lands on a point.
  const byTime = useMemo(() => {
    const m = new Map<number, { d: RealtimeDecision; tick: RealtimeTick }>()
    for (const t of ticks) {
      const d = t.decisions.find((x) => x.symbol === symbol)
      if (d) m.set(Date.parse(t.at), { d, tick: t })
    }
    return m
  }, [ticks, symbol])

  const model = useMemo(() => {
    const plotH = h - PAD_TOP - PAD_BOTTOM
    if (w < 160 || plotH < 60 || points.length === 0) return null
    const n = Math.max(2, Math.ceil((w - ANCHOR_GAP) / STEP) + 2)
    const series = points.slice(-n)
    const last = series[series.length - 1]
    const startIdx = points.length - series.length
    const fx = (i: number): number => i * STEP

    let lo = Infinity
    let hi = -Infinity
    let sum = 0
    for (const s of series) {
      if (s.p < lo) lo = s.p
      if (s.p > hi) hi = s.p
      sum += s.p
    }
    const mean = sum / series.length
    const floor = Math.max(mean * MIN_RANGE_PCT, 1e-9)
    if (hi - lo < floor) {
      lo = mean - floor / 2
      hi = mean + floor / 2
    }
    const prev = scaleRef.current
    if (prev && prev.symbol === symbol) {
      if (prev.t === last.t) {
        lo = prev.lo
        hi = prev.hi
      } else {
        lo = prev.lo + (lo - prev.lo) * EASE
        hi = prev.hi + (hi - prev.hi) * EASE
      }
      for (const s of series) {
        if (s.p < lo) lo = s.p
        if (s.p > hi) hi = s.p
      }
      if (hi - lo < floor) {
        const c = (hi + lo) / 2
        lo = c - floor / 2
        hi = c + floor / 2
      }
    }
    scaleRef.current = { lo, hi, t: last.t, symbol }

    const range = hi - lo || 1
    const fy = (p: number): number => PAD_TOP + (1 - (p - lo) / range) * plotH
    const pts = series.map((s, i) => [fx(i), fy(s.p)] as const)
    const line = smoothPath(pts)
    const base = h - PAD_BOTTOM
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z`

    const cells: { key: number; x: number; fill: string; kind: Kind }[] = []
    const beads: { key: number; x: number; y: number; fill: string; side: 'buy' | 'sell'; price: number }[] = []
    series.forEach((s, i) => {
      const hit = byTime.get(s.t)
      if (!hit) return
      const kind = kindOf(hit.d)
      cells.push({ key: s.t, x: fx(i) - CELL_W / 2, fill: CELL_FILL[kind], kind })
      if (hit.d.fill) beads.push({ key: s.t, x: fx(i), y: fy(s.p), fill: hit.d.fill.side === 'buy' ? 'var(--color-up)' : 'var(--color-down)', side: hit.d.fill.side, price: hit.d.fill.price })
    })
    const ticksY = [0.25, 0.5, 0.75].map((f) => ({ y: PAD_TOP + plotH * f, label: fmt(lo + (1 - f) * range) }))
    // The position's levels: a dashed line where one sits inside the window,
    // a note at the edge where it sits outside — the window stays tight to the
    // tape (a stop 1% away would otherwise flatten every move into a band).
    const levels: { y: number; label: string; color: string; inside: boolean }[] = []
    const level = (price: number, name: string, color: string): void => {
      const inside = price >= lo && price <= hi
      const y = inside ? fy(price) : price > hi ? PAD_TOP - 4 : base + 4
      levels.push({ y, label: `${name} ${fmt(price)}${inside ? '' : price > hi ? ' ↑' : ' ↓'}`, color, inside })
    }
    if (position && effectiveStop !== null) level(effectiveStop, 'stop', 'var(--color-down)')
    if (position && exit) level(exit.target, 'target', 'var(--color-up)')
    if (position) level(position.avgCost, 'entry', 'var(--color-muted)')

    return {
      line,
      area,
      cells,
      beads,
      hot: beads.length ? beads[beads.length - 1] : null,
      hotCell: cells.length ? cells[cells.length - 1] : null,
      ticksY,
      levels,
      fx,
      fy,
      series,
      startIdx,
      last,
      base,
      shift: w - ANCHOR_GAP - fx(series.length - 1),
      endY: fy(last.p)
    }
  }, [points, w, h, byTime, symbol, position, exit, effectiveStop])

  const hv = useMemo(() => {
    if (!model || hover === null) return null
    const i = hover - model.startIdx
    const s = model.series[i]
    if (!s) return null
    const x = model.fx(i)
    const flip = x + model.shift > w - 176
    const ty = Math.min(Math.max(model.fy(s.p) - 92, PAD_TOP - 46), model.base - 82)
    const hit = byTime.get(s.t)
    const kind = kindOf(hit?.d)
    const line3 = hit?.d.fill ? `${hit.d.fill.side === 'buy' ? 'BOUGHT' : 'SOLD'} ${hit.d.fill.qty} @ ${fmt(hit.d.fill.price)}` : hit ? realtimeRuleLabel(hit.d.rule) : 'price sample'
    return {
      x,
      y: model.fy(s.p),
      tx: flip ? x - 154 : x + 14,
      ty,
      time: clockTime(new Date(s.t).toISOString()),
      price: fmt(s.p),
      line3,
      tint: hit ? WORD_COLOR[kind] : 'var(--color-muted)',
      meta: hit?.tick.latencyMs !== undefined ? `${Math.round(hit.tick.latencyMs)} ms` : hit ? 'no model call' : ''
    }
  }, [model, hover, w, byTime])

  // The latest decision for the overlays: the newest tick that judged this symbol.
  const latest = useMemo(() => {
    for (let i = ticks.length - 1; i >= 0; i--) {
      const d = ticks[i].decisions.find((x) => x.symbol === symbol)
      if (d) return { d, tick: ticks[i] }
    }
    return null
  }, [ticks, symbol])
  const kind = kindOf(latest?.d)
  const conf = latest?.d.verdict ? Math.max(...Object.values(latest.d.verdict.probabilities).map((v) => v ?? 0)) : null
  const lastPrice = points[points.length - 1]?.p ?? latest?.d.price ?? null
  const upnl = position && lastPrice ? (lastPrice - position.avgCost) * position.qty : null
  const stance = position ? `long ${position.qty} @ ${fmt(position.avgCost)}` : 'flat'

  return (
    <div
      ref={panelRef}
      className="relative flex-1 min-h-0 rounded-2xl bg-surface-2 overflow-hidden"
      onPointerMove={(ev) => {
        if (ev.pointerType !== 'mouse' || !model) return
        const r = ev.currentTarget.getBoundingClientRect()
        const i = Math.round((ev.clientX - r.left - model.shift) / STEP)
        setHover(i >= 0 && i < model.series.length ? model.startIdx + i : null)
      }}
      onPointerLeave={() => setHover(null)}
    >
      {!model ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">{points.length ? 'measuring…' : (empty ?? 'waiting for the first price…')}</div>
      ) : (
        <>
          <svg className="absolute inset-0 block" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
            <defs>
              <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-text)" stopOpacity="0.07" />
                <stop offset="100%" stopColor="var(--color-text)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {model.ticksY.map((t) => (
              <line key={t.y} x1="0" x2={w} y1={t.y} y2={t.y} stroke="var(--color-line-faint)" strokeWidth="1" />
            ))}
            {model.levels.map((l, i) => (
              <g key={l.label}>
                {l.inside && <line x1="0" x2={w - TAG_W - 12} y1={l.y} y2={l.y} stroke={l.color} strokeWidth="1" strokeDasharray="2 4" opacity="0.55" />}
                <text x={l.inside ? 10 : 10 + i * 110} y={l.inside ? l.y - 4 : l.y + (l.y < PAD_TOP ? 0 : 12)} className="mono" fontSize="10" fill={l.color} opacity="0.9">
                  {l.label}
                </text>
              </g>
            ))}
            <g className="rt-slide" style={{ transform: `translateX(${model.shift.toFixed(1)}px)` }}>
              <path d={model.area} fill={`url(#g${gid})`} />
              <path d={model.line} fill="none" stroke="var(--color-text)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
              {model.beads.map((b) => (
                <g key={b.key}>
                  <circle className={b.key === model.hot?.key ? 'rt-bead-pop' : undefined} cx={b.x} cy={b.y} r="3.2" fill={b.fill} opacity="0.85" />
                  {/* The fill's price beside its bead — buys above the line, sells below, so a quick round trip does not stack them. A surface-coloured halo keeps it legible over the line. */}
                  <text className="mono" x={b.x} y={b.side === 'buy' ? b.y - 9 : b.y + 17} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={b.fill} stroke="var(--color-surface)" strokeWidth="3" paintOrder="stroke" strokeLinejoin="round">
                    {b.side === 'buy' ? 'B' : 'S'} {fmt(b.price)}
                  </text>
                </g>
              ))}
              {model.hot && (
                <g key={model.hot.key}>
                  <line className="rt-riser" x1={model.hot.x} x2={model.hot.x} y1={h - 36} y2={model.hot.y} stroke={model.hot.fill} strokeWidth="1" />
                  <circle className="rt-ripple" cx={model.hot.x} cy={model.hot.y} r="3.2" fill="none" stroke={model.hot.fill} strokeWidth="2" />
                </g>
              )}
              {model.hotCell && <rect key={`glow${model.hotCell.key}`} className="rt-cell-glow" x={model.hotCell.x} y={h - 36} width={CELL_W} height={CELL_H} rx="3" fill={model.hotCell.fill} />}
              {model.cells.map((c, i) => (
                <rect key={c.key} className={i === model.cells.length - 1 ? 'rt-cell-pop' : undefined} x={c.x} y={h - 36} width={CELL_W} height={CELL_H} rx="3" fill={c.fill} opacity={i === model.cells.length - 1 ? 1 : c.kind === 'hold' || c.kind === 'quiet' ? 0.9 : 0.8} />
              ))}
              {hv && (
                <g>
                  <line x1={hv.x} x2={hv.x} y1={PAD_TOP - 12} y2={model.base + 8} stroke="var(--color-text)" strokeWidth="1" opacity="0.18" />
                  <circle cx={hv.x} cy={hv.y} r="4.5" fill="var(--color-surface)" stroke="var(--color-text)" strokeWidth="1.6" />
                  <g transform={`translate(${hv.tx.toFixed(1)},${hv.ty.toFixed(1)})`}>
                    <rect width="140" height="78" rx="10" fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="1" />
                    <text className="mono" x="12" y="21" fontSize="10" fill="var(--color-muted)">
                      {hv.time}
                    </text>
                    <text className="mono" x="12" y="41" fontSize="14" fontWeight="500" fill="var(--color-text)">
                      {hv.price}
                    </text>
                    <text x="12" y="58" fontSize="11" fontWeight="500" fill={hv.tint}>
                      {hv.line3}
                    </text>
                    <text className="mono" x="12" y="71" fontSize="10" fill="var(--color-text-3)">
                      {hv.meta}
                    </text>
                  </g>
                </g>
              )}
            </g>
            {model.ticksY.map((t) => (
              <text key={`l${t.y}`} className="mono" x={w - 8} y={t.y - 5} textAnchor="end" fontSize="10" fill="var(--color-text-3)">
                {t.label}
              </text>
            ))}
            <g className="rt-tag" style={{ transform: `translateY(${model.endY.toFixed(1)}px)` }}>
              <line x1={w - ANCHOR_GAP + 8} x2={w - TAG_W - 6} y1="0" y2="0" stroke="var(--color-muted)" strokeWidth="1" strokeDasharray="1 3" opacity="0.7" />
              <circle className="rt-halo" cx={w - ANCHOR_GAP} cy="0" r="4" fill="var(--color-text)" />
              <circle cx={w - ANCHOR_GAP} cy="0" r="4" fill="var(--color-text)" />
              <rect x={w - TAG_W - 4} y="-10" width={TAG_W} height="20" rx="999" fill="var(--color-text)" />
              <text className="mono" x={w - 4 - TAG_W / 2} y="4" textAnchor="middle" fontSize="11" fontWeight="500" fill="var(--color-bg)">
                {fmt(model.last.p)}
              </text>
            </g>
          </svg>
          <div aria-hidden className="absolute top-0 bottom-0 left-0 w-16 pointer-events-none" style={{ background: 'linear-gradient(90deg, var(--color-surface-2), transparent)' }} />

          <div className="absolute top-4 left-5 pointer-events-none">
            <div key={lastPrice ?? 0} className="mono rt-fade-in text-[34px] leading-[1.1] font-medium tracking-[-0.02em]">
              {lastPrice !== null ? fmt(lastPrice) : '—'}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-muted nums whitespace-nowrap">
              <span className="font-medium text-text">{symbol}</span>
              <span>{stance}</span>
              {upnl !== null && <span className={upnl >= 0 ? 'text-up' : 'text-down'}>{signedMoney(upnl)} open</span>}
              {dayPnl !== null && (
                <span className={dayPnl >= 0 ? 'text-up' : 'text-down'}>
                  day {signedMoney(dayPnl)} ({dayPnl >= 0 ? '+' : ''}
                  {((dayPnl / allocation) * 100).toFixed(2)}%)
                </span>
              )}
            </div>
          </div>

          <div className="absolute top-4 right-5 text-right pointer-events-none">
            <div key={`${latest?.tick.id ?? 'none'}-${kind}`} className={cn('rt-word-pop text-[30px] leading-[1.1] font-light tracking-[-0.02em] whitespace-nowrap')} style={{ color: WORD_COLOR[kind] }}>
              {WORD[kind]}
            </div>
            <div className="flex justify-end gap-3 mt-1.5 text-xs text-muted nums whitespace-nowrap">
              <span>{latest?.tick.latencyMs !== undefined ? `${Math.round(latest.tick.latencyMs)} ms` : latest ? 'no model call' : '—'}</span>
              <span>{conf !== null ? `conf ${conf.toFixed(2)}` : latest ? realtimeRuleLabel(latest.d.rule).toLowerCase() : ''}</span>
              {latest?.d.verdict?.reversal !== undefined && <span>reversal {Math.round(latest.d.verdict.reversal * 100)}%</span>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function fmtPrice(n: number): string {
  return money(n)
}
