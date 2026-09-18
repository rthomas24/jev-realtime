import type { JSX } from 'react'
import { useMemo } from 'react'
import { Maximize2 } from 'lucide-react'
import { money } from '@shared/ledger'
import { realtimeRuleLabel, type RealtimeAction, type RealtimeSummary } from '@shared/realtimeAgents'
import type { PricePoint } from '@renderer/store/realtimeStore'
import { useRealtime } from '@renderer/store/realtimeStore'
import { cn, signedMoney } from '@renderer/lib/format'
import { RowActivity } from './Activity'
import { useSymbolDecisions } from './decisions'
import { rowKey, type Ordering, type RowKey } from './order'

/**
 * Every watched name at once. One tile per row of the watchlist, carrying
 * what the focused view says in its first screenful — the live price and the
 * session's move, the model's last word with its distribution, the position
 * if there is one, and the recent checks — so a book of six can be read
 * without opening any of them. Tiles drag into the same order as the list.
 */
const COLOR: Record<RealtimeAction, string> = { buy: 'var(--color-up)', sell: 'var(--color-down)', hold: 'var(--color-text)' }
const WORD: Record<RealtimeAction, string> = { buy: 'UP', sell: 'DOWN', hold: 'FLAT' }
const ORDER: RealtimeAction[] = ['buy', 'sell', 'hold']

/** The tile's chart: the session's samples as a filled line, in the move's colour. */
function TileChart({ points, tone }: { points: PricePoint[]; tone: 'up' | 'down' | 'muted' }): JSX.Element {
  const w = 300
  const h = 64
  const path = useMemo(() => {
    const pts = points.slice(-600)
    if (pts.length < 2) return null
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      if (p.p < lo) lo = p.p
      if (p.p > hi) hi = p.p
    }
    const range = hi - lo || 1
    const xy = pts.map((p, i) => [(i / (pts.length - 1)) * w, h - 2 - ((p.p - lo) / range) * (h - 6)] as const)
    return {
      line: xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      area: `${xy[0][0].toFixed(1)},${h} ${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} ${xy[xy.length - 1][0].toFixed(1)},${h}`,
      last: xy[xy.length - 1]
    }
  }, [points])
  const color = tone === 'up' ? 'var(--color-up)' : tone === 'down' ? 'var(--color-down)' : 'var(--color-muted)'
  if (!path) return <div className="h-16 flex items-center justify-center text-2xs text-text-3">waiting for prices…</div>
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className="block">
      <polygon points={path.area} fill={color} opacity={0.1} />
      <polyline points={path.line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={path.last[0]} cy={path.last[1]} r="2.5" fill={color} />
    </svg>
  )
}

function Bars({ probabilities, action }: { probabilities: Partial<Record<RealtimeAction, number>>; action: RealtimeAction }): JSX.Element {
  return (
    <span className="flex items-center gap-2 mt-1.5">
      {ORDER.filter((a) => probabilities[a] !== undefined).map((a) => (
        <span key={a} className="flex items-center gap-1 flex-1 min-w-0" title={`${WORD[a].toLowerCase()} ${Math.round((probabilities[a] ?? 0) * 100)}%`}>
          <span className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
            <span className="block h-full rounded-full rt-gauge" style={{ width: `${Math.max(0, Math.min(1, probabilities[a] ?? 0)) * 100}%`, background: COLOR[a], opacity: action === a ? 1 : 0.35 }} />
          </span>
          <span className="mono text-2xs nums text-text-3 w-7 text-right">{Math.round((probabilities[a] ?? 0) * 100)}%</span>
        </span>
      ))}
    </span>
  )
}

