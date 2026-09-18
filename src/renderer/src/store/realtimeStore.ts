import { create } from 'zustand'
import type { RealtimeEvent } from '@shared/ipc'
import { REALTIME_PAGE_TICKS_MAX, REALTIME_SAMPLES_MAX, type RealtimeStreamKeyRequest, type RealtimeStreamStatus, type RealtimeCreateRequest, type RealtimeKeyStatus, type RealtimePriceSample, type RealtimeSummary, type RealtimeTick, type RealtimeUpdateRequest } from '@shared/realtimeAgents'

/** One point of the live line: epoch ms and the last price. */
export interface PricePoint {
  t: number
  p: number
}

/**
 * The Real time page's own store: the real-time agents (config + state), the
 * TypeSafe key status, and the selection. Separate from `appStore` because
 * these are a different kind of agent — no thread, no messages, no cloud —
 * and the thread store's event plumbing has nothing to say about them.
 */
interface RealtimeStore {
  booted: boolean
  agents: Record<string, RealtimeSummary>
  order: string[]
  selectedId: string | null
  key: RealtimeKeyStatus | null
  /** The last refusal from a create/update, for the form. */
  error: string | null
  /** The live line per symbol: seeded from the ticks' own prices, then fed by `realtime:price`. Ephemeral. */
  samples: Record<string, PricePoint[]>
  /** Every check the page has seen per agent — the state's own ring is short, the feed scrolls through these. */
  ticks: Record<string, RealtimeTick[]>
  stream: RealtimeStreamStatus | null

  boot(): Promise<void>
  refresh(): Promise<void>
  refreshKey(): Promise<void>
  select(id: string | null): void
  applyEvent(e: RealtimeEvent): void
  create(req: RealtimeCreateRequest): Promise<string | null>
  update(id: string, patch: RealtimeUpdateRequest): Promise<string | null>
  remove(id: string): Promise<void>
  setStatus(id: string, status: 'running' | 'paused'): Promise<void>
  resetPaper(id: string): Promise<void>
  tickNow(id: string): Promise<void>
  setKey(key: string): Promise<void>
  clearKey(): Promise<void>
  testKey(): Promise<void>
  refreshStream(): Promise<void>
  setStreamKey(req: RealtimeStreamKeyRequest): Promise<void>
  clearStreamKey(): Promise<void>
}

const SELECTED_KEY = 'tb:realtime-selected'
let subscribed = false

/** The page's tick list: union by id, time-ordered, bounded. */
function mergeTicks(have: RealtimeTick[], add: RealtimeTick[]): RealtimeTick[] {
  if (!add.length) return have
  const byId = new Map(have.map((t) => [t.id, t]))
  for (const t of add) byId.set(t.id, t)
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-REALTIME_PAGE_TICKS_MAX)
}

/** Append one sample per symbol, deduped on its instant, bounded. */
function addSample(prev: Record<string, PricePoint[]>, sample: RealtimePriceSample): Record<string, PricePoint[]> {
  const t = Date.parse(sample.at)
  if (!Number.isFinite(t)) return prev
  const next = { ...prev }
  for (const [symbol, p] of Object.entries(sample.prices)) {
    const cur = next[symbol] ?? []
    const last = cur[cur.length - 1]
    if (last && last.t === t) continue
    if (last && t < last.t) continue
    next[symbol] = [...cur, { t, p }].slice(-REALTIME_SAMPLES_MAX)
  }
  return next
}

/** The ticks' own prices as the opening series, so a reload shows the session so far. */
function seedSamples(ticks: RealtimeTick[], prev: Record<string, PricePoint[]>): Record<string, PricePoint[]> {
  const out: Record<string, PricePoint[]> = {}
  for (const tick of [...ticks].sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(tick.at)
    for (const d of tick.decisions) {
      if (d.price === null) continue
      const cur = out[d.symbol] ?? (out[d.symbol] = [])
      const last = cur[cur.length - 1]
      if (last && last.t >= t) continue
      cur.push({ t, p: d.price })
    }
  }
  // Live samples already held win over the seed where they overlap.
  for (const [symbol, pts] of Object.entries(prev)) {
    const seeded = out[symbol] ?? []
    const firstLive = pts[0]?.t ?? Infinity
    out[symbol] = [...seeded.filter((x) => x.t < firstLive), ...pts].slice(-REALTIME_SAMPLES_MAX)
  }
  return out
}

