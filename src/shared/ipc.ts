import type { RealtimeCreateRequest, RealtimeKeyStatus, RealtimePriceSample, RealtimeState, RealtimeStreamKeyRequest, RealtimeStreamStatus, RealtimeSummary, RealtimeTick, RealtimeUpdateRequest } from './realtimeAgents'

/** One quote, as every price source hands it over. */
export interface Quote {
  symbol: string
  last: number
  bid?: number
  ask?: number
  /** The PRIOR session's close. */
  prevClose?: number
  prevCloseDate?: string
  changePct?: number
  ts: string
}

export const IpcChannels = {
  realtimeList: 'realtime:list',
  realtimeGet: 'realtime:get',
  realtimeCreate: 'realtime:create',
  realtimeUpdate: 'realtime:update',
  realtimeDelete: 'realtime:delete',
  realtimeSetStatus: 'realtime:setStatus',
  realtimeResetPaper: 'realtime:resetPaper',
  realtimeTickNow: 'realtime:tickNow',
  realtimeKeyStatus: 'realtime:keyStatus',
  realtimeSetKey: 'realtime:setKey',
  realtimeClearKey: 'realtime:clearKey',
  realtimeTestKey: 'realtime:testKey',
  realtimeStreamStatus: 'realtime:streamStatus',
  realtimeSetStreamKey: 'realtime:setStreamKey',
  realtimeClearStreamKey: 'realtime:clearStreamKey',
  openExternal: 'shell:openExternal'
} as const

export const REALTIME_EVENT_CHANNEL = 'rt:event'

/** Pushed by the engine. A tick carries the state WITHOUT `recent`; the renderer appends the tick itself. */
export type RealtimeEvent =
  | { type: 'realtime:updated'; summary: RealtimeSummary }
  | { type: 'realtime:deleted'; id: string }
  | { type: 'realtime:tick'; id: string; tick: RealtimeTick; state: Omit<RealtimeState, 'recent'> }
  /** A quote sample between decisions. Ephemeral: never stored. */
  | { type: 'realtime:price'; sample: RealtimePriceSample }
  | { type: 'realtime:stream'; status: RealtimeStreamStatus }

/** The preload bridge, as the renderer sees it. */
export interface TbApi {
  realtime: {
    list(): Promise<RealtimeSummary[]>
    get(id: string): Promise<RealtimeSummary | null>
    create(req: RealtimeCreateRequest): Promise<RealtimeSummary>
    update(id: string, patch: RealtimeUpdateRequest): Promise<RealtimeSummary>
    delete(id: string): Promise<void>
    setStatus(id: string, status: 'running' | 'paused'): Promise<RealtimeSummary>
    resetPaper(id: string): Promise<RealtimeSummary>
    tickNow(id: string): Promise<RealtimeSummary>
    keyStatus(): Promise<RealtimeKeyStatus>
    setKey(key: string): Promise<RealtimeKeyStatus>
    clearKey(): Promise<RealtimeKeyStatus>
    testKey(): Promise<RealtimeKeyStatus>
    streamStatus(): Promise<RealtimeStreamStatus>
    setStreamKey(req: RealtimeStreamKeyRequest): Promise<RealtimeStreamStatus>
    clearStreamKey(): Promise<RealtimeStreamStatus>
    onEvent(cb: (e: RealtimeEvent) => void): () => void
  }
  openExternal(url: string): Promise<void>
}
