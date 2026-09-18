import type { JSX } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { money } from '@shared/ledger'
import { isContinuousMarket, realtimeRuleLabel, realtimeModelCostUsd, type RealtimeAction, type RealtimeConfig, type RealtimeDecision, type RealtimeGuardrails, type RealtimeState, type RealtimeTick } from '@shared/realtimeAgents'
import { cn, compactNumber, relTime, signedMoney, usd } from '@renderer/lib/format'

/**
 * The right column's top: everything the model handed back for the selected
 * symbol, and what the engine did with it.
 *
 *   - the standing order (what the agent judges for, in the model's terms);
 *   - a status line: when the model was last asked, which versioned model
 *     answered, the round trip, the tokens and what they cost — or, on a
 *     quiet tick, that the last verdict is standing and why;
 *   - the headline (the likeliest path, its probability, a confidence ring
 *     for how peaked the split is) and one gauge per answer, grouped by the
 *     question that produced it, each with its threshold as a tick on the
 *     bar and a ✓/✗ for whether it lets the trade through;
 *   - the gate chain: the checks in the order the engine applies them, each
 *     with its number and its result, ending in the word the engine acted on.
 *
 * Every number rolls to its new value and a fresh answer flashes the card,
 * so a check can be seen landing; reduced motion turns that off.
 */
export interface DecisionAt {
  tick: RealtimeTick
  d: RealtimeDecision
}

const COLOR: Record<RealtimeAction, string> = { buy: 'var(--color-up)', sell: 'var(--color-down)', hold: 'var(--color-text)' }
const DIM: Record<RealtimeAction, string> = { buy: 'color-mix(in oklab, var(--color-up) 22%, transparent)', sell: 'color-mix(in oklab, var(--color-down) 22%, transparent)', hold: 'var(--color-surface-3)' }
const ORDER: RealtimeAction[] = ['buy', 'sell', 'hold']
/** The direction question's answers, as the model was asked them. */
const DIRECTION: Record<RealtimeAction, string> = { buy: 'up', sell: 'down', hold: 'flat' }
const WARN = 'var(--color-warn)'
const WARN_DIM = 'color-mix(in oklab, var(--color-warn) 22%, transparent)'
const ACCENT = 'var(--color-accent)'
const ACCENT_DIM = 'color-mix(in oklab, var(--color-accent) 45%, transparent)'
const pct = (n: number): string => `${Math.round(n * 100)}%`
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/** A number that rolls to its new value over ~450 ms, so a fresh answer is seen arriving. */
function useRolling(target: number, ms = 450): number {
  const [shown, setShown] = useState(target)
  const at = useRef(target)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      at.current = target
      setShown(target)
      return
    }
    const from = at.current
    const start = performance.now()
    let raf = 0
    const step = (t: number): void => {
      const k = Math.min(1, (t - start) / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      at.current = from + (target - from) * eased
      setShown(at.current)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return shown
}

/** How peaked the split was, as a ring: full = every bit of probability on one answer. */
function Ring({ value, color }: { value: number; color: string }): JSX.Element {
  const r = 15
  const c = 2 * Math.PI * r
  const v = useRolling(clamp01(value))
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" className="shrink-0" aria-hidden>
      <circle cx="19" cy="19" r={r} fill="none" stroke="var(--color-surface-3)" strokeWidth="3.5" />
      <circle cx="19" cy="19" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} transform="rotate(-90 19 19)" className="rt-ring" />
      <text x="19" y="19.5" textAnchor="middle" dominantBaseline="central" fontSize="10.5" fontWeight="600" fill="var(--color-text)" style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(v * 100)}
      </text>
    </svg>
  )
}

const SETUP_LEVELS = ['chop', 'mixed', 'clean'] as const
const REGIME_LEVELS = ['chopping', 'mixed', 'trending'] as const

/** The three level names under a score meter, lined up with its cells. */
function LevelLabels({ levels }: { levels: readonly [string, string, string] }): JSX.Element {
  return (
    <div className="flex gap-2.5 pl-[76px] pr-[54px] -mt-0.5">
      {levels.map((n) => (
        <span key={n} className="flex-1 text-center text-2xs text-text-3">
          {n}
        </span>
      ))}
    </div>
  )
}

