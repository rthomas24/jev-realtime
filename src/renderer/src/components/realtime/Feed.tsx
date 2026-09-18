import type { JSX } from 'react'
import { useMemo } from 'react'
import { money } from '@shared/ledger'
import { REALTIME_RULE_LABEL, type RealtimeDecision, type RealtimeTick } from '@shared/realtimeAgents'
import { cn, clockTime, compactNumber, signedMoney } from '@renderer/lib/format'

type Kind = 'buy' | 'sell' | 'hold' | 'blocked' | 'quiet' | 'error'

function kindOf(d: RealtimeDecision): Kind {
  if (d.fill) return d.fill.side
  if (d.outcome === 'error') return 'error'
  if (d.outcome === 'blocked') return 'blocked'
  if (d.outcome === 'quiet') return 'quiet'
  return 'hold'
}

const WORD: Record<Kind, string> = { buy: 'BUY', sell: 'SELL', hold: 'HOLD', blocked: 'HELD', quiet: 'QUIET', error: 'ERR' }
const WORD_CLASS: Record<Kind, string> = { buy: 'text-up', sell: 'text-down', hold: 'text-text', blocked: 'text-warn', quiet: 'text-text-3', error: 'text-down' }
const ROW_TINT: Record<Kind, string> = {
  buy: 'color-mix(in oklab, var(--color-up) 8%, transparent)',
  sell: 'color-mix(in oklab, var(--color-down) 8%, transparent)',
  hold: 'transparent',
  blocked: 'color-mix(in oklab, var(--color-warn) 7%, transparent)',
  quiet: 'transparent',
  error: 'color-mix(in oklab, var(--color-down) 6%, transparent)'
}

/**
 * One row per check for the selected symbol, newest first: the time, the
 * word, the model's confidence and latency, and what happened — a fill with
 * its PRICE first and in bold (the number the eye is looking for; the size
 * and, for a sell, what it made, follow and are what truncates when the
 * column is narrow), or the rule that held the verdict back. Every check the
 * page holds is here; the list scrolls.
 */
export function Feed({ ticks, symbol }: { ticks: RealtimeTick[]; symbol: string }): JSX.Element {
  const rows = useMemo(() => {
    const out: { tick: RealtimeTick; d: RealtimeDecision }[] = []
    for (let i = ticks.length - 1; i >= 0; i--) {
      const d = ticks[i].decisions.find((x) => x.symbol === symbol)
      if (d) out.push({ tick: ticks[i], d })
    }
    return out
  }, [ticks, symbol])

  return (
    <section className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden pt-3">
      <div className="eyebrow px-4 pb-2 flex items-center gap-2">
        <span>Feed · {symbol}</span>
        <span className="normal-case tracking-normal font-normal text-text-3">{rows.length} checks</span>
      </div>
      <div className="relative flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="h-[26px] flex items-center px-4 mono text-xs text-text-3">no checks yet</div>
        ) : (
          rows.map(({ tick, d }, i) => {
            const kind = kindOf(d)
            const conf = d.verdict ? `conf ${Math.max(...Object.values(d.verdict.probabilities).map((v) => v ?? 0)).toFixed(2)}` : ''
            const lat = tick.latencyMs !== undefined && d.verdict ? `${Math.round(tick.latencyMs)}ms` : ''
            let detail: JSX.Element | string
            let muted = false
            if (d.fill) {
              detail = (
                <>
                  <span className="font-bold">{money(d.fill.price)}</span>
                  <span className="opacity-75"> × {d.fill.qty}</span>
                  {d.econ?.realized !== undefined && <span className={cn('ml-2 font-semibold', d.econ.realized >= 0 ? 'text-up' : 'text-down')}>{signedMoney(d.econ.realized)}</span>}
                </>
              )
            } else if (kind === 'hold') {
              // The price it judged at, and what the answer cost in tokens.
              detail = `${d.price !== null ? `@ ${money(d.price)}` : ''}${tick.usage ? ` · ${compactNumber(tick.usage.input)} tok` : ''}`
              muted = true
            } else {
              detail = REALTIME_RULE_LABEL[d.rule].toLowerCase()
              muted = kind === 'quiet'
            }
            return (
              <div key={tick.id} className={cn('rt-row h-[26px] flex items-center gap-2.5 px-4 whitespace-nowrap overflow-hidden mono text-[11.5px] nums', i === 0 && 'rt-row-new')} style={{ background: ROW_TINT[kind], opacity: i === 0 ? 1 : 0.92 }}>
                <span className="w-16 shrink-0 text-text-3">{clockTime(tick.at)}</span>
                <span className={cn('w-11 shrink-0 font-bold', WORD_CLASS[kind])}>{WORD[kind]}</span>
                <span className="w-[68px] shrink-0 text-text-3">{conf}</span>
                <span className="w-11 shrink-0 text-text-3">{lat}</span>
                <span className={cn('flex-1 min-w-0 truncate', muted ? 'text-text-3' : WORD_CLASS[kind])}>{detail}</span>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
