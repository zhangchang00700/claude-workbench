/**
 * 系统托盘：供应商秒切 + 主窗口呼出。
 *
 * 菜单不静态缓存：定时重建（5s）+ 切换后立即重建，保证「★主用」标记新鲜
 * （Tray 没有「菜单打开前」钩子，只能整体替换 contextMenu）。
 *
 * 「设为主用」复刻设置页语义：priority 置 0（最小，排降级链首位），随后
 * saveConfig + reloadRouter(loadConfig) 热加载。绝不 stopRouter/重启路由站——
 * 重启会换端口，进行中的 CLI 会话会打到死端口（与 ipc.ts applyConfigChange 同一铁律）。
 */
import { app, Menu, Tray, nativeImage, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import log from 'electron-log'
import { activeProviders, loadConfig, saveConfig } from './core/config'
import { reloadRouter } from './model-router'
import { getActiveHotkey, showQuickChat } from './quickchat'

/**
 * 16x16 不透明 PNG 图标：深色圆角方框 + #1e93a3 主色。
 * 由 Node 内置 zlib 手工编码（IHDR/IDAT/IEND + CRC32）后 base64 内嵌，零新依赖。
 */
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4nGMQllL4TwlmoLoBcpMX48V4DSCkGZshDKRqRjdk1IDhZQDFCYkqSXlAciMAsWrTrFGhw3UAAAAASUVORK5CYII='

/** 菜单重建周期：托盘菜单无打开前钩子，用定时重建保证状态新鲜 */
const REBUILD_INTERVAL_MS = 5000

let tray: Tray | null = null
let rebuildTimer: ReturnType<typeof setInterval> | null = null

/** 显示主窗口：最小化则恢复、隐藏则显示；已销毁则走 index.ts activate 的重建路径 */
function showMainWindow(getMainWindow: () => BrowserWindow | null): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  // 主窗已销毁（宠物窗还活着时 window-all-closed 不会触发 app.quit，应用驻留托盘）：
  // 复刻 index.ts activate 处理器的重建逻辑（新建主窗 + 宠物窗，IPC 闭瓶指向新窗）。
  app.emit('activate')
}

/**
 * 「设为主用」：复刻 config:updateProvider 收到 { priority: 0 } 时的处理——
 * 直接置 0（与 SettingsPage.setPrimary 完全一致），保存后热加载路由站。
 *
 * 并列消歧：原主用可能同为 0，而 activeProviders 的 stable sort 会按数组序
 * 保住它、导致点击不生效；把其余并列 0 的抬到 1，保证被点供应商严格最小。
 * 不校验 Key/enabled：与设置页一致，无 Key 也允许点（是否真正生效由路由站决定）。
 */
async function setPrimary(id: string): Promise<void> {
  const cfg = loadConfig()
  const pv = cfg.providers.find((p) => p.id === id)
  if (!pv) return
  pv.priority = 0
  for (const other of cfg.providers) {
    if (other.id !== id && other.priority <= 0) other.priority = 1
  }
  saveConfig(cfg)
  try {
    await reloadRouter(loadConfig)
  } catch (err) {
    log.error('[tray] reloadRouter failed', err)
  }
}

/** 重建托盘菜单与 tooltip（当前主用 = enabled 且有 Key 中 priority 最小者） */
function refreshTray(getMainWindow: () => BrowserWindow | null): void {
  if (!tray || tray.isDestroyed()) return
  const cfg = loadConfig()
  const head = activeProviders(cfg)[0] ?? null
  const items: MenuItemConstructorOptions[] = [...cfg.providers]
    .sort((a, b) => a.priority - b.priority)
    .map((pv) => ({
      label: `${pv.name} · ${pv.apiKeyEnc ? '已填Key' : '未填'}${head?.id === pv.id ? ' · ★主用' : ''}`,
      click: () => {
        void setPrimary(pv.id).then(() => refreshTray(getMainWindow))
      }
    }))
  items.push(
    { type: 'separator' },
    // 速聊兜底入口：三个热键候选全被占用时，用户仍能从这里唤起（不依赖全局热键）
    { label: `速聊${getActiveHotkey() ? `（${getActiveHotkey()}）` : ''}`, click: () => showQuickChat() },
    { label: '显示主窗口', click: () => showMainWindow(getMainWindow) },
    { label: '退出', click: () => app.quit() }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(`ClaudeWorkbench · 主用：${head ? head.name : '无'}`)
}

/** 创建系统托盘（须在 app ready 后调用）；返回 Tray 实例供调试 */
export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL))
  // 双击图标呼出主窗口（与菜单「显示主窗口」同路径）
  tray.on('double-click', () => showMainWindow(getMainWindow))
  refreshTray(getMainWindow)
  rebuildTimer = setInterval(() => refreshTray(getMainWindow), REBUILD_INTERVAL_MS)
  return tray
}

/** 销毁托盘并停止重建定时器（app quit 时调用） */
export function destroyTray(): void {
  if (rebuildTimer) {
    clearInterval(rebuildTimer)
    rebuildTimer = null
  }
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
