/**
 * US equity market time helpers — the single source of truth for "what time is
 * it in New York", "is the regular session open", and "what is the next trading
 * day". Pure (no Electron, no Node APIs) so it runs in main, renderer and the
 * cloud worker alike. DST is handled by the IANA zone via Intl.
 */

export const ET_ZONE = 'America/New_York'
export const OPEN_MINUTES = 9 * 60 + 30 // 09:30 ET
export const CLOSE_MINUTES = 16 * 60 // 16:00 ET

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
export const WEEKDAYS: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const TRADING_WEEKDAYS: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

/** NYSE full-day closures (yyyy-mm-dd). Extend yearly. */
export const NYSE_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
])

/** Early closes at 13:00 ET (yyyy-mm-dd). */
export const NYSE_HALF_DAYS = new Set<string>(['2026-11-27', '2026-12-24', '2027-11-26'])

export interface EtClock {
  /** yyyy-mm-dd in ET */
  date: string
  /** minutes since midnight ET */
  minutes: number
  weekday: Weekday
  hour: number
  minute: number
  second: number
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

export function etClock(at: Date = new Date()): EtClock {
  const parts = fmt.formatToParts(at)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  let hour = Number(get('hour'))
  if (hour === 24) hour = 0
  const minute = Number(get('minute'))
  const second = Number(get('second'))
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + minute,
    weekday: get('weekday') as Weekday,
    hour,
    minute,
    second
  }
}

/** Offset (ms) of ET from UTC at the given instant (negative, e.g. -4h in summer). */
export function etOffsetMs(at: Date): number {
  const c = etClock(at)
  const asUtc = Date.UTC(
    Number(c.date.slice(0, 4)),
    Number(c.date.slice(5, 7)) - 1,
    Number(c.date.slice(8, 10)),
    c.hour,
    c.minute,
    c.second
  )
  // Drop sub-second so the comparison is exact.
  const instant = Math.floor(at.getTime() / 1000) * 1000
  return asUtc - instant
}

/** Build the instant for `date` (yyyy-mm-dd, ET) at `minutes` since midnight ET. */
export function etDateTime(date: string, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number)
  // First guess using the offset at noon UTC that day, then correct once (DST edges).
  const guess = new Date(Date.UTC(y, m - 1, d, 12))
  let off = etOffsetMs(guess)
  let t = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60_000 - off
  const off2 = etOffsetMs(new Date(t))
  if (off2 !== off) t = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60_000 - off2
  return new Date(t)
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number)
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sun
  return (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as Weekday[])[idx]
}

export function isTradingDay(date: string): boolean {
  const w = weekdayOf(date)
  if (w === 'Sat' || w === 'Sun') return false
  return !NYSE_HOLIDAYS.has(date)
}

export function sessionCloseMinutes(date: string): number {
  return NYSE_HALF_DAYS.has(date) ? 13 * 60 : CLOSE_MINUTES
}

/** True when the regular US equity session is open at `at`. */
export function isRegularSession(at: Date = new Date()): boolean {
  const c = etClock(at)
  if (!isTradingDay(c.date)) return false
  return c.minutes >= OPEN_MINUTES && c.minutes < sessionCloseMinutes(c.date)
}

/** Extended hours: 04:00–09:30 and 16:00–20:00 ET on trading days. */
export function isExtendedSession(at: Date = new Date()): boolean {
  const c = etClock(at)
  if (!isTradingDay(c.date)) return false
  const close = sessionCloseMinutes(c.date)
  return (c.minutes >= 4 * 60 && c.minutes < OPEN_MINUTES) || (c.minutes >= close && c.minutes < 20 * 60)
}

export type SessionLabel = 'open' | 'pre' | 'after' | 'closed'
export function sessionLabel(at: Date = new Date()): SessionLabel {
  if (isRegularSession(at)) return 'open'
  const c = etClock(at)
  if (!isTradingDay(c.date)) return 'closed'
  if (c.minutes < OPEN_MINUTES) return c.minutes >= 4 * 60 ? 'pre' : 'closed'
  return c.minutes < 20 * 60 ? 'after' : 'closed'
}

/** Does this date close early (13:00 ET)? */
export const isHalfDay = (date: string): boolean => NYSE_HALF_DAYS.has(date)

/**
 * Minutes left in today's regular session, or null when it is not open.
 * The agent needs this on every tick: "I'll decide next time" is either fine or
 * a missed exit, and a cadence alone does not say which.
 */
export function minutesToClose(at: Date = new Date()): number | null {
  if (!isRegularSession(at)) return null
  const c = etClock(at)
  return sessionCloseMinutes(c.date) - c.minutes
}

/** The next session open strictly after `at`. */
export function nextSessionOpen(at: Date = new Date()): Date {
  const c = etClock(at)
  let date = c.date
  if (!(isTradingDay(date) && c.minutes < OPEN_MINUTES)) date = addDays(date, 1)
  while (!isTradingDay(date)) date = addDays(date, 1)
  return etDateTime(date, OPEN_MINUTES)
}

/** Parse 'HH:MM' (24h) → minutes; null when malformed. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

export function formatMinutes(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

/**
 * Short ET time label for an instant, e.g. "3:58 PM ET".
 *
 * An unreadable instant renders as "unknown time" rather than throwing. This is
 * a LABEL: the worst honest outcome is a line that cannot say when, and it is
 * never worth more than that.
 *
 * It used to throw, and the blast radius was out of all proportion. One message
 * row written without a `ts` (a hand-inserted note, 2026-08-24) made
 * `transcriptBlock` throw `RangeError: Invalid time value` while composing the
 * prompt — so EVERY subsequent run of that agent failed, forever, before it
 * reached the model. A single malformed row bricked the agent, and the thread
 * that would have explained it was the thing that could not be rendered.
 */
export function formatEt(at: Date | string | number, withDate = false): string {
  // `null` and `undefined` are checked BEFORE constructing the Date, because
  // `new Date(null)` is not invalid — it is the epoch, and would render a
  // missing timestamp as "Wed 12/31 7:00 PM ET" in 1969. A confident wrong
  // answer is worse than the crash this replaced, not better.
  if (at === null || at === undefined) return 'unknown time'
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return 'unknown time'
  const c = etClock(d)
  const time = `${formatMinutes(c.minutes)} ET`
  if (!withDate) return time
  const today = etClock().date
  if (c.date === today) return `Today ${time}`
  if (c.date === addDays(today, 1)) return `Tomorrow ${time}`
  return `${c.weekday} ${c.date.slice(5).replace('-', '/')} ${time}`
}
