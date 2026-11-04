// 桌面宠物窗口：透明、无边框、置顶；随主窗口创建，接收 stream:event 展示状态动画
import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'

let petWin: BrowserWindow | null = null

export function getPetWindow(): BrowserWindow | null {
  return petWin && !petWin.isDestroyed() ? petWin : null
}

export function createPetWindow(): void {
  if (getPetWindow()) return
  const wa = screen.getPrimaryDisplay().workAreaSize
  const width = 240
  const height = 250
  petWin = new BrowserWindow({
    width,
    height,
    x: wa.width - width - 20,
    y: wa.height - height - 8,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  petWin.setAlwaysOnTop(true, 'screen-saver')
  petWin.once('ready-to-show', () => petWin?.show())
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void petWin.loadURL(devUrl + '/pet.html')
  else void petWin.loadFile(path.join(app.getAppPath(), 'out', 'renderer', 'pet.html'))
  petWin.on('closed', () => {
    petWin = null
  })
}
