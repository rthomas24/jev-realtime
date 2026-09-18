/**
 * Real-time agents (2026-09-17): the tick's order of operations and the
 * code-owned half of every decision, driven with a scripted System One model.
 *
 *   - an engine exit (stop / trail / target / flatten) sells BEFORE the model is asked
 *   - the model's buy becomes an order only past the threshold and inside the entry rules
 *   - a sell verdict or a reversal closes the whole position; the pass is spent
 *   - quiet ticks (no price change) never call the model; off-session ticks decide nothing
 *   - the day-loss lock stops buys and only buys; no key means no decision, said so
 *   - the answers are read back by the ids the situation handed out, never by parsing keys
 *   - a crypto agent (continuous market) decides at any hour, never flattens, has no entry
 *     window, settles at once, and describes itself to the model without a bell
 *   - the quiet band: a tape that moved less than the noise since the model last saw it,
 *     with the same symbols held, inside the re-ask window, is answered from the last
 *     verdict — no call, no tokens; the bill is kept per day and all time
 *
 * Run: `npm run check`
 */
import { emptyLedger } from '@shared/ledger'
import { etDateTime } from '@shared/marketTime'
import { realtimeRuleLabel, clampRealtimeGuardrails, emptyRealtimeState, normCryptoSymbol, normRealtimeSymbols, realtimeConfigProblem, realtimeUsage, REALTIME_DEFAULTS, REALTIME_JEV_USD_PER_MTOK_INPUT, sumRealtimeUsage, type RealtimeConfig, type RealtimeState } from '@shared/realtimeAgents'
import type { Decider } from '@core/realtime/jev'
import { entriesClosed, entrySize, exitTrigger, newExit, verdictIntent } from '@core/realtime/policy'
import { buildSituation } from '@core/realtime/situation'
import { readVerdicts, runRealtimeTick } from '@core/realtime/tick'
import type { Quote } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// A Wednesday in the regular session, ET.
const DAY = '2026-09-16'
const at = (hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  return etDateTime(DAY, h * 60 + m)
}
const cfg: RealtimeConfig = {
  id: 'rt_test',
  name: 'Test',
  assetClass: 'stocks',
  symbols: ['NVDA', 'AAPL'],
  allocation: 10_000,
  intervalSec: 15,
  guardrails: clampRealtimeGuardrails({ ...REALTIME_DEFAULTS, trailPct: 1, stopLossPct: 1, takeProfitPct: 2, maxEntryExtensionPct: null }),
  status: 'running',
  style: '',
  createdAt: '2026-09-16T12:00:00.000Z',
  updatedAt: '2026-09-16T12:00:00.000Z'
}
const q = (symbol: string, last: number): Quote => ({ symbol, last, bid: last - 0.01, ask: last + 0.01, ts: 'x' })

/**
 * A model that answers what the script tells it to, and records what it was
 * asked. `buy` scripts P(up), `sell` P(down); the rest are the other atomic
 * questions, with calm defaults (not extended, clean setup, no reversal,
 * trend intact) so a test that scripts only the direction reads as before.
 */
function scripted(script: Record<string, { buy?: number; sell?: number; extended?: number; setup?: number; reversal?: number; intact?: number }>): Decider & { calls: number; askedKeys: string[]; lastRetries: number | undefined } {
  const d = {
    model: 'jev-test',
    calls: 0,
    askedKeys: [] as string[],
    lastRetries: undefined as number | undefined,
    async decide(_state: Record<string, unknown>, questions: Record<string, { type: string }>, opts: { retries?: number }) {
      d.calls++
      d.askedKeys = Object.keys(questions)
      d.lastRetries = opts.retries
      const answers: Record<string, unknown> = {}
      for (const [key, qq] of Object.entries(questions)) {
        const [sym, kind] = key.split('__')
        const s = script[sym] ?? {}
        if (qq.type === 'choice') {
          const up = s.buy ?? 0.2
          const down = s.sell ?? 0.2
          const p = { up, down, flat: Math.max(0, 1 - up - down) }
          const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0]
          answers[key] = { type: 'choice', choice, confidence: Math.max(...Object.values(p)), probabilities: p }
        } else if (qq.type === 'score') {
          const setup = s.setup ?? 2
          answers[key] = { type: 'score', score: setup, confidence: 0.8, probabilities: {}, legend: {} }
        } else {
          const noul = kind === 'extended' ? (s.extended ?? 0.1) : kind === 'reversal' ? (s.reversal ?? 0.1) : kind === 'intact' ? (s.intact ?? 0.9) : 0.1
          answers[key] = { type: 'noul', noul }
        }
      }
      return { answers: answers as never, usage: { input: 500, output: 20 }, model: 'jev-test' }
    }
  }
  return d
}

const base = (): RealtimeState => emptyRealtimeState(cfg.allocation)
const run = (state: RealtimeState, now: Date, quotes: Quote[], decider: Decider | null) => runRealtimeTick({ cfg, state, now, quotes, failed: [], intraBars: {}, dayBars: {}, decider, modelTimeoutMs: 1000 })