function errorText(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  // IPC wraps a thrown Error as "Error invoking remote method 'x': Error: <msg>".
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export const useRealtime = create<RealtimeStore>()((set, get) => ({
  booted: false,
  agents: {},
  order: [],
  selectedId: null,
  key: null,
  error: null,
  samples: {},
  ticks: {},
  stream: null,

  async boot() {
    // An app started before this page existed has no `realtime` bridge yet
    // (main and preload are not rebuilt live); boot must still finish so the
    // page can say so instead of sitting on "Loading…".
    if (typeof window.tb.realtime?.onEvent !== 'function') {
      set({ booted: true })
      return
    }
    if (!subscribed) {
      subscribed = true
      window.tb.realtime.onEvent((e) => get().applyEvent(e))
    }
    await Promise.all([get().refresh(), get().refreshKey(), get().refreshStream()])
    const stored = localStorage.getItem(SELECTED_KEY)
    const { order, selectedId } = get()
    set({ booted: true, selectedId: selectedId ?? (stored && order.includes(stored) ? stored : (order[0] ?? null)) })
  },

  async refresh() {
    try {
      const list = await window.tb.realtime.list()
      const ticks = { ...get().ticks }
      for (const s of list) ticks[s.config.id] = mergeTicks(ticks[s.config.id] ?? [], s.state.recent)
      set({ agents: Object.fromEntries(list.map((s) => [s.config.id, s])), order: list.map((s) => s.config.id), samples: seedSamples(list.flatMap((s) => s.state.recent), get().samples), ticks })
    } catch (e) {
      console.error('[realtime] could not list agents', e)
    }
  },

  async refreshStream() {
    try {
      if (typeof window.tb.realtime?.streamStatus !== 'function') return
      set({ stream: await window.tb.realtime.streamStatus() })
    } catch (e) {
      console.error('[realtime] could not read the stream status', e)
    }
  },

  async refreshKey() {
    try {
      set({ key: await window.tb.realtime.keyStatus() })
    } catch (e) {
      console.error('[realtime] could not read the key status', e)
    }
  },

  select(id) {
    set({ selectedId: id })
    if (id) localStorage.setItem(SELECTED_KEY, id)
  },

  applyEvent(e) {
    const { agents, order } = get()
    if (e.type === 'realtime:deleted') {
      const next = { ...agents }
      delete next[e.id]
      const nextOrder = order.filter((x) => x !== e.id)
      set({ agents: next, order: nextOrder, selectedId: get().selectedId === e.id ? (nextOrder[0] ?? null) : get().selectedId })
      return
    }
    if (e.type === 'realtime:updated') {
      const id = e.summary.config.id
      set({ agents: { ...agents, [id]: e.summary }, order: order.includes(id) ? order : [...order, id], ticks: { ...get().ticks, [id]: mergeTicks(get().ticks[id] ?? [], e.summary.state.recent) } })
      return
    }
    if (e.type === 'realtime:price') {
      set({ samples: addSample(get().samples, e.sample) })
      return
    }
    if (e.type === 'realtime:stream') {
      set({ stream: e.status })
      return
    }
    // A tick: the state came without `recent`; the page keeps its own list of them.
    const cur = agents[e.id]
    if (!cur) {
      void get().refresh()
      return
    }
    set({ agents: { ...agents, [e.id]: { config: cur.config, state: { ...e.state, recent: cur.state.recent } } }, ticks: { ...get().ticks, [e.id]: mergeTicks(get().ticks[e.id] ?? [], [e.tick]) } })
  },

  async create(req) {
    try {
      const s = await window.tb.realtime.create(req)
      set({ error: null })
      get().applyEvent({ type: 'realtime:updated', summary: s })
      get().select(s.config.id)
      return null
    } catch (e) {
      const msg = errorText(e)
      set({ error: msg })
      return msg
    }
  },

  async update(id, patch) {
    try {
      const s = await window.tb.realtime.update(id, patch)
      get().applyEvent({ type: 'realtime:updated', summary: s })
      return null
    } catch (e) {
      return errorText(e)
    }
  },

  async remove(id) {
    await window.tb.realtime.delete(id)
    get().applyEvent({ type: 'realtime:deleted', id })
  },
  async setStatus(id, status) {
    get().applyEvent({ type: 'realtime:updated', summary: await window.tb.realtime.setStatus(id, status) })
  },
  async resetPaper(id) {
    get().applyEvent({ type: 'realtime:updated', summary: await window.tb.realtime.resetPaper(id) })
  },
  async tickNow(id) {
    get().applyEvent({ type: 'realtime:updated', summary: await window.tb.realtime.tickNow(id) })
  },
  async setKey(key) {
    set({ key: await window.tb.realtime.setKey(key) })
  },
  async clearKey() {
    set({ key: await window.tb.realtime.clearKey() })
  },
  async testKey() {
    set({ key: await window.tb.realtime.testKey() })
  },
  async setStreamKey(req) {
    set({ stream: await window.tb.realtime.setStreamKey(req) })
  },
  async clearStreamKey() {
    set({ stream: await window.tb.realtime.clearStreamKey() })
  }
}))