/** ✓ when the check lets the trade through, ✗ when it stops it, nothing when it is not a gate here. */
function Glyph({ pass }: { pass?: boolean }): JSX.Element {
  return <span className={cn('w-3.5 shrink-0 text-center text-[11px] font-bold', pass === undefined ? 'text-text-3' : pass ? 'text-up' : 'text-down')}>{pass === undefined ? '' : pass ? '✓' : '✗'}</span>
}

/** One answer as a bar: the label, the probability, its threshold as a tick, and whether it passed. */
function Gauge({ label, value, color, dim, on, marker, pass, hint, live }: { label: string; value: number; color: string; dim: string; on: boolean; marker?: number; pass?: boolean; hint: string; live: boolean }): JSX.Element {
  const w = useRolling(clamp01(value))
  return (
    <div className="flex items-center gap-2.5 py-[3px]" title={hint}>
      <span className="w-[66px] shrink-0 text-[13px] font-medium truncate" style={{ color, opacity: on ? 1 : 0.5 }}>
        {label}
      </span>
      <div className="relative flex-1 min-w-0 h-3 rounded-full bg-surface-2 overflow-hidden">
        <div className={cn('h-full rounded-full rt-gauge', live && on && 'rt-gauge-live')} style={{ width: `${w * 100}%`, background: on ? color : dim }} />
        {marker !== undefined && <span className="absolute top-0 bottom-0 w-px rt-pin" style={{ left: `${clamp01(marker) * 100}%`, background: 'var(--color-text)', opacity: 0.55 }} />}
      </div>
      <span className="w-10 shrink-0 text-right mono text-[12.5px] font-medium nums">{pct(w)}</span>
      <Glyph pass={pass} />
    </div>
  )
}

/**
 * A Score question drawn as what it is: described levels, a probability on
 * each, and the score as the weighted position between them. Three cells
 * filled by their probabilities, a tick at the minimum a buy needs and a pin
 * at the score itself. Both the setup and the regime answers are this shape.
 */
function ScoreMeter({ label, score, probabilities, confidence, minimum, levels, what, live }: { label: string; score: number; probabilities?: [number, number, number]; confidence?: number; minimum: number; levels: readonly [string, string, string]; what: string; live: boolean }): JSX.Element {
  const pos = useRolling(clamp01(score / 2))
  const on = score >= minimum
  const pr = probabilities
  const hint = `${what} The model spreads its answer over three levels — ${levels.join(', ')} — and the score is the probability-weighted position from 0 to 2. A buy needs at least ${minimum}.${pr ? ` Spread: ${levels.map((l, i) => `${l} ${pct(pr[i])}`).join(', ')}.` : ''}${confidence !== undefined ? ` Confidence ${confidence.toFixed(2)}.` : ''}`
  return (
    <div className="flex items-center gap-2.5 py-[3px]" title={hint}>
      <span className="w-[66px] shrink-0 text-[13px] font-medium truncate" style={{ color: ACCENT, opacity: on ? 1 : 0.5 }}>
        {label}
      </span>
      <div className="relative flex-1 min-w-0 h-3">
        <div className="absolute inset-0 flex gap-[3px]">
          {levels.map((name, i) => (
            <div key={name} className="flex-1 rounded-full bg-surface-2 overflow-hidden" title={`${name}: ${pr ? pct(pr[i]) : '—'}`}>
              <div className={cn('h-full rounded-full rt-gauge', live && on && pr && pr[i] >= 0.5 && 'rt-gauge-live')} style={{ width: `${(pr ? clamp01(pr[i]) : 0) * 100}%`, background: ACCENT_DIM }} />
            </div>
          ))}
        </div>
        <span className="absolute top-0 bottom-0 w-px rt-pin" style={{ left: `${clamp01(minimum / 2) * 100}%`, background: 'var(--color-text)', opacity: 0.55 }} />
        <span className="absolute -top-[2px] -bottom-[2px] w-[3px] rounded-full rt-pin" style={{ left: `calc(${pos * 100}% - 1.5px)`, background: on ? ACCENT : 'var(--color-muted)' }} />
      </div>
      <span className="w-10 shrink-0 text-right mono text-[12.5px] font-medium nums">{(pos * 2).toFixed(2)}</span>
      <Glyph pass={on} />
    </div>
  )
}

/* ───────────────────────────── the gate chain ───────────────────────────── */

