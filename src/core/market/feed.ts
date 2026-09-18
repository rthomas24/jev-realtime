import type { Quote } from '@shared/ipc'
import { etClock } from '@shared/marketTime'

/** One OHLCV bar; `t` is epoch SECONDS. */
export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** Bar interval the engine asks for; each feed maps it to its own vocabulary. */
export type BarInterval = 'day' | '5minute'

/**
 * A source of prices. The tick, the tape fallback and the paper broker are
 * written against THIS, so where a quote comes from is one decision.
 * `quotes` answers `failed` separately: "no symbols" and "asked and could not
 * get them" call for different behaviour downstream.
 */
export interface PriceFeed {
  readonly id: 'feed'
  quotes(symbols: string[]): Promise<{ quotes: Quote[]; failed: string[] }>
  bars(symbols: string[], startIso: string, interval: BarInterval): Promise<Record<string, Bar[]>>
}

/** Normalise the way every feed does: upper-case, de-duplicated, empties dropped. */
export function normSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))]
}

/** The bars of the LAST session present in a series (by ET date). */
export function lastSessionBars(bars: Bar[]): Bar[] {
  if (!bars.length) return bars
  const lastDay = etClock(new Date(bars[bars.length - 1].t * 1000)).date
  return bars.filter((b) => etClock(new Date(b.t * 1000)).date === lastDay)
}