function SymbolTile({ s, symbol, active, onSelect, onOpen, ordering, keys }: { s: RealtimeSummary; symbol: string; active: boolean; onSelect: () => void; onOpen: () => void; ordering: Ordering; keys: readonly RowKey[] }): JSX.Element {
  const { config, state } = s
  const samples = useRealtime((x) => x.samples[symbol])
  const points = samples ?? []
  const { latest, judged } = useSymbolDecisions(config.id, symbol)
  const last = points[points.length - 1]?.p ?? state.lastQuotes[symbol] ?? null
  const change = points.length >= 2 && points[0].p > 0 ? ((points[points.length - 1].p - points[0].p) / points[0].p) * 100 : null
  const tone: 'up' | 'down' | 'muted' = change === null ? 'muted' : change >= 0 ? 'up' : 'down'
  const position = state.ledger.positions.find((p) => p.symbol === symbol) ?? null
  const upnl = position && last ? (last - position.avgCost) * position.qty : null
  const v = judged?.d.verdict ?? null
  const key = rowKey(config.id, symbol)
  const drag = ordering.dragProps(key, keys)
  const dragging = ordering.dragKey === key
  const over = ordering.over?.key === key ? ordering.over.side : null
  return (
    <div
      {...drag}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn('card p-3 flex flex-col cursor-pointer select-none', active && 'ring-1 ring-[var(--ring)]', dragging && 'opacity-40', over === 'before' && 'rt-drop-l', over === 'after' && 'rt-drop-r')}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="mono text-[15px] font-semibold tracking-[-0.01em] truncate">{symbol}</span>
            {config.status !== 'running' && <span className="pill">Paused</span>}
            {state.buyLocked && <span className="pill pill-warn">Locked</span>}
          </div>
          <div className="text-2xs text-text-3 truncate mt-0.5">
            {position ? (
              <>
                long {position.qty} @ {money(position.avgCost)}
                {upnl !== null && <span className={cn('ml-1 font-medium', upnl >= 0 ? 'text-up' : 'text-down')}>{signedMoney(upnl)}</span>}
              </>
            ) : (
              `flat · every ${config.intervalSec}s`
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="mono text-sm nums">{last !== null ? money(last) : '—'}</div>
          <div className={cn('inline-block mt-0.5 rounded px-1.5 py-px text-2xs nums font-medium', change === null ? 'text-text-3' : change >= 0 ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>{change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</div>
        </div>
        <button
          type="button"
          className="btn-icon shrink-0 -mr-1 -mt-1"
          title={`Open ${symbol}`}
          aria-label={`Open ${symbol}`}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          <Maximize2 size={13} />
        </button>
      </div>

      <div className="mt-2">
        <TileChart points={points} tone={tone} />
      </div>

      <div className="mt-1.5">
        {v ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold leading-none" style={{ color: COLOR[v.action] }}>
                {WORD[v.action]}
              </span>
              <span className="mono text-sm nums" style={{ color: COLOR[v.action] }}>
                {Math.round((v.probabilities[v.action] ?? 0) * 100)}%
              </span>
              <span className="flex-1" />
              <span className="text-2xs text-text-3 nums">conf {v.confidence.toFixed(2)}</span>
            </div>
            <Bars probabilities={v.probabilities} action={v.action} />
          </>
        ) : (
          <div className="text-2xs text-text-3">{latest ? latest.d.detail : 'no checks yet'}</div>
        )}
        {latest && (
          <div className={cn('text-2xs mt-1.5 truncate', latest.d.outcome === 'blocked' ? 'text-warn' : latest.d.outcome === 'error' ? 'text-down' : 'text-text-3')} title={latest.d.detail}>
            {realtimeRuleLabel(latest.d.rule)}
            {latest.d.fill ? ` · ${latest.d.fill.side === 'buy' ? 'bought' : 'sold'} ${latest.d.fill.qty} @ ${money(latest.d.fill.price)}` : ''}
          </div>
        )}
      </div>

      <RowActivity s={s} symbol={symbol} className="mt-auto pt-2" />
    </div>
  )
}

export interface RowGroup {
  title: string
  rows: { s: RealtimeSummary; symbol: string }[]
}

export function SymbolGrid({ groups, active, onSelect, onOpen, ordering }: { groups: RowGroup[]; active: { id: string; symbol: string } | null; onSelect: (k: { id: string; symbol: string }) => void; onOpen: (k: { id: string; symbol: string }) => void; ordering: Ordering }): JSX.Element {
  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto px-5 pb-4 pt-1">
      {groups.map((g) => {
        // Each market is its own list, as it is on the left: a tile drags
        // among its own kind, and the two views stay in the same order.
        const keys = g.rows.map((r) => rowKey(r.s.config.id, r.symbol))
        return (
          <div key={g.title} className="mb-4 last:mb-0">
            <div className="eyebrow pb-1.5">{g.title}</div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(288px, 1fr))' }}>
              {g.rows.map((r) => (
                <SymbolTile
                  key={rowKey(r.s.config.id, r.symbol)}
                  s={r.s}
                  symbol={r.symbol}
                  active={active?.id === r.s.config.id && active.symbol === r.symbol}
                  onSelect={() => onSelect({ id: r.s.config.id, symbol: r.symbol })}
                  onOpen={() => onOpen({ id: r.s.config.id, symbol: r.symbol })}
                  ordering={ordering}
                  keys={keys}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