interface Gate {
  /** The answer the check reads. */
  name: string
  /** What the model gave. */
  value: string
  /** The comparison it had to satisfy, e.g. `≥ 70%`. */
  test: string
  pass: boolean
  /** False once an earlier gate has already decided the outcome. */
  reached: boolean
}
type Tone = 'up' | 'down' | 'warn' | 'muted' | 'text'
interface Chain {
  gates: Gate[]
  word: string
  tone: Tone
  /** The engine rule that settled it, when it was not the model's own verdict. */
  rule?: string
}

const TONE_STYLE: Record<Tone, React.CSSProperties> = {
  up: { background: 'var(--tint-up)', color: 'var(--color-up)' },
  down: { background: 'var(--tint-down)', color: 'var(--color-down)' },
  warn: { background: 'var(--tint-warn)', color: 'var(--color-warn)' },
  muted: { background: 'var(--color-surface-2)', color: 'var(--color-muted)' },
  text: { background: 'var(--color-surface-2)', color: 'var(--color-text)' }
}

/** The checks in the order the engine applies them (`verdictIntent`), with what each saw. */
function chainFor(src: DecisionAt, g: RealtimeGuardrails): Chain {
  const { d } = src
  const v = d.verdict
  const outcomeTone: Tone = d.fill ? (d.fill.side === 'buy' ? 'up' : 'down') : d.outcome === 'blocked' ? 'warn' : d.outcome === 'error' ? 'down' : 'muted'
  if (!v) return { gates: [], word: d.fill ? (d.fill.side === 'buy' ? 'BUY' : 'SELL') : realtimeRuleLabel(d.rule).toUpperCase(), tone: outcomeTone, rule: d.fill ? realtimeRuleLabel(d.rule) : undefined }
  const p = (a: RealtimeAction): number => v.probabilities[a] ?? 0
  const held = v.reversal !== undefined || v.trendIntact !== undefined
  const gates: Gate[] = []
  let open = true
  const gate = (name: string, value: string, test: string, pass: boolean): void => {
    gates.push({ name, value, test, pass, reached: open })
    if (open && !pass) open = false
  }
  if (held) {
    if (v.reversal !== undefined) gate('reversal', pct(v.reversal), `< ${pct(g.reversalThreshold)}`, v.reversal < g.reversalThreshold)
    if (v.trendIntact !== undefined) gate('intact', pct(v.trendIntact), `> ${pct(1 - g.sellThreshold)}`, v.trendIntact > 1 - g.sellThreshold)
    gate('down', pct(p('sell')), `< ${pct(g.sellThreshold)}`, p('sell') < g.sellThreshold)
    const sold = !open
    return { gates, word: sold ? 'SELL' : 'HOLD', tone: sold ? (d.fill ? 'down' : outcomeTone) : 'text', rule: d.fill ? undefined : sold ? realtimeRuleLabel(d.rule) : undefined }
  }
  gate('up', pct(p('buy')), `≥ ${pct(g.buyThreshold)}`, p('buy') >= g.buyThreshold)
  if (v.extended !== undefined) gate('extended', pct(v.extended), `< ${pct(g.maxExtended)}`, v.extended < g.maxExtended)
  if (v.setup !== undefined) gate('setup', v.setup.toFixed(2), `≥ ${g.minSetup.toFixed(1)}`, v.setup >= g.minSetup)
  if (v.regime !== undefined) gate('carrying', v.regime.toFixed(2), `≥ ${g.minRegime.toFixed(1)}`, v.regime >= g.minRegime)
  if (v.repeatFail !== undefined) gate('repeat', pct(v.repeatFail), `< ${pct(g.maxRepeat)}`, v.repeatFail < g.maxRepeat)
  if (!open) return { gates, word: 'HOLD', tone: 'text' }
  // Every model gate passed: the engine's own rules had the last word.
  if (d.fill) return { gates, word: 'BUY', tone: 'up' }
  return { gates, word: d.outcome === 'blocked' ? 'HELD' : 'HOLD', tone: outcomeTone, rule: realtimeRuleLabel(d.rule) }
}

