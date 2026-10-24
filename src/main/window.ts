import { app, BrowserWindow } from 'electron'
import path from 'node:path'

export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'index.js')

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'ClaudeWorkbench',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(app.getAppPath(), 'out', 'renderer', 'index.html'))
  }

  return win
}
