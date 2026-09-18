import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { realtimeEngine } from './realtime/RealtimeEngine'

/**
 * Jev Realtime — one window, one engine. Paper agents on this computer,
 * checked every second through the session on a live tape from the
 * operator's own Alpaca key and decided by TypeSafe's Jev (a System One
 * model). Nothing here talks to anything but Alpaca and TypeSafe.
 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Jev Realtime',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const off = registerIpc(win)
  win.on('closed', off)
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.jevrealtime.app')
  app.on('browser-window-created', (_, win) => optimizer.watchWindowShortcuts(win))
  realtimeEngine.init()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  realtimeEngine.disposeAll()
})
