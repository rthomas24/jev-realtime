import type { JSX } from 'react'
import { money } from '@shared/ledger'
import { REALTIME_RULE_LABEL, type RealtimeAction, type RealtimeConfig, type RealtimeDecision, type RealtimeState } from '@shared/realtimeAgents'
import { cn, signedMoney } from '@renderer/lib/format'

/**
 * The right column's top: the standing order (what the agent is judging
 * for, in the model's own terms), the latest verdict for the selected symbol
 * as a headline word with its probability, one bar per offered answer plus
 * the reversal question when it was asked, and what the engine did with it.
 */
function BarRow({ label, value, active, color, dim }: { label: string; value: number; active: boolean; color: string; dim: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-14 shrink-0 text-sm font-medium" style={{ color, opacity: active ? 1 : 0.42 }}>
        {label}
      </span>
      <div className="flex-1 min-w-0 h-3.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full rt-bar" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: active ? color : dim }} />
      </div>
      <span className="w-11 shrink-0 text-right mono text-[13px] font-medium nums">{Math.round(value * 100)}%</span>
    </div>
  )
}

const COLOR: Record<RealtimeAction, string> = { buy: 'var(--color-up)', sell: 'var(--color-down)', hold: 'var(--color-text)' }
const DIM: Record<RealtimeAction, string> = { buy: 'color-mix(in oklab, var(--color-up) 22%, transparent)', sell: 'color-mix(in oklab, var(--color-down) 22%, transparent)', hold: 'var(--color-surface-3)' }
const ORDER: RealtimeAction[] = ['buy', 'sell', 'hold']
/** The direction question's answers, as the model was asked them. */
const DIRECTION: Record<RealtimeAction, string> = { buy: 'up', sell: 'down', hold: 'flat' }
const WARN_DIM = 'color-mix(in oklab, var(--color-warn) 22%, transparent)'
const ACCENT_DIM = 'color-mix(in oklab, var(--color-accent) 22%, transparent)'

export function DecisionPanel({ config, symbol, latest, state }: { config: RealtimeConfig; symbol: string; latest: RealtimeDecision | null; state: RealtimeState }): JSX.Element {
  const g = config.guardrails
  const v = latest?.verdict ?? null
  const headline = latest?.fill ? (latest.fill.side === 'buy' ? 'BUY' : 'SELL') : v ? DIRECTION[v.action].toUpperCase() : latest ? REALTIME_RULE_LABEL[latest.rule].toUpperCase() : '—'
  const headlineColor = latest?.fill ? (latest.fill.side === 'buy' ? 'var(--color-up)' : 'var(--color-down)') : v ? COLOR[v.action] : latest?.outcome === 'blocked' ? 'var(--color-warn)' : 'var(--color-muted)'
  const headlinePct = v ? `${Math.round((v.probabilities[v.action] ?? 0) * 100)}%` : ''
  const offered = v ? ORDER.filter((a) => v.probabilities[a] !== undefined) : []
  const position = state.ledger.positions.find((p) => p.symbol === symbol) ?? null
  return (
    <div className="flex flex-col">
      <section className="px-4 py-3.5 hair-b">
        <div className="eyebrow">Standing order</div>
        <div className="mono text-xs leading-relaxed text-text-2 mt-1.5">
          {'> '}
          {config.style || 'Disciplined intraday momentum: buy strength confirmed by trend and volume, take profits at the target, cut losses at the stop.'}
          <br />
          {'> '}long only · {g.stopLossPct}% stop · {g.takeProfitPct}% target{g.trailPct !== null ? ` · ${g.trailPct}% trail` : ''} · flat by {g.flattenAt} ET · buy ≥ {Math.round(g.buyThreshold * 100)}% · sell ≥ {Math.round(g.sellThreshold * 100)}%
        </div>
      </section>

      <section className="px-4 py-3.5 hair-b">
        <div className="eyebrow mb-2.5">{position ? `${symbol} · next ${g.horizonMin} min — keep or close?` : `${symbol} · next ${g.horizonMin} min — open?`}</div>
        <div className="flex items-baseline gap-3.5 mb-3" style={{ color: headlineColor }}>
          <span className="text-[28px] leading-[1.1] font-semibold tracking-[-0.01em]">{headline}</span>
          {headlinePct && <span className="mono text-[20px] leading-[1.1] font-medium nums">{headlinePct}</span>}
        </div>
        {offered.length ? (
          <>
            {offered.map((a) => (
              <BarRow key={a} label={DIRECTION[a]} value={v!.probabilities[a] ?? 0} active={v!.action === a} color={COLOR[a]} dim={DIM[a]} />
            ))}
            {(v!.extended !== undefined || v!.setup !== undefined || v!.reversal !== undefined || v!.trendIntact !== undefined) && <div className="hair-t my-2" />}
            {v!.extended !== undefined && <BarRow label="extended" value={v!.extended} active={v!.extended >= g.maxExtended} color="var(--color-warn)" dim={WARN_DIM} />}
            {v!.setup !== undefined && <BarRow label="setup" value={v!.setup / 2} active={v!.setup >= g.minSetup} color="var(--color-accent)" dim={ACCENT_DIM} />}
            {v!.reversal !== undefined && <BarRow label="reversal" value={v!.reversal} active={v!.reversal >= g.reversalThreshold} color="var(--color-warn)" dim={WARN_DIM} />}
            {v!.trendIntact !== undefined && <BarRow label="intact" value={v!.trendIntact} active={v!.trendIntact > 1 - g.sellThreshold} color="var(--color-up)" dim={DIM.buy} />}
          </>
        ) : (
          <p className="text-xs text-muted">{latest ? latest.detail : 'The model has not been asked about this symbol yet.'}</p>
        )}
        {latest && offered.length > 0 && (
          <p className={cn('text-xs mt-2.5', latest.outcome === 'blocked' ? 'text-warn' : latest.outcome === 'error' ? 'text-down' : 'text-muted')}>
            <span className="font-medium">{REALTIME_RULE_LABEL[latest.rule]}</span> · {latest.detail}
          </p>
        )}
      </section>

      {state.ledger.positions.length > 0 && (
        <section className="px-4 py-3 hair-b">
          <div className="eyebrow mb-1.5">Book</div>
          {state.ledger.positions.map((p) => {
            const last = state.lastQuotes[p.symbol]
            const upnl = last ? (last - p.avgCost) * p.qty : null
            return (
              <div key={p.symbol} className="flex items-center gap-2 text-xs py-0.5 nums">
                <span className="mono font-medium w-12">{p.symbol}</span>
                <span className="text-muted">
                  {p.qty} @ {money(p.avgCost)}
                </span>
                <span className="flex-1" />
                <span className={cn('font-medium', upnl === null ? 'text-muted' : upnl >= 0 ? 'text-up' : 'text-down')}>{upnl === null ? '—' : signedMoney(upnl)}</span>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
