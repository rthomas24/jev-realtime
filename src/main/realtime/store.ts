import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { clampRealtimeGuardrails, emptyRealtimeState, type RealtimeConfig, type RealtimeState, type RealtimeSummary, type RealtimeTick } from '@shared/realtimeAgents'
import { readJson, writeJson } from '../store/json'

/**
 * Real-time agents live beside the thread agents, not among them:
 *
 *   userData/realtime/<id>/config.json
 *   userData/realtime/<id>/state.json     — the paper book; written atomically
 *   userData/realtime/<id>/ticks.jsonl    — every tick, append-only
 *
 * A separate root because they are a different kind of thing (no thread, no
 * runs, no cloud mirror) and because the thread engine's 15 s watch tick reads
 * and writes `agents/<id>/state.json` whole — sharing that file would race it.
 */
function root(): string {
  const dir = join(app.getPath('userData'), 'realtime')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
function dirOf(id: string): string {
  const dir = join(root(), id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const cfgCache = new Map<string, RealtimeConfig>()
const stateCache = new Map<string, RealtimeState>()

function normalizeConfig(c: RealtimeConfig): RealtimeConfig {
  return { ...c, style: c.style ?? '', status: c.status === 'running' ? 'running' : 'paused', guardrails: clampRealtimeGuardrails(c.guardrails) }
}
function normalizeState(c: RealtimeConfig, s: Partial<RealtimeState> | null): RealtimeState {
  return { ...emptyRealtimeState(c.allocation), ...(s ?? {}) }
}

export const realtimeStore = {
  list(): RealtimeSummary[] {
    const out: RealtimeSummary[] = []
    for (const id of readdirSync(root(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const config = this.getConfig(id)
      if (!config) continue
      out.push({ config, state: this.getState(id)! })
    }
    return out.sort((a, b) => a.config.createdAt.localeCompare(b.config.createdAt))
  },
  getConfig(id: string): RealtimeConfig | null {
    if (cfgCache.has(id)) return cfgCache.get(id)!
    const c = readJson<RealtimeConfig>(join(root(), id, 'config.json'))
    if (!c) return null
    const n = normalizeConfig(c)
    cfgCache.set(id, n)
    return n
  },
  getState(id: string): RealtimeState | null {
    if (stateCache.has(id)) return stateCache.get(id)!
    const c = this.getConfig(id)
    if (!c) return null
    const s = normalizeState(c, readJson<RealtimeState>(join(root(), id, 'state.json')))
    stateCache.set(id, s)
    return s
  },
  saveConfig(cfg: RealtimeConfig): void {
    const n = normalizeConfig(cfg)
    cfgCache.set(cfg.id, n)
    writeJson(join(dirOf(cfg.id), 'config.json'), n)
  },
  saveState(id: string, state: RealtimeState): void {
    stateCache.set(id, state)
    writeJson(join(dirOf(id), 'state.json'), state)
  },
  /** The in-memory state only; the engine decides when the file catches up. */
  cacheState(id: string, state: RealtimeState): void {
    stateCache.set(id, state)
  },
  create(cfg: RealtimeConfig): RealtimeSummary {
    this.saveConfig(cfg)
    const state = emptyRealtimeState(cfg.allocation)
    this.saveState(cfg.id, state)
    return { config: this.getConfig(cfg.id)!, state }
  },
  delete(id: string): void {
    cfgCache.delete(id)
    stateCache.delete(id)
    rmSync(join(root(), id), { recursive: true, force: true })
  },
  appendTick(id: string, tick: RealtimeTick): void {
    try {
      appendFileSync(join(dirOf(id), 'ticks.jsonl'), `${JSON.stringify(tick)}\n`)
    } catch (e) {
      console.warn('[realtime] tick log append failed', (e as Error).message)
    }
  }
}