function GateChain({ chain, id }: { chain: Chain; id: string }): JSX.Element {
  let i = 0
  const delay = (): React.CSSProperties => ({ animationDelay: `${i++ * 70}ms` })
  return (
    <div key={id} className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5" title="The checks in the order the engine applies them: each with the number the model gave and whether it let the trade through. A ✗ settles it; later checks are not reached.">
      {chain.gates.map((x) => (
        <Fragment key={x.name}>
          <span className="rt-chip inline-flex items-center gap-1 rounded-full px-2 h-[22px] text-[11px] mono nums" style={{ ...TONE_STYLE[x.pass ? 'up' : 'down'], ...delay(), opacity: x.reached ? 1 : 0.4 }} title={x.reached ? undefined : 'Not reached — an earlier check had already decided.'}>
            <span className="text-text-2">{x.name}</span>
            <span className="font-semibold">{x.value}</span>
            <span className="text-text-2">{x.test}</span>
            <span className="font-bold">{x.pass ? '✓' : '✗'}</span>
          </span>
          <span className="text-text-3 text-xs">→</span>
        </Fragment>
      ))}
      <span className="rt-chip inline-flex items-center gap-1.5 rounded-full px-2.5 h-[22px] text-[11.5px] font-bold tracking-wide" style={{ ...TONE_STYLE[chain.tone], ...delay() }}>
        {chain.word}
        {chain.rule && <span className="font-medium normal-case tracking-normal opacity-80">· {chain.rule}</span>}
      </span>
    </div>
  )
}

/* ───────────────────────────── the panel ───────────────────────────── */

const QUIET = new Set(['quiet', 'quiet.band'])

