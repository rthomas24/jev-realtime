import type { Ledger } from './ledger'
import { addDays, etClock, isTradingDay, weekdayOf } from './marketTime'

/**
 * Settled funds — the money a sale gives back, and WHEN it can buy again.
 *
 * US equities settle T+1 (since 2024-05-28): the proceeds of a sale are yours
 * on the next trading day, not the same afternoon. Whether that matters for
 * TRADING depends on the account:
 *
 *   - A CASH account may only buy with settled cash. Robinhood's Agentic
 *     account is a cash account by default: "you must wait 1 business day for
 *     funds from closing stock and option positions to settle before trading
 *     with them." So an agent that sells $200 of MU at 10:00 has $200 LESS to
 *     buy with until tomorrow, whatever its book's `cash` says.
 *   - A LIMITED MARGIN account (the optional Agentic upgrade, no borrowing, no
 *     leverage) may reuse unsettled proceeds at once. Settlement then only
 *     governs withdrawals, which is the operator's concern rather than the
 *     agent's.
 *
 * Before this the ledger held ONE `cash` number, sale proceeds were reusable
 * the same second in paper and in the live sub-ledger alike, and the only
 * settlement-aware check was the account-wide `buying_power` backstop on live
 * buys — which is the WHOLE account's number, shared by every agent, and says
 * nothing about which agent's proceeds are the unsettled ones. A paper agent
 * rehearsing a rotation strategy therefore rehearsed something a cash account
 * cannot do.
 *
 * This module is the ONE rule for both hosts and the phone:
 *   - `Ledger.unsettled` is a list of lots (proceeds + the ET date they settle),
 *     appended by every sell in `applyFill` and pruned there as they mature —
 *     tracking is unconditional and cheap; whether it BINDS is `settlementModeFor`.
 *   - `settledCash` is what a cash-account buy may spend today.
 *   - `settlementModeFor` decides the mode: a LIVE agent follows the broker's
 *     real account type when it is known (the truth beats a setting, and
 *     Robinhood would refuse the order anyway — better we refuse with the
 *     right sentence and the agent plans around it); otherwise the agent's
 *     `guardrails.settlement`, absent = not simulated (so nothing already
 *     running changes). New agents get `'cash'` — the Agentic default — so
 *     paper is an honest rehearsal.
 *
 * Node-free; mirrored to the phone verbatim (`npm run sync:shared`).
 */

/** Trading days between a fill and its proceeds being spendable in a cash account. */
export const SETTLEMENT_DAYS = 1

export type SettlementMode = 'cash' | 'margin'

export const SETTLEMENT_LABEL: Record<SettlementMode, string> = {
  cash: 'Cash account — buys use settled cash (T+1)',
  margin: 'Limited margin — sale proceeds reusable at once'
}

/** Sale proceeds that are in `cash` but not yet spendable in a cash account. */
export interface UnsettledLot {
  /** Proceeds, in cents-rounded dollars — the same number `cash` moved by. */
  amount: number
  /** The sell's timestamp. */
  ts: string
  /** ET date ("YYYY-MM-DD") on which the proceeds become settled. */
  settlesOn: string
  fillId?: string
}

/**
 * The ET date a fill's proceeds settle: `SETTLEMENT_DAYS` TRADING days after
 * the fill's ET trade date. A Friday sale settles Monday; a sale the day before
 * a holiday settles the day after it. An after-hours fill carries its own
 * session's trade date (the ET date), which is what the broker does too.
 */
export function settlesOn(fillTs: string | Date): string {
  let date = etClock(fillTs instanceof Date ? fillTs : new Date(fillTs)).date
  for (let i = 0; i < SETTLEMENT_DAYS; i++) {
    date = addDays(date, 1)
    while (!isTradingDay(date)) date = addDays(date, 1)
  }
  return date
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The lots still unsettled on `etDate` (settling strictly after it). */
export function unsettledLots(ledger: Pick<Ledger, 'unsettled'>, etDate: string): UnsettledLot[] {
  return (ledger.unsettled ?? []).filter((l) => l.settlesOn > etDate)
}

/** Dollars of `cash` that are unsettled sale proceeds on `etDate`. */
export function unsettledCash(ledger: Pick<Ledger, 'unsettled'>, etDate: string): number {
  return round2(unsettledLots(ledger, etDate).reduce((s, l) => s + l.amount, 0))
}

/**
 * What a cash-account buy may spend on `etDate`: cash minus the proceeds that
 * have not settled yet, floored at zero. A buy that spends settled cash leaves
 * the unsettled lots untouched, so after "sell $200, buy $300 of a $500 book"
 * cash is $200 and every dollar of it is unsettled — settled cash is $0, which
 * is exactly what the broker would say.
 */
export function settledCash(ledger: Pick<Ledger, 'cash' | 'unsettled'>, etDate: string): number {
  return round2(Math.max(0, ledger.cash - unsettledCash(ledger, etDate)))
}

/**
 * The broker's account type, as `get_accounts` reports it (`type: "margin" |
 * "cash"`), read as a settlement mode. Unknown or absent = null: the caller
 * falls back to the agent's own setting rather than guessing.
 */
export function brokerSettlementMode(accountType: string | null | undefined): SettlementMode | null {
  if (!accountType) return null
  const t = accountType.toLowerCase()
  if (t.includes('margin')) return 'margin'
  if (t.includes('cash')) return 'cash'
  return null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "YYYY-MM-DD" → "Tue, Sep 8" — no Date, no host clock, no locale. */
export function describeSettlesOn(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${weekdayOf(date)}, ${MONTHS[(m ?? 1) - 1]} ${d}`
}

/**
 * The unsettled money, grouped by the day it settles, as a phrase:
 * "$200.00 settles Tue, Sep 8; $50.00 settles Wed, Sep 9". Empty when nothing
 * is unsettled.
 */
export function describeUnsettled(ledger: Pick<Ledger, 'unsettled'>, etDate: string, money: (n: number) => string): string {
  const byDay = new Map<string, number>()
  for (const l of unsettledLots(ledger, etDate)) byDay.set(l.settlesOn, round2((byDay.get(l.settlesOn) ?? 0) + l.amount))
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, amt]) => `${money(amt)} settles ${describeSettlesOn(day)}`)
    .join('; ')
}
