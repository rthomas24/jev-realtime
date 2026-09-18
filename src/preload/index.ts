import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, REALTIME_EVENT_CHANNEL, type RealtimeEvent, type TbApi } from '@shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: TbApi = {
  realtime: {
    list: () => ipcRenderer.invoke(IpcChannels.realtimeList),
    get: (id) => ipcRenderer.invoke(IpcChannels.realtimeGet, id),
    create: (req) => ipcRenderer.invoke(IpcChannels.realtimeCreate, req),
    update: (id, patch) => ipcRenderer.invoke(IpcChannels.realtimeUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(IpcChannels.realtimeDelete, id),
    setStatus: (id, status) => ipcRenderer.invoke(IpcChannels.realtimeSetStatus, id, status),
    resetPaper: (id) => ipcRenderer.invoke(IpcChannels.realtimeResetPaper, id),
    tickNow: (id) => ipcRenderer.invoke(IpcChannels.realtimeTickNow, id),
    keyStatus: () => ipcRenderer.invoke(IpcChannels.realtimeKeyStatus),
    setKey: (key) => ipcRenderer.invoke(IpcChannels.realtimeSetKey, key),
    clearKey: () => ipcRenderer.invoke(IpcChannels.realtimeClearKey),
    testKey: () => ipcRenderer.invoke(IpcChannels.realtimeTestKey),
    streamStatus: () => ipcRenderer.invoke(IpcChannels.realtimeStreamStatus),
    setStreamKey: (req) => ipcRenderer.invoke(IpcChannels.realtimeSetStreamKey, req),
    clearStreamKey: () => ipcRenderer.invoke(IpcChannels.realtimeClearStreamKey),
    onEvent: (cb) => on<RealtimeEvent>(REALTIME_EVENT_CHANNEL, cb)
  },
  openExternal: (url) => ipcRenderer.invoke(IpcChannels.openExternal, url)
}

contextBridge.exposeInMainWorld('tb', api)
