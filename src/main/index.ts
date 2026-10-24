import './guard'

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import log from 'electron-log'
import { createMainWindow } from './window'
import { runSmokeSelfTest } from './smoke'
import { loadConfig } from './core/config'
import { ensureRouter, stopRouter } from './model-router'
import { registerIpc } from './ipc'
import { createPetWindow } from './pet'
import { createTray, destroyTray } from './tray'

// 固化 userData 目录为 %APPDATA%/ClaudeWorkbench（否则按 package.json name
// 生成 claude-workbench，与产品名不一致）。必须在任何 getPath('userData') 之前。
app.setPath('userData', path.join(app.getPath('appData'), 'ClaudeWorkbench'))

// 禁用硬件加速：GPU 进程不可用的环境（虚拟机/沙箱/部分远程桌面）下
// Chromium 会 FATAL 退出；本 UI 为简单 2D 界面，软件合成完全够用。
// 必须在 app ready 之前调用。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')

/**
 * 冒烟触发：环境变量 CLAUDE_WORKBENCH_SMOKE=1 或命令行 --smoke。
 * 注意：不能用 --smoke 单独触发——若进程被以纯 Node 模式启动，
 * Node 的参数解析器会在 JS 执行前以退出码 9 拒绝未知 flag；
 * 环境变量不受参数解析影响，且 guard 自愈后依然可见。
 */
let mainWindow: BrowserWindow | null = null

function isSmokeMode(): boolean {
  return process.env.CLAUDE_WORKBENCH_SMOKE === '1' || process.argv.includes('--smoke')
}

if (isSmokeMode()) {
  // 无窗口自检模式：供 scripts/smoke-test.ps1 端到端冒烟调用（经内部路由站）
  app.whenReady().then(async () => {
    let code = 2
    try {
      code = await runSmokeSelfTest()
    } catch (err) {
      log.error('[smoke] fatal', err)
      console.error('[smoke] FATAL', err)
      code = 2
    }
    app.exit(code)
  })
} else {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        const w = wins[0]
        if (w.isMinimized()) w.restore()
        w.focus()
      }
    })

    app.whenReady().then(async () => {
      log.info('app ready, version=%s', app.getVersion())
      ipcMain.handle('app:version', () => app.getVersion())
      mainWindow = createMainWindow()
      registerIpc(() => mainWindow)
      createPetWindow()
      // 系统托盘：供应商秒切 + 主窗口呼出（菜单内部自行刷新状态）
      createTray(() => mainWindow)
      mainWindow.on('closed', () => {
        mainWindow = null
      })
      try {
        const router = await ensureRouter(loadConfig)
        log.info('[router] ready at %s', router.baseUrl)
      } catch (err) {
        log.error('[router] start failed', err)
      }
      app.on('activate', () => {
        // 主窗被销毁后重建：托盘「显示主窗口」与 macOS dock 点击都会走到这
        // （app.emit('activate')）。不重复 registerIpc——ipcMain.handle 二次
        // 注册同一通道会抛 "Attempted to register a second handler"（已实测），
        // 且 IPC 通道本是进程级单例，启动时注册的闭瓶 () => mainWindow
        // 会自动指向新窗口。判据用 mainWindow 而非 getAllWindows().length：
        // 宠物窗还活着时窗口数不为 0，但主窗仍需重建（关主窗不会 quit）。
        if (!mainWindow || mainWindow.isDestroyed()) {
          mainWindow = createMainWindow()
          mainWindow.on('closed', () => {
            mainWindow = null
          })
          createPetWindow()
        }
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })

    app.on('will-quit', () => {
      destroyTray()
      stopRouter()
    })
  }
}
