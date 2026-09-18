import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { money } from '@shared/ledger'

export { money }

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** '+$12.34' / '−$5.00' with a proper minus sign. */
export function signedMoney(n: number): string {
  return `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`
}

/** '+1.23%' from a fraction (0.0123). */
export function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
}

/** Green/red/neutral text class for a P&L number (±0.4¢ neutral band). */
export function pnlClass(n: number | undefined): string {
  if (n === undefined) return 'text-muted'
  return n > 0.004 ? 'text-up' : n < -0.004 ? 'text-down' : 'text-muted'
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const d = now - t
  if (d < 45_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  const date = new Date(t)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' })
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function countdown(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso).getTime() - now
  if (d <= 0) return 'now'
  const m = Math.floor(d / 60_000)
  if (m < 1) return `${Math.floor(d / 1000)}s`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * Big counts, short. Pairs with `compactNumber` in the phone's own
 * `src/lib/format.ts` — these two files are deliberate counterparts rather than
 * a shared module, so the name and the thresholds are kept identical on purpose.
 *
 * Two decimals in the millions, one in the billions. A token count is read for
 * its magnitude but also compared against the last one, and `1.0M` throws away
 * the difference between 1.01M and 1.09M — a 90k gap — on the one screen where
 * someone is watching usage climb. `1.02M` costs a character and keeps it.
 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '—'
  // The thresholds are the ROUNDED boundaries, not the round numbers, because
  // rounding is what pushes a value into the next unit: 999,999 divided by 1000
  // and fixed to 1dp is "1000.0k", which reads as a bug. Promote at the point
  // the smaller unit would render four digits — 999,950 for k, and the same
  // shape a thousand-fold up for M.
  if (n >= 999_950_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Dollars for a bill that is mostly cents: the model's list price is $0.042
 * per million input tokens, so a day reads `$0.0031` and a month `$0.42`.
 * Two decimals would show `$0.00` for a week; the precision follows the size.
 */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  // One call is a few millionths of a dollar: two significant figures, never an exponent.
  if (n < 0.01) return `$${Number(n.toPrecision(2)).toFixed(Math.max(2, -Math.floor(Math.log10(n)) + 1))}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}
