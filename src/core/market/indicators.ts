import type { Bar } from './feed'
import { etClock, OPEN_MINUTES } from '@shared/marketTime'

/**
 * Pure technical indicators computed in code and injected as ground truth —
 * the model never has to derive math from raw bars.
 */
export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null
  const k = 2 / (period + 1)
  let e = closes.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k)
  return e
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/** Volume-weighted average price over intraday bars (typical price × volume). */
export function vwap(bars: Bar[]): number | null {
  let pv = 0
  let vol = 0
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3
    pv += typical * b.v
    vol += b.v
  }
  return vol > 0 ? pv / vol : null
}

export interface SymbolAnalysis {
  symbol: string
  last: number | null
  dayOpen: number | null
  dayHigh: number | null
  dayLow: number | null
  vwap: number | null
  rsi14: number | null
  ema9: number | null
  ema21: number | null
  /** Today's volume so far vs the 30-day average full-day volume. */
  volVsAvg: number | null
  /** % from prior close to the day open (gap). */
  gapPct: number | null
  /** Wilder's 14-day average true range, in dollars (daily bars). */
  atr14: number | null
  /**
   * Average daily range over the last 14 completed sessions, as % of the close
   * — the number a trail width has to be judged against (loss audit §2.1).
   */
  dailyRangePct: number | null
  /** Minutes since 09:30 ET at the last intraday bar (null before the open / no bars). */
  minutesSinceOpen: number | null
  /** The first 15 minutes' high/low — the opening range an entry is often chasing. */
  openingRange: { high: number; low: number } | null
  /** % of the last price above (+) or below (−) the day's open. */
  fromOpenPct: number | null
  /** % of the last price above (+) or below (−) VWAP. */
  vsVwapPct: number | null
}

/** Wilder's ATR over daily bars; null with fewer than `period + 1` bars. */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null
  const tr: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const pc = bars[i - 1].c
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)))
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period
  return a
}

/** Mean of (high − low) / close over the last `period` bars, as a percentage. */
export function averageDailyRangePct(bars: Bar[], period = 14): number | null {
  const recent = bars.filter((b) => b.c > 0 && b.h >= b.l).slice(-period)
  if (!recent.length) return null
  return (recent.reduce((s, b) => s + (b.h - b.l) / b.c, 0) / recent.length) * 100
}

/**
 * Derive one symbol's analysis from daily bars (RSI/EMA/avg volume) and
 * intraday bars for the CURRENT last session (VWAP, day range, gap).
 */
export function analyzeSymbol(symbol: string, dayBars: Bar[], intraBars: Bar[], prevClose?: number): SymbolAnalysis {
  const dayCloses = dayBars.map((b) => b.c).filter((v) => v > 0)
  const today = intraBars
  const dayOpen = today[0]?.o ?? null
  const dayHigh = today.length ? Math.max(...today.map((b) => b.h)) : null
  const dayLow = today.length ? Math.min(...today.map((b) => b.l)) : null
  const todayVol = today.reduce((s, b) => s + b.v, 0)
  // Exclude the (possibly partial) last daily bar from the volume average.
  const volHistory = dayBars.slice(0, -1).slice(-30).map((b) => b.v).filter((v) => v > 0)
  const avgVol = volHistory.length ? volHistory.reduce((s, v) => s + v, 0) / volHistory.length : 0
  const pc = prevClose ?? (dayBars.length >= 2 ? dayBars[dayBars.length - 2].c : undefined)
  const last = today.length ? today[today.length - 1].c : (dayCloses[dayCloses.length - 1] ?? null)
  const v = vwap(today)
  // The last daily bar is the session in progress (or the last one) — the range
  // statistics want COMPLETED sessions, so it is excluded when intraday bars
  // say today is still being written.
  const completed = today.length ? dayBars.slice(0, -1) : dayBars
  // Bar times are epoch SECONDS; minutes since the 09:30 open, from the last bar.
  const lastT = today.length ? today[today.length - 1].t : null
  const minutesSinceOpen = lastT !== null ? minutesAfterOpen(lastT) : null
  const first15 = today.filter((b) => minutesAfterOpen(b.t) < 15)
  return {
    symbol,
    last,
    dayOpen,
    dayHigh,
    dayLow,
    vwap: v,
    rsi14: rsi(dayCloses.slice(-60)),
    ema9: ema(dayCloses.slice(-60), 9),
    ema21: ema(dayCloses.slice(-60), 21),
    volVsAvg: avgVol > 0 && todayVol > 0 ? todayVol / avgVol : null,
    gapPct: pc && dayOpen ? ((dayOpen - pc) / pc) * 100 : null,
    atr14: atr(completed.slice(-60)),
    dailyRangePct: averageDailyRangePct(completed),
    minutesSinceOpen,
    openingRange: first15.length ? { high: Math.max(...first15.map((b) => b.h)), low: Math.min(...first15.map((b) => b.l)) } : null,
    fromOpenPct: last !== null && dayOpen ? ((last - dayOpen) / dayOpen) * 100 : null,
    vsVwapPct: last !== null && v ? ((last - v) / v) * 100 : null
  }
}

/** Minutes after 09:30 ET for an epoch-seconds bar time (negative before the open). */
function minutesAfterOpen(tSeconds: number): number {
  return etClock(new Date(tSeconds * 1000)).minutes - OPEN_MINUTES
}