async function main(): Promise<void> {
  console.log('— the model buys, past the threshold, inside the rules —')
  {
    const jev = scripted({ NVDA: { buy: 0.8 }, AAPL: { buy: 0.55 } })
    const r = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], jev)
    const nv = r.tick.decisions.find((d) => d.symbol === 'NVDA')!
    const ap = r.tick.decisions.find((d) => d.symbol === 'AAPL')!
    check('NVDA at P(buy)=0.80 fills', nv.outcome === 'filled' && nv.rule === 'jev.buy' && nv.fill?.side === 'buy', `${nv.rule} ${nv.outcome}`)
    check('AAPL at P(buy)=0.55 is held under the 0.70 threshold', ap.outcome === 'held' && ap.rule === 'jev.belowThreshold', `${ap.rule} ${ap.outcome}`)
    check('the buy is sized to 25% of the allocation', nv.econ !== undefined && Math.abs(nv.econ.notional - 2500) < 5, `${nv.econ?.notional}`)
    check('the fill arms a stop 1% under and a target 2% over the fill', (() => {
      const ex = r.state.exits.NVDA
      return ex !== undefined && Math.abs(ex.stop - ex.entryPrice * 0.99) < 1e-6 && Math.abs(ex.target - ex.entryPrice * 1.02) < 1e-6
    })())
    check('both symbols asked in ONE request — direction, extended and setup for each flat one', jev.calls === 1 && jev.askedKeys.join() === 'NVDA__direction,NVDA__extended,NVDA__setup,AAPL__direction,AAPL__extended,AAPL__setup', jev.askedKeys.join())
    check('the day anchor is set on the first tick', r.state.dayDate === DAY && r.state.dayStartEquity === 10_000)

    console.log('\n— holding: the model is asked sell-or-hold plus the reversal question —')
    const jev2 = scripted({ NVDA: { sell: 0.3, reversal: 0.2 }, AAPL: { buy: 0.1 } })
    const r2 = await run(r.state, at('10:05'), [q('NVDA', 100.5), q('AAPL', 201)], jev2)
    check('NVDA (held) asked __direction, __reversal and __intact; not extended/setup', jev2.askedKeys.includes('NVDA__direction') && jev2.askedKeys.includes('NVDA__reversal') && jev2.askedKeys.includes('NVDA__intact') && !jev2.askedKeys.includes('NVDA__setup'), jev2.askedKeys.join())
    const held = r2.tick.decisions.find((d) => d.symbol === 'NVDA')!
    check('P(sell)=0.30 holds', held.outcome === 'held' && held.rule === 'jev.hold', `${held.rule}`)
    check('the high ratchets with the price', r2.state.exits.NVDA.high === 100.5)

    console.log('\n— a sell verdict past the threshold closes the whole position —')
    const jev3 = scripted({ NVDA: { sell: 0.75 }, AAPL: {} })
    const r3 = await run(r2.state, at('10:10'), [q('NVDA', 101), q('AAPL', 201)], jev3)
    const sold = r3.tick.decisions.find((d) => d.symbol === 'NVDA')!
    check('sold on jev.sell with realized P&L on the card', sold.outcome === 'filled' && sold.rule === 'jev.sell' && sold.fill?.side === 'sell' && sold.econ?.realized !== undefined && sold.econ.realized > 0, `${sold.rule} ${sold.econ?.realized}`)
    check('the position and its exits are gone', r3.state.ledger.positions.length === 0 && r3.state.exits.NVDA === undefined)
    check('the book balances: cash = allocation + realized', Math.abs(r3.state.ledger.cash - (cfg.allocation + r3.state.ledger.realizedPnl)) < 0.005, `${r3.state.ledger.cash} vs ${cfg.allocation + r3.state.ledger.realizedPnl}`)

    console.log('\n— no cooldown: the same symbol may be bought again on the very next check —')
    const jev4 = scripted({ NVDA: { buy: 0.9 } })
    const r4 = await run(r3.state, at('10:12'), [q('NVDA', 101.5), q('AAPL', 201)], jev4)
    const again = r4.tick.decisions.find((d) => d.symbol === 'NVDA')!
    check('two minutes after the sell, a buy verdict fills again', again.outcome === 'filled' && again.rule === 'jev.buy' && again.fill?.side === 'buy', `${again.rule} ${again.outcome}`)
  }

  console.log('\n— a reversal alone closes the position —')
  {
    const jev = scripted({ NVDA: { buy: 0.9 } })
    const r = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], jev)
    const jev2 = scripted({ NVDA: { sell: 0.2, reversal: 0.9 } })
    const r2 = await run(r.state, at('10:01'), [q('NVDA', 100.2), q('AAPL', 200)], jev2)
    const d = r2.tick.decisions.find((x) => x.symbol === 'NVDA')!
    check('sold on jev.reversal at 0.90 ≥ 0.85 although P(down) was 0.20', d.outcome === 'filled' && d.rule === 'jev.reversal', `${d.rule} ${d.outcome}`)
  }

  console.log('\n— the other atomic judgments veto or override the direction —')
  {
    const ext = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], scripted({ NVDA: { buy: 0.9, extended: 0.8 }, AAPL: { buy: 0.9, setup: 0.4 } }))
    const n = ext.tick.decisions.find((x) => x.symbol === 'NVDA')!
    const a = ext.tick.decisions.find((x) => x.symbol === 'AAPL')!
    check('P(up)=0.90 but extended 0.80 ≥ 0.60 → held as jev.extended, nothing bought', n.outcome === 'held' && n.rule === 'jev.extended' && ext.state.ledger.positions.length === 0, `${n.rule}`)
    check('P(up)=0.90 but setup 0.40 < 1 → held as jev.weakSetup', a.outcome === 'held' && a.rule === 'jev.weakSetup', `${a.rule}`)
    check('the verdict row carries every judgment', n.verdict?.extended === 0.8 && a.verdict?.setup === 0.4 && n.verdict?.probabilities.buy === 0.9)
    const held = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], scripted({ NVDA: { buy: 0.9 } }))
    const broken = await run(held.state, at('10:01'), [q('NVDA', 100.3), q('AAPL', 200)], scripted({ NVDA: { sell: 0.1, intact: 0.3 } }))
    const b = broken.tick.decisions.find((x) => x.symbol === 'NVDA')!
    check('trend intact 0.30 ≤ 0.40 (1 − sell threshold) → sold as jev.trendBroken', b.outcome === 'filled' && b.rule === 'jev.trendBroken', `${b.rule} ${b.outcome}`)
  }

  console.log('\n— engine exits fire BEFORE the model, and the model is not asked about a symbol that just exited —')
  {
    const jev = scripted({ NVDA: { buy: 0.9 } })
    const r = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], jev)
    const jevStop = scripted({ NVDA: { sell: 0 }, AAPL: {} })
    const r2 = await run(r.state, at('10:01'), [q('NVDA', 98.5), q('AAPL', 200.1)], jevStop)
    const d = r2.tick.decisions.find((x) => x.symbol === 'NVDA')!
    check('a 1.5% drop hits the 1% stop: exit.stop, filled', d.outcome === 'filled' && d.rule === 'exit.stop' && d.intent === 'exit', `${d.rule}`)
    check('NVDA was not in the model request', !jevStop.askedKeys.some((k) => k.startsWith('NVDA')), jevStop.askedKeys.join())

    const r3 = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], scripted({ NVDA: { buy: 0.9 } }))
    const up = await run(r3.state, at('10:01'), [q('NVDA', 103), q('AAPL', 200)], scripted({ NVDA: { sell: 0 } }))
    check('a 3% rise hits the 2% target: exit.target', up.tick.decisions.find((x) => x.symbol === 'NVDA')!.rule === 'exit.target')

    const r4 = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], scripted({ NVDA: { buy: 0.9 } }))
    const high = await run(r4.state, at('10:01'), [q('NVDA', 101.8), q('AAPL', 200)], scripted({ NVDA: { sell: 0 } }))
    const trail = await run(high.state, at('10:02'), [q('NVDA', 100.7), q('AAPL', 200)], scripted({ NVDA: { sell: 0 } }))
    const td = trail.tick.decisions.find((x) => x.symbol === 'NVDA')!
    check('the 1% trail from the 101.80 high fires at 100.70 (above the hard stop, above the entry)', td.rule === 'exit.trail' && td.outcome === 'filled' && (td.econ?.realized ?? 0) > 0, `${td.rule} ${td.econ?.realized}`)

    const r5 = await run(base(), at('15:00'), [q('NVDA', 100), q('AAPL', 200)], scripted({ NVDA: { buy: 0.9 } }))
    const flat = await run(r5.state, at('15:55'), [q('NVDA', 100.3), q('AAPL', 200)], scripted({ NVDA: { sell: 0 } }))
    check('15:55 ET flattens the position whatever the price', flat.tick.decisions.find((x) => x.symbol === 'NVDA')!.rule === 'exit.flatten')
    check('and a flat symbol at 15:55 is not asked (entries closed)', flat.tick.decisions.find((x) => x.symbol === 'AAPL')!.rule === 'entry.afterWindow')
  }

  console.log('\n— entry windows, the day-loss lock, quiet ticks, the session, the key —')
  {
    const early = await run(base(), at('09:35'), [q('NVDA', 100), q('AAPL', 200)], scripted({ NVDA: { buy: 0.99 } }))
    check('09:35 is before the 09:45 window: nothing bought, rule on each row, model not called', early.tick.decisions.every((d) => d.rule === 'entry.beforeWindow') && early.state.ledger.positions.length === 0)
    const g = cfg.guardrails
    check('entriesClosed names the lock when buys are locked', entriesClosed(g, { buyLocked: true }, { date: DAY, minutes: 600, weekday: 'Wed', hour: 10, minute: 0, second: 0 })?.rule === 'lock.dailyLoss')

    // Day-loss lock: buy at 100, mark at 97 → down $75 on a $10k book with 25%
    // sizing is 0.75%; with a 0.5% lock that locks buys, and the still-held
    // position is judged (sells stay open).
    const tight: RealtimeConfig = { ...cfg, guardrails: { ...g, maxDailyLossPct: 0.5, stopLossPct: 10, trailPct: null } }
    const t0 = await runRealtimeTick({ cfg: tight, state: base(), now: at('10:00'), quotes: [q('NVDA', 100), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: scripted({ NVDA: { buy: 0.9 } }), modelTimeoutMs: 1000 })
    const jevL = scripted({ NVDA: { sell: 0.1 }, AAPL: { buy: 0.95 } })
    const t1 = await runRealtimeTick({ cfg: tight, state: t0.state, now: at('10:01'), quotes: [q('NVDA', 97), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: jevL, modelTimeoutMs: 1000 })
    check('down 0.75% of the allocation on the day → buys locked', t1.state.buyLocked === true)
    check('AAPL (flat) is refused as lock.dailyLoss and not asked; NVDA (held) still judged', t1.tick.decisions.find((d) => d.symbol === 'AAPL')!.rule === 'lock.dailyLoss' && jevL.askedKeys.includes('NVDA__direction') && !jevL.askedKeys.includes('AAPL__direction'), jevL.askedKeys.join())

    const jevQ = scripted({ NVDA: { buy: 0.1 }, AAPL: { buy: 0.1 } })
    const q1 = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], jevQ)
    const q2 = await run(q1.state, at('10:00'), [q('NVDA', 100), q('AAPL', 200)], jevQ)
    check('identical prices → quiet tick, model called once not twice', jevQ.calls === 1 && q2.tick.skipped !== undefined && q2.tick.decisions.every((d) => d.rule === 'quiet'), `${jevQ.calls} calls`)

    const jevC = scripted({ NVDA: { buy: 0.99 } })
    const closed = await run(base(), at('16:30'), [q('NVDA', 100), q('AAPL', 200)], jevC)
    check('after the close: session.closed on every row, model not called, nothing bought', jevC.calls === 0 && closed.tick.decisions.every((d) => d.rule === 'session.closed') && closed.state.ledger.positions.length === 0)

    const noKey = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], null)
    check('no key: jev.noKey on every row and the tick says so', noKey.tick.decisions.every((d) => d.rule === 'jev.noKey') && /key/i.test(noKey.tick.skipped ?? ''))

    const unpriced = await run(base(), at('10:00'), [q('NVDA', 100)], scripted({ NVDA: { buy: 0.1 } }))
    check('a symbol the feed did not price is feed.unpriced, the other still decided', unpriced.tick.decisions.find((d) => d.symbol === 'AAPL')!.rule === 'feed.unpriced' && unpriced.tick.decisions.find((d) => d.symbol === 'NVDA')!.rule === 'jev.hold')
    const closedButTest = await runRealtimeTick({ cfg, state: base(), now: at('20:00'), quotes: [q('NVDA', 100), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: scripted({ NVDA: { buy: 0.9 } }), modelTimeoutMs: 1000, sessionOpen: true })
    check('sessionOpen: true (the test stream) lets an 8 PM tick decide; the entry window still applies', closedButTest.tick.decisions.every((d) => d.rule === 'entry.afterWindow'), closedButTest.tick.decisions.map((d) => d.rule).join())

    const failing: Decider = { model: 'x', decide: async () => { throw new Error('boom key=sk-secret-123') } }
    const err = await run(base(), at('10:00'), [q('NVDA', 100), q('AAPL', 200)], failing)
    check('a model error is jev.error on every row, recorded on the tick and the state', err.tick.decisions.every((d) => d.rule === 'jev.error') && err.tick.error !== undefined && err.state.lastError !== null && err.state.ledger.positions.length === 0)
  }

  console.log('\n— the quiet band: a barely-moved tape is answered from the last verdict, and the bill is kept —')
  {
    const t0 = at('10:00')
    const later = (sec: number): Date => new Date(t0.getTime() + sec * 1000)
    const jev = scripted({ NVDA: { buy: 0.1 }, AAPL: { buy: 0.1 } })
    const s1 = await run(base(), t0, [q('NVDA', 100), q('AAPL', 200)], jev)
    check('the first ask records when, the prices and the held set; the tokens are billed to today and all time; the model id is on the tick', s1.state.lastAsk?.prices.NVDA === 100 && s1.state.lastAsk?.held.length === 0 && s1.state.dayInputTokens === 500 && s1.state.inputTokens === 500 && s1.state.dayModelCalls === 1 && s1.tick.model === 'jev-test', JSON.stringify(s1.state.lastAsk))
    check('a 15 s agent is allowed one retry', jev.lastRetries === 1)
    const fast = scripted({ NVDA: { buy: 0.1 } })
    await runRealtimeTick({ cfg: { ...cfg, intervalSec: 1 }, state: base(), now: t0, quotes: [q('NVDA', 100), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: fast, modelTimeoutMs: 1000 })
    check('a 1 s agent gets none — the next tick is the retry, and a retried request would pay twice', fast.lastRetries === 0)

    // +1 s, both moved by 0.005%: inside the 0.02% band, asked 1 s ago → not asked.
    const s2 = await run(s1.state, later(1), [q('NVDA', 100.005), q('AAPL', 200.01)], jev)
    check('a move of 0.005% one second later is quiet.band on every row: no call, the skip counted', jev.calls === 1 && s2.tick.decisions.every((d) => d.rule === 'quiet.band' && d.outcome === 'quiet') && s2.state.modelSkips === 1 && s2.state.dayModelSkips === 1 && /last verdict stands/.test(s2.tick.skipped ?? ''), `${jev.calls} calls · ${s2.tick.decisions.map((d) => d.rule).join()}`)
    check('the band does not move the last-ask anchor, so drift accumulates against it', s2.state.lastAsk?.prices.NVDA === 100)
    // +2 s, NVDA now 0.03% from the anchor → asked, anchor moved.
    const s3 = await run(s2.state, later(2), [q('NVDA', 100.03), q('AAPL', 200.01)], jev)
    check('a 0.03% move from the anchor is asked and re-anchors', jev.calls === 2 && s3.state.lastAsk?.prices.NVDA === 100.03 && s3.state.lastAsk?.at === later(2).toISOString(), `${jev.calls} calls`)
    // +13 s, tiny move but 11 s since the last ask → asked (the time cap).
    const s4 = await run(s3.state, later(13), [q('NVDA', 100.031), q('AAPL', 200.011)], jev)
    check('11 s after the last ask a quiet tape is re-read anyway', jev.calls === 3, `${jev.calls} calls`)
    // A fill changes what is held: the next tick asks the holding questions even inside the band.
    const buyer = scripted({ NVDA: { buy: 0.9 }, AAPL: { buy: 0.1 } })
    const s5 = await run(s4.state, later(14), [q('NVDA', 100.06), q('AAPL', 200.011)], buyer)
    check('(setup) NVDA bought', s5.state.ledger.positions.length === 1)
    const s6 = await run(s5.state, later(15), [q('NVDA', 100.061), q('AAPL', 200.012)], buyer)
    check('a symbol held now but not at the last ask is asked, band or no band', buyer.calls === 2 && buyer.askedKeys.includes('NVDA__reversal'), `${buyer.calls} calls · ${buyer.askedKeys.join()}`)
    check('an engine exit still fires on a quiet tick', (await run(s6.state, later(16), [q('NVDA', 98), q('AAPL', 200.012)], buyer)).tick.decisions.find((d) => d.symbol === 'NVDA')?.rule === 'exit.stop')
    // The band off: every check asks.
    const always: RealtimeConfig = { ...cfg, guardrails: { ...cfg.guardrails, askMinMovePct: 0 } }
    const eager = scripted({ NVDA: { buy: 0.1 }, AAPL: { buy: 0.1 } })
    const a1 = await runRealtimeTick({ cfg: always, state: base(), now: t0, quotes: [q('NVDA', 100), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: eager, modelTimeoutMs: 1000 })
    await runRealtimeTick({ cfg: always, state: a1.state, now: later(1), quotes: [q('NVDA', 100.001), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: eager, modelTimeoutMs: 1000 })
    check('askMinMovePct 0 asks on every check that moved at all', eager.calls === 2, `${eager.calls} calls`)
    // Exactly equal prices are still the older, cheaper "quiet" rule.
    const same = await runRealtimeTick({ cfg: always, state: a1.state, now: later(1), quotes: [q('NVDA', 100), q('AAPL', 200)], failed: [], intraBars: {}, dayBars: {}, decider: eager, modelTimeoutMs: 1000 })
    check('identical prices stay rule quiet, not quiet.band', same.tick.decisions.every((d) => d.rule === 'quiet'))
    // The bill.
    const u = realtimeUsage(s4.state)
    check('the bill: 3 calls × 500 tokens at the list price, one skip; today equals all time on the first day', u.today.calls === 3 && u.today.input === 1500 && u.today.skips === 1 && Math.abs(u.today.usd - (1500 / 1e6) * REALTIME_JEV_USD_PER_MTOK_INPUT) < 1e-12 && u.total.usd === u.today.usd, JSON.stringify(u))
    const fleet = realtimeUsage(sumRealtimeUsage([s4.state, s6.state]))
    check('the fleet figure adds agents up', fleet.total.calls === s4.state.modelCalls + s6.state.modelCalls && fleet.total.input === s4.state.inputTokens + s6.state.inputTokens)
    // A new ET day resets today's counters and keeps the lifetime ones.
    const nextDay = await run(s4.state, etDateTime('2026-09-17', 10 * 60), [q('NVDA', 101), q('AAPL', 201)], jev)
    check('the day roll resets today, keeps all time', nextDay.state.dayModelCalls === 1 && nextDay.state.dayInputTokens === 500 && nextDay.state.modelCalls === 4 && nextDay.state.dayModelSkips === 0 && nextDay.state.modelSkips === 1, JSON.stringify(realtimeUsage(nextDay.state)))
    check('clampRealtimeGuardrails defaults the band for configs written before it existed', clampRealtimeGuardrails({}).askMinMovePct === 0.02 && clampRealtimeGuardrails({}).askAtLeastEverySec === 10 && clampRealtimeGuardrails({ askMinMovePct: -1, askAtLeastEverySec: 0 }).askMinMovePct === 0 && clampRealtimeGuardrails({ askAtLeastEverySec: 0 }).askAtLeastEverySec === 1)
  }

  console.log('\n— labels outlive the rules —')
  {
    check('a live rule keeps its phrase', realtimeRuleLabel('jev.buy') === 'Model said buy')
    // A tick log written before a rule was retired still names it, and the row must still render.
    check(
      'a retired rule reads as its own last segment instead of crashing the page',
      realtimeRuleLabel('entry.cooldown') === 'Cooldown' && realtimeRuleLabel('lock.somethingNew') === 'Something new' && realtimeRuleLabel('weird') === 'Weird',
      [realtimeRuleLabel('entry.cooldown'), realtimeRuleLabel('lock.somethingNew'), realtimeRuleLabel('weird')].join(' / ')
    )
  }

  console.log('\n— the pure rules —')
  {
    const g = cfg.guardrails
    const ex = newExit(100, g, '2026-09-16T14:00:00.000Z')
    const clock = { date: DAY, minutes: 600, weekday: 'Wed' as const, hour: 10, minute: 0, second: 0 }
    check('exitTrigger: nothing between the levels', exitTrigger(ex, 100.5, g, clock) === null)
    check('exitTrigger: with the high still at the entry, a break of the level reads as the hard stop, not the trail', exitTrigger({ ...ex, high: 100 }, 98.9, g, clock)?.rule === 'exit.stop')
    check('exitTrigger: once the high has moved up, the same break reads as the trail', exitTrigger({ ...ex, high: 102 }, 100.9, g, clock)?.rule === 'exit.trail')
    check('verdictIntent: hold when P(up) is under the threshold', verdictIntent({ action: 'buy', probabilities: { buy: 0.6, hold: 0.4 }, confidence: 0.6 }, false, g).rule === 'jev.belowThreshold')
    check('verdictIntent: an up verdict while holding is read as hold (no pyramiding)', verdictIntent({ action: 'buy', probabilities: { buy: 0.9 }, confidence: 0.9 }, true, g).intent === 'hold')
    const size = entrySize(g, 10_000, { ...emptyLedger(10_000), cash: 3, unsettled: [] }, DAY, 100)
    check('entrySize refuses a book with $3 of settled cash as cap.cash', 'rule' in size && size.rule === 'cap.cash')
    const sized = entrySize(g, 10_000, emptyLedger(10_000), DAY, 333.33)
    check('entrySize floors to 4 decimals of a share and reports the notional', !('rule' in sized) && sized.qty === Math.floor((2500 / 333.33) * 1e4) / 1e4)

    const sit = buildSituation(cfg, [{ symbol: 'NVDA', quote: q('NVDA', 100), analysis: null, intraBars: [], position: { symbol: 'NVDA', qty: 10, avgCost: 99 }, exit: ex }], clock, Date.parse('2026-09-16T14:10:00.000Z'), true)
    const st = sit.state as { instruments: Record<string, { position: Record<string, string> }> }
    check('the situation describes the position in words, not raw numbers', typeof st.instruments.NVDA.position === 'object' && /below the current price/.test(st.instruments.NVDA.position.stop) && /minute/.test(st.instruments.NVDA.position.entered), JSON.stringify(st.instruments.NVDA.position.stop))
    check('a held symbol is asked direction, reversal and intact', sit.asked.NVDA.direction === 'NVDA__direction' && sit.asked.NVDA.reversal === 'NVDA__reversal' && sit.asked.NVDA.intact === 'NVDA__intact' && sit.asked.NVDA.setup === undefined)
    check('every question is structured (question / inspect / focus; what / not_for / signals)', (() => {
      const dq = sit.questions.NVDA__direction as unknown as { instructions: { question: string; inspect: string; focus: string }; criteria: Record<string, { what: string; not_for: string; signals: string }> }
      return typeof dq.instructions.question === 'string' && dq.instructions.inspect === '`instruments.NVDA`' && ['up', 'down', 'flat'].every((k) => dq.criteria[k].what && dq.criteria[k].not_for && dq.criteria[k].signals)
    })())
    const v = readVerdicts({ NVDA__direction: { type: 'choice', choice: 'down', confidence: 0.7, probabilities: { up: 0.1, down: 0.7, flat: 0.2 } }, NVDA__reversal: { type: 'noul', noul: 0.42 }, NVDA__intact: { type: 'noul', noul: 0.55 } }, sit.asked)
    check('readVerdicts reads by the handed-out ids: down → sell, and every judgment beside it', v.NVDA.action === 'sell' && v.NVDA.probabilities.sell === 0.7 && v.NVDA.probabilities.buy === 0.1 && v.NVDA.reversal === 0.42 && v.NVDA.trendIntact === 0.55 && v.NVDA.extended === undefined)
    const stray = readVerdicts({ NVDA__direction: { type: 'choice', choice: 'sideways', confidence: 0.9, probabilities: { up: 0.1, down: 0.1, flat: 0.8 } } }, sit.asked)
    check('a choice outside up/down/flat reads as hold', stray.NVDA.action === 'hold')
    const flatSit = buildSituation(cfg, [{ symbol: 'NVDA', quote: q('NVDA', 100), analysis: null, intraBars: [], position: null, exit: null }], clock, Date.parse('2026-09-16T14:10:00.000Z'), true)
    const flatV = readVerdicts({ NVDA__direction: { type: 'choice', choice: 'up', confidence: 0.8, probabilities: { up: 0.8, down: 0.1, flat: 0.1 } }, NVDA__extended: { type: 'noul', noul: 0.2 }, NVDA__setup: { type: 'score', score: 1.3, confidence: 0.54, probabilities: { '0': 0, '1': 0.7, '2': 0.3 }, legend: {} } }, flatSit.asked)
    check('a score answer keeps its spread over the levels and its confidence beside the score', flatV.NVDA.setup === 1.3 && flatV.NVDA.setupConfidence === 0.54 && flatV.NVDA.setupProbabilities?.join() === '0,0.7,0.3' && flatV.NVDA.extended === 0.2, JSON.stringify(flatV.NVDA))
    const tapeSit = buildSituation(cfg, [{ symbol: 'NVDA', quote: q('NVDA', 100), analysis: null, intraBars: [], position: null, exit: null, tape: { symbol: 'NVDA', last: 100, lastTradeAt: Date.parse('2026-09-16T14:09:59.500Z'), bid: 99.99, ask: 100.01, bidSize: 200, askSize: 600, spreadPct: 0.02, returns: { s10: 0.05, s60: -0.12, m5: 0.3 }, flow60: { buyShares: 900, sellShares: 300, prints: 40 }, printsPerMinute: 40, recent: [99.9, 99.95, 100, 100.02, 100], updatedAt: Date.parse('2026-09-16T14:09:59.500Z') } }], clock, Date.parse('2026-09-16T14:10:00.000Z'), true)
    const tp = (tapeSit.state as { instruments: Record<string, { tape: Record<string, unknown> }> }).instruments.NVDA.tape
    check('the tape is described in words: the touch, the lean, the flow, the moves', /bid \$99\.99 × 200/.test(String(tp.touch)) && /sellers stacked/.test(String(tp.book_lean)) && /buyers lifting the offer \(75% at the ask\)/.test(String(tp.flow_last_minute)) && (tp.moves as Record<string, string>).last_10_seconds === 'up 0.050%', JSON.stringify(tp))
  }

  console.log('\n— crypto: a continuous market —')
  {
    const crypto: RealtimeConfig = { ...cfg, id: 'rt_crypto', name: 'Coins', assetClass: 'crypto', symbols: ['BTC/USD', 'ETH/USD'] }
    const runC = (state: RealtimeState, now: Date, quotes: Quote[], decider: Decider | null) => runRealtimeTick({ cfg: crypto, state, now, quotes, failed: [], intraBars: {}, dayBars: {}, decider, modelTimeoutMs: 1000 })
    const typed = normRealtimeSymbols(['btc', 'BTC-USD', 'BTCUSD', 'eth_usdt', 'sol/usd', 'x', '???'], 'crypto').join()
    check('symbols normalise to BASE/QUOTE: btc, BTC-USD, BTCUSD, eth_usdt, sol/usd', typed === 'BTC/USD,ETH/USDT,SOL/USD', typed)
    check('a bare quote currency alone is not a pair', normCryptoSymbol('USD') === null && normCryptoSymbol('usd/usd') === null)
    check('the refusal sentence talks about coins for a crypto agent', /coins/i.test(realtimeConfigProblem({ symbols: ['??'], assetClass: 'crypto' }) ?? ''))

    // 8 PM ET on a Wednesday: a stock agent would say session.closed; crypto decides and buys.
    const jev = scripted({ 'BTC/USD': { buy: 0.9 }, 'ETH/USD': { buy: 0.1 } })
    const night = await runC(emptyRealtimeState(crypto.allocation), at('20:00'), [q('BTC/USD', 60_000), q('ETH/USD', 2_400)], jev)
    const btc = night.tick.decisions.find((d) => d.symbol === 'BTC/USD')!
    check('8 PM ET: the crypto agent decides (no session) and the buy fills', jev.calls === 1 && btc.outcome === 'filled' && btc.rule === 'jev.buy' && night.tick.session === 'open', `${btc.rule} ${btc.outcome} ${night.tick.session}`)
    check('a fractional quantity of BTC is booked at 25% of the allocation', btc.fill !== undefined && btc.fill.qty < 1 && btc.fill.qty > 0 && Math.abs(btc.econ!.notional - 2500) < 5, `${btc.fill?.qty} ${btc.econ?.notional}`)

    // 15:55 ET would flatten a stock; 09:35 would be before the entry window. Neither applies.
    const late = await runC(night.state, at('15:55'), [q('BTC/USD', 60_100), q('ETH/USD', 2_400)], scripted({ 'BTC/USD': { sell: 0.1 }, 'ETH/USD': { buy: 0.1 } }))
    const held = late.tick.decisions.find((d) => d.symbol === 'BTC/USD')!
    check('15:55 ET does not flatten a crypto position; the model is asked and holds', held.rule === 'jev.hold' && late.state.ledger.positions.length === 1, held.rule)
    const early = await runC(late.state, at('09:35'), [q('BTC/USD', 60_200), q('ETH/USD', 2_401)], scripted({ 'BTC/USD': { sell: 0.1 }, 'ETH/USD': { buy: 0.9 } }))
    const eth = early.tick.decisions.find((d) => d.symbol === 'ETH/USD')!
    check('09:35 ET is not before the entry window for crypto: ETH buys', eth.outcome === 'filled' && eth.rule === 'jev.buy', `${eth.rule} ${eth.outcome}`)

    // Instant settlement: sell BTC, and the proceeds are spendable on the very next tick.
    const sold = await runC(early.state, at('10:00'), [q('BTC/USD', 60_500), q('ETH/USD', 2_402)], scripted({ 'BTC/USD': { sell: 0.9 }, 'ETH/USD': { sell: 0.1 } }))
    const sb = sold.tick.decisions.find((d) => d.symbol === 'BTC/USD')!
    check('the sell fills with no unsettled lot behind it and no settlement date on the card', sb.outcome === 'filled' && sb.fill?.side === 'sell' && (sold.state.ledger.unsettled ?? []).length === 0 && sb.econ?.settlesOn === undefined, JSON.stringify({ lots: sold.state.ledger.unsettled, settlesOn: sb.econ?.settlesOn }))
    const g = crypto.guardrails
    const sizeNow = entrySize(g, crypto.allocation, sold.state.ledger, DAY, 60_500, true)
    const sizeStock = entrySize(g, crypto.allocation, { ...sold.state.ledger, unsettled: [{ amount: sold.state.ledger.cash, ts: 'x', settlesOn: '2099-01-01' }] }, DAY, 60_500)
    check('entrySize with instant settlement spends the whole cash; the T+1 rule would refuse the same book', !('rule' in sizeNow) && 'rule' in sizeStock && sizeStock.rule === 'cap.cash')
    const lateClock = { date: DAY, minutes: 15 * 60 + 58, weekday: 'Wed' as const, hour: 15, minute: 58, second: 0 }
    check('the stops and the day-loss lock still apply', exitTrigger(newExit(100, g, '2026-09-16T14:00:00.000Z'), 98, g, lateClock, true)?.rule === 'exit.stop' && entriesClosed(g, { buyLocked: true }, lateClock, true)?.rule === 'lock.dailyLoss')
    check('exitTrigger never flattens a continuous market', exitTrigger(newExit(100, g, '2026-09-16T14:00:00.000Z'), 100.5, g, lateClock, true) === null)

    const clock = { date: DAY, minutes: 20 * 60, weekday: 'Wed' as const, hour: 20, minute: 0, second: 0 }
    const sit = buildSituation(crypto, [{ symbol: 'BTC/USD', quote: q('BTC/USD', 60_000), analysis: null, intraBars: [], position: { symbol: 'BTC/USD', qty: 0.04, avgCost: 59_000 }, exit: newExit(59_000, g, '2026-09-17T00:00:00.000Z') }], clock, Date.parse('2026-09-17T00:10:00.000Z'), true)
    const st = sit.state as { session: string; trader: { rules: string }; instruments: Record<string, { time: string; position: Record<string, string> }> }
    check('the situation says the market is open around the clock and names no flatten time', /around the clock/.test(st.session) && /around the clock/.test(st.instruments.BTC_USD.time) && !/out of everything by/.test(st.trader.rules) && st.instruments.BTC_USD.position.units === '0.04', JSON.stringify({ session: st.session, time: st.instruments.BTC_USD.time }))
    check('a pair is keyed as a path segment the model can follow (BTC/USD → instruments.BTC_USD), and the questions point at it', st.instruments['BTC/USD'] === undefined && (sit.questions['BTC/USD__direction'] as unknown as { instructions: { inspect: string } }).instructions.inspect === '`instruments.BTC_USD`')
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall ok')
  process.exit(failures ? 1 : 0)
}

void main()