export function DecisionPanel({ config, symbol, latest, judged, state }: { config: RealtimeConfig; symbol: string; latest: DecisionAt | null; judged: DecisionAt | null; state: RealtimeState }): JSX.Element {
  const g = config.guardrails
  const v = judged?.d.verdict ?? null
  // Fresh: this very tick asked the model. Standing: the newest tick was
  // quiet, so the answers below are the last ones given and still hold.
  const fresh = latest !== null && latest.d.verdict !== undefined
  const standing = latest !== null && judged !== null && !fresh && QUIET.has(latest.d.rule)
  const chainSrc = latest && !QUIET.has(latest.d.rule) ? latest : judged
  const chain = chainSrc ? chainFor(chainSrc, g) : null
  const headlineDecision = chainSrc?.d ?? null
  const headline = headlineDecision?.fill ? (headlineDecision.fill.side === 'buy' ? 'BUY' : 'SELL') : v ? DIRECTION[v.action].toUpperCase() : headlineDecision ? realtimeRuleLabel(headlineDecision.rule).toUpperCase() : '—'
  const headlineColor = headlineDecision?.fill ? (headlineDecision.fill.side === 'buy' ? 'var(--color-up)' : 'var(--color-down)') : v ? COLOR[v.action] : headlineDecision?.outcome === 'blocked' ? WARN : 'var(--color-muted)'
  const headlinePct = useRolling(v ? (v.probabilities[v.action] ?? 0) : 0)
  const offered = v ? ORDER.filter((a) => v.probabilities[a] !== undefined) : []
  const held = v !== null && (v.reversal !== undefined || v.trendIntact !== undefined)
  const position = state.ledger.positions.find((p) => p.symbol === symbol) ?? null
  const tick = judged?.tick ?? null
  const usage = tick?.usage ?? null
  const flashKey = judged?.tick.id ?? 'none'
  return (
    <div className="flex flex-col">
      <section className="px-4 py-3.5 hair-b">
        <div className="eyebrow">Standing order</div>
        <div className="mono text-xs leading-relaxed text-text-2 mt-1.5">
          {'> '}
          {config.style || 'Disciplined intraday momentum: buy strength confirmed by trend and volume, take profits at the target, cut losses at the stop.'}
          <br />
          {'> '}long only · {g.stopLossPct}% stop · {g.takeProfitPct}% target{g.trailPct !== null ? ` · ${g.trailPct}% trail` : ''}
          {isContinuousMarket(config.assetClass) ? ' · no session, no flatten' : ` · flat by ${g.flattenAt} ET`} · buy ≥ {pct(g.buyThreshold)} · sell ≥ {pct(g.sellThreshold)}
        </div>
      </section>

      <section key={flashKey} className={cn('px-4 py-3.5 hair-b', fresh && 'rt-flash')}>
        <div className="flex items-center gap-2 mb-1">
          <div className="eyebrow">{position ? `${symbol} · next ${g.horizonMin} min — keep or close?` : `${symbol} · next ${g.horizonMin} min — open?`}</div>
          <span className="flex-1" />
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', fresh ? 'rt-live-dot' : '')} style={{ background: fresh ? 'var(--color-up)' : standing ? 'var(--color-warn)' : 'var(--color-muted)' }} />
        </div>
        {/* The status line: the call behind these answers, or why there was none. */}
        <div className="mono text-2xs text-text-3 nums leading-snug mb-2.5" title="When the model was last asked about this symbol, which versioned model answered, the round trip, and the tokens the call used at TypeSafe's list price (input tokens only; output is free).">
          {tick ? (
            <>
              asked {relTime(tick.at)}
              {tick.model ? ` · ${tick.model}` : ''}
              {tick.latencyMs !== undefined ? ` · ${Math.round(tick.latencyMs)} ms` : ''}
              {usage ? ` · ${compactNumber(usage.input)} tok · ${usd(realtimeModelCostUsd(usage.input))}` : ''}
            </>
          ) : (
            'no answer yet'
          )}
          {standing && latest && (
            <span className="text-warn">
              {' '}
              · standing — {realtimeRuleLabel(latest.d.rule).toLowerCase()} {relTime(latest.tick.at)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3.5 mb-3">
          <div className="flex items-baseline gap-3 min-w-0" style={{ color: headlineColor }}>
            <span key={headline} className="text-[28px] leading-[1.1] font-semibold tracking-[-0.01em] rt-word-pop">
              {headline}
            </span>
            {v && <span className="mono text-[20px] leading-[1.1] font-medium nums">{pct(headlinePct)}</span>}
          </div>
          <span className="flex-1" />
          {v && (
            <div className="flex flex-col items-center shrink-0 -my-1" title={`Confidence ${v.confidence.toFixed(2)}: how peaked the up / down / flat split is. 1 means all the probability on one answer; a low ring means the answers were close and the headline is a narrow win.`}>
              <Ring value={v.confidence} color={headlineColor} />
              <span className="text-2xs text-text-3 leading-none -mt-0.5">confidence</span>
            </div>
          )}
        </div>
        {headlineDecision?.fill && (
          // The fill itself, at a glance: the price in the fill's colour, then the size and what it made.
          <div className="mono text-sm nums mb-3 -mt-1.5 flex items-baseline gap-2" style={{ color: headlineColor }}>
            <span className="font-semibold text-[15px]">
              {headlineDecision.fill.side === 'buy' ? 'bought' : 'sold'} @ {money(headlineDecision.fill.price)}
            </span>
            <span className="text-muted">× {headlineDecision.fill.qty}</span>
            {headlineDecision.econ?.notional !== undefined && <span className="text-muted">{money(headlineDecision.econ.notional)}</span>}
            {headlineDecision.econ?.realized !== undefined && <span className={cn('font-semibold', headlineDecision.econ.realized >= 0 ? 'text-up' : 'text-down')}>{signedMoney(headlineDecision.econ.realized)}</span>}
          </div>
        )}

        {v && offered.length ? (
          <>
            <div className="eyebrow mt-1 mb-0.5 flex items-baseline gap-2">
              <span>Direction</span>
              <span className="normal-case tracking-normal font-normal text-text-3 truncate">where the price is after {g.horizonMin} min · the tick is the threshold</span>
            </div>
            {offered.map((a) => (
              <Gauge
                key={a}
                label={DIRECTION[a]}
                value={v.probabilities[a] ?? 0}
                on={v.action === a}
                color={COLOR[a]}
                dim={DIM[a]}
                live={fresh}
                marker={a === 'buy' && !held ? g.buyThreshold : a === 'sell' && held ? g.sellThreshold : undefined}
                pass={a === 'buy' && !held ? (v.probabilities.buy ?? 0) >= g.buyThreshold : a === 'sell' && held ? (v.probabilities.sell ?? 0) < g.sellThreshold : undefined}
                hint={a === 'buy' ? `P(higher after ${g.horizonMin} min by more than the noise). A buy needs at least ${pct(g.buyThreshold)}.` : a === 'sell' ? `P(lower after ${g.horizonMin} min by more than the noise). While holding, ${pct(g.sellThreshold)} or more closes the position.` : `P(about where it is after ${g.horizonMin} min — inside the ordinary noise, not enough to trade).`}
              />
            ))}
            {!held && (v.extended !== undefined || v.setup !== undefined || v.regime !== undefined || v.repeatFail !== undefined) && (
              <>
                <div className="eyebrow mt-2.5 mb-0.5 flex items-baseline gap-2">
                  <span>Before buying</span>
                  <span className="normal-case tracking-normal font-normal text-text-3 truncate">is the move over? · how clean is it? · does this name pay today?</span>
                </div>
                {v.extended !== undefined && <Gauge label="extended" value={v.extended} on={v.extended >= g.maxExtended} color={WARN} dim={WARN_DIM} live={fresh} marker={g.maxExtended} pass={v.extended < g.maxExtended} hint={`P(the move has already happened, so a buy now would be chasing). A buy is refused at ${pct(g.maxExtended)} or more.`} />}
                {v.setup !== undefined && (
                  <>
                    <ScoreMeter label="setup" score={v.setup} probabilities={v.setupProbabilities} confidence={v.setupConfidence} minimum={g.minSetup} levels={SETUP_LEVELS} live={fresh} what="Setup quality: how cleanly trend, flow and structure line up for a long entry with a defined risk." />
                    <LevelLabels levels={SETUP_LEVELS} />
                  </>
                )}
                {v.regime !== undefined && (
                  <>
                    <ScoreMeter label="carrying" score={v.regime} probabilities={v.regimeProbabilities} confidence={v.regimeConfidence} minimum={g.minRegime} levels={REGIME_LEVELS} live={fresh} what="How well this symbol has actually been carrying a move today, judged partly on how the agent's own trades in it turned out: chop takes the stop before the target." />
                    <LevelLabels levels={REGIME_LEVELS} />
                  </>
                )}
                {v.repeatFail !== undefined && <Gauge label="repeat" value={v.repeatFail} on={v.repeatFail >= g.maxRepeat} color={WARN} dim={WARN_DIM} live={fresh} marker={g.maxRepeat} pass={v.repeatFail < g.maxRepeat} hint={`P(a buy here repeats an entry that has already failed in this symbol today — the same tape that produced a loss). A buy is refused at ${pct(g.maxRepeat)} or more.`} />}
              </>
            )}
            {held && (
              <>
                <div className="eyebrow mt-2.5 mb-0.5 flex items-baseline gap-2">
                  <span>While holding</span>
                  <span className="normal-case tracking-normal font-normal text-text-3 truncate">is it turning against us? · does the reason to hold still stand?</span>
                </div>
                {v.reversal !== undefined && <Gauge label="reversal" value={v.reversal} on={v.reversal >= g.reversalThreshold} color={WARN} dim={WARN_DIM} live={fresh} marker={g.reversalThreshold} pass={v.reversal < g.reversalThreshold} hint={`P(a sharp reversal against the position right now — a decisive turn, not a pause). ${pct(g.reversalThreshold)} or more closes the position on its own.`} />}
                {v.trendIntact !== undefined && <Gauge label="intact" value={v.trendIntact} on={v.trendIntact > 1 - g.sellThreshold} color="var(--color-up)" dim={DIM.buy} live={fresh} marker={1 - g.sellThreshold} pass={v.trendIntact > 1 - g.sellThreshold} hint={`P(the move that justified the entry is still intact: the trend and the flow that carried it are still there). At ${pct(1 - g.sellThreshold)} or less the position is closed.`} />}
              </>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">{headlineDecision ? headlineDecision.detail : 'Nothing yet — the first check asks the model and the answers land here.'}</p>
        )}

        {chain && (
          <div className="mt-3">
            <div className="eyebrow mb-1.5 flex items-baseline gap-2">
              <span>What happened</span>
              <span className="normal-case tracking-normal font-normal text-text-3 truncate">the checks in order, then the word the engine acted on</span>
            </div>
            <GateChain chain={chain} id={chainSrc!.tick.id} />
            {chainSrc && (
              <p className={cn('text-xs mt-2 leading-snug', chainSrc.d.outcome === 'blocked' ? 'text-warn' : chainSrc.d.outcome === 'error' ? 'text-down' : 'text-muted')}>
                <span className="font-medium">{realtimeRuleLabel(chainSrc.d.rule)}</span> · {chainSrc.d.detail}
              </p>
            )}
          </div>
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
