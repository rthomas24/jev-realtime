import { ipcMain, shell, type BrowserWindow } from 'electron'
import { IpcChannels, REALTIME_EVENT_CHANNEL } from '@shared/ipc'
import type { RealtimeCreateRequest, RealtimeStreamKeyRequest, RealtimeUpdateRequest } from '@shared/realtimeAgents'
import { realtimeEngine } from './realtime/RealtimeEngine'

let registered = false

/** Wire the engine to one window: handlers once, event forwarding per window. */
export function registerIpc(win: BrowserWindow): () => void {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const off = realtimeEngine.onEvent((e) => send(REALTIME_EVENT_CHANNEL, e))
  if (!registered) {
    registered = true
    ipcMain.handle(IpcChannels.realtimeList, () => realtimeEngine.list())
    ipcMain.handle(IpcChannels.realtimeGet, (_e, id: string) => realtimeEngine.get(String(id)))
    ipcMain.handle(IpcChannels.realtimeCreate, (_e, req: RealtimeCreateRequest) => realtimeEngine.create(req))
    ipcMain.handle(IpcChannels.realtimeUpdate, (_e, id: string, patch: RealtimeUpdateRequest) => realtimeEngine.update(String(id), patch ?? {}))
    ipcMain.handle(IpcChannels.realtimeDelete, (_e, id: string) => realtimeEngine.delete(String(id)))
    ipcMain.handle(IpcChannels.realtimeSetStatus, (_e, id: string, status: 'running' | 'paused') => realtimeEngine.setStatus(String(id), status === 'running' ? 'running' : 'paused'))
    ipcMain.handle(IpcChannels.realtimeResetPaper, (_e, id: string) => realtimeEngine.resetPaper(String(id)))
    ipcMain.handle(IpcChannels.realtimeTickNow, (_e, id: string) => realtimeEngine.tickNow(String(id)))
    ipcMain.handle(IpcChannels.realtimeKeyStatus, () => realtimeEngine.keyStatus())
    ipcMain.handle(IpcChannels.realtimeSetKey, (_e, key: string) => realtimeEngine.setKey(String(key ?? '')))
    ipcMain.handle(IpcChannels.realtimeClearKey, () => realtimeEngine.clearKey())
    ipcMain.handle(IpcChannels.realtimeTestKey, () => realtimeEngine.testKey())
    ipcMain.handle(IpcChannels.realtimeStreamStatus, () => realtimeEngine.streamStatus())
    ipcMain.handle(IpcChannels.realtimeSetStreamKey, (_e, req: RealtimeStreamKeyRequest) => realtimeEngine.setStreamKey(req))
    ipcMain.handle(IpcChannels.realtimeClearStreamKey, () => realtimeEngine.clearStreamKey())
    ipcMain.handle(IpcChannels.openExternal, (_e, url: string) => {
      const u = String(url ?? '')
      if (/^https?:\/\//.test(u)) return shell.openExternal(u)
      return Promise.resolve()
    })
  }
  return off
}
