import { useMemo } from 'react'
import { useRealtime } from '@renderer/store/realtimeStore'
import type { RealtimeTick } from '@shared/realtimeAgents'
import type { DecisionAt } from './DecisionPanel'

/**
 * Reading one symbol's checks out of the page's tick list, in the one place
 * that knows how: the newest decision for it, and the newest one the model
 * actually answered. On a quiet tick those differ, and every consumer needs
 * the same pair — the verdict panel, a grid tile, the activity strip.
 */
const NO_TICKS: RealtimeTick[] = []

/** Every tick the page holds for an agent, falling back to the state's own short ring. */
export function useAgentTicks(agentId: string): RealtimeTick[] {
  const page = useRealtime((s) => s.ticks[agentId]) ?? NO_TICKS
  const recent = useRealtime((s) => s.agents[agentId]?.state.recent) ?? NO_TICKS
  return page.length ? page : recent
}

export interface SymbolDecisions {
  ticks: RealtimeTick[]
  /** The newest decision for this symbol, whatever it was. */
  latest: DecisionAt | null
  /** The newest one that carries a verdict — what the model last actually said. */
  judged: DecisionAt | null
}

export function useSymbolDecisions(agentId: string, symbol: string): SymbolDecisions {
  const ticks = useAgentTicks(agentId)
  return useMemo(() => {
    let latest: DecisionAt | null = null
    let judged: DecisionAt | null = null
    for (let i = ticks.length - 1; i >= 0 && !(latest && judged); i--) {
      const d = ticks[i].decisions.find((x) => x.symbol === symbol)
      if (!d) continue
      latest ??= { tick: ticks[i], d }
      if (d.verdict) judged ??= { tick: ticks[i], d }
    }
    return { ticks, latest, judged }
  }, [ticks, symbol])
}
