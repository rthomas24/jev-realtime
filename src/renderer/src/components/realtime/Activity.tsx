import type { JSX } from 'react'
import { useMemo } from 'react'
import { money } from '@shared/ledger'
import { etDateOf } from '@shared/marketTime'
import type { RealtimeDecision, RealtimeSummary } from '@shared/realtimeAgents'
import { cn, clockTime, signedMoney } from '@renderer/lib/format'
import { useAgentTicks } from './decisions'

/**
 * What an agent has been doing in one symbol, small enough to sit under a
 * watchlist row or inside a grid tile: the last checks as pips — newest on
 * the right, a fill a full bar in its own colour, a refusal amber, an
 * ordinary hold a short stub and a check that was not worth asking a faint
 * tick — then today's fills and what they made.
 */
const PIP_N = 18
const PIP: Record<string, { cls: string; word: string }> = {
  buy: { cls: 'bg-up', word: 'bought' },
  sell: { cls: 'bg-down', word: 'sold' },
  hold: { cls: 'bg-text-3/60', word: 'held' },
  blocked: { cls: 'bg-warn/70', word: 'refused' },
  quiet: { cls: 'bg-text-3/20', word: 'not asked' },
  error: { cls: 'bg-down/40', word: 'failed' }
}

function pipKind(d: RealtimeDecision): keyof typeof PIP {
  if (d.fill) return d.fill.side
  if (d.outcome === 'error') return 'error'
  if (d.outcome === 'blocked') return 'blocked'
  if (d.outcome === 'quiet') return 'quiet'
  return 'hold'
}

export function RowActivity({ s, symbol, className }: { s: RealtimeSummary; symbol: string; className?: string }): JSX.Element | null {
  const ticks = useAgentTicks(s.config.id)
  const pips = useMemo(() => {
    const out: { id: string; kind: keyof typeof PIP; title: string }[] = []
    for (let i = ticks.length - 1; i >= 0 && out.length < PIP_N; i--) {
      const d = ticks[i].decisions.find((x) => x.symbol === symbol)
      if (!d) continue
      const kind = pipKind(d)
      out.push({
        id: ticks[i].id,
        kind,
        title: `${clockTime(ticks[i].at)} · ${PIP[kind].word}${d.fill ? ` ${d.fill.qty} @ ${money(d.fill.price)}` : d.verdict ? ` · ${Math.round((d.verdict.probabilities[d.verdict.action] ?? 0) * 100)}%` : ''}`
      })
    }
    return out.reverse()
  }, [ticks, symbol])
  const today = useMemo(() => {
    const day = s.state.dayDate
    const fills = day ? s.state.ledger.fills.filter((f) => f.symbol === symbol && etDateOf(f.ts) === day) : []
    return {
      buys: fills.filter((f) => f.side === 'buy').length,
      sells: fills.filter((f) => f.side === 'sell').length,
      realized: Math.round(fills.reduce((sum, f) => sum + f.realized, 0) * 100) / 100
    }
  }, [s.state.ledger.fills, s.state.dayDate, symbol])
  if (!pips.length) return null
  const traded = today.buys + today.sells > 0
  return (
    <span className={cn('flex items-center gap-2 mt-2', className)}>
      <span className="flex items-end gap-[2px] h-3 shrink-0" title="The last checks in this symbol, newest on the right. A fill is a full bar, a refusal amber, a check that was not worth asking a faint stub.">
        {pips.map((p, i) => (
          <span key={`${p.id}:${i}`} title={p.title} className={cn('w-[3px] rounded-[1px]', PIP[p.kind].cls, p.kind === 'quiet' ? 'h-[4px]' : p.kind === 'hold' ? 'h-[7px]' : 'h-3', i === pips.length - 1 && 'rt-pip-new')} />
        ))}
      </span>
      <span className="text-2xs text-text-3 nums truncate">{traded ? `${today.buys} buy${today.buys === 1 ? '' : 's'} · ${today.sells} sell${today.sells === 1 ? '' : 's'} today` : 'no fills today'}</span>
      {traded && today.realized !== 0 && <span className={cn('text-2xs nums font-medium shrink-0', today.realized > 0 ? 'text-up' : 'text-down')}>{signedMoney(today.realized)}</span>}
    </span>
  )
}
