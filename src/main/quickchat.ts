/**
 * 全局速聊条窗口（v0.2.0 MVP）。
 *
 * 形态：无边框 / 置顶 / 不进任务栏 / 透明背景 / 居中偏上，Overlay 式小窗。
 * 唤出：globalShortcut 按降级链注册（Alt+Space → Ctrl+Alt+Space → Alt+Shift+Space），取第一个注册成功的。
 * 关闭：隐藏而非销毁——保留渲染进程与 JS 上下文，二次唤起无冷启动延迟。
 *
 * Esc / blur 关闭由渲染层调用 quickChatHide 决定；这里另外兜一层 before-input-event
 * （渲染层脚本没跑起来时不至于把用户锁在一个关不掉的置顶窗里）。
 */
import { BrowserWindow, app, globalShortcut, screen } from 'electron'
import path from 'node:path'
import log from 'electron-log'

export const QUICKCHAT_SHOWN_CHANNEL = 'quickchat:shown'

/**
 * 全局热键候选链。
 *
 * Alt+Space 在 Windows 上是「系统窗口菜单」的保留键，注册大概率被系统吃掉；
 * Ctrl+Space 是中文输入法的中英文切换，比 Alt+Space 更不能碰。
 * 逐个尝试，取第一个注册成功的；全失败则由托盘菜单兜底唤起（见 tray.ts）。
 */
export const QUICKCHAT_HOTKEY_CANDIDATES = ['Alt+Space', 'Ctrl+Alt+Space', 'Alt+Shift+Space'] as const

/** 当前实际生效的热键；未注册成功为 null（此时速聊仅能经托盘唤起） */
let activeHotkey: string | null = null

const WIDTH = 640
const HEIGHT = 520
/** 渲染层 resize 的允许区间（防异常值把窗口拉成一整块屏幕） */
const MIN_WIDTH = 480
const MAX_WIDTH = 900
const MIN_HEIGHT = 140
const MAX_HEIGHT = 760
/** 距工作区顶部的比例位置（居中偏上，接近 Spotlight/Raycast 的观感） */
const TOP_RATIO = 0.14

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

let quickWin: BrowserWindow | null = null

export function getQuickChatWindow(): BrowserWindow | null {
  return quickWin && !quickWin.isDestroyed() ? quickWin : null
}

function preloadPath(): string {
  return path.join(app.getAppPath(), 'out', 'preload', 'index.js')
}

/** dev 走 ELECTRON_RENDERER_URL，prod 走 out/renderer 目录（同 src/main/pet.ts） */
function loadContent(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(`${devUrl}/quickchat.html`)
  else void win.loadFile(path.join(app.getAppPath(), 'out', 'renderer', 'quickchat.html'))
}

/**
 * 每次唤起都重新居中：显示器插拔 / 分辨率变化后位置依然合理。
 * 注意保留当前宽高——渲染层会用 quickChatResize 按内容调过尺寸，
 * 这里若强行写回初始值，用户每次唤醒都会看到尺寸跳一下。
 */
function recenter(win: BrowserWindow): void {
  const [cw, ch] = win.getSize()
  const width = cw > 0 ? cw : WIDTH
  const height = ch > 0 ? ch : HEIGHT
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = Math.round(area.y + area.height * TOP_RATIO)
  win.setBounds({ x, y, width, height })
}

function notifyShown(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(QUICKCHAT_SHOWN_CHANNEL)
}

function ensureWindow(): BrowserWindow {
  const alive = getQuickChatWindow()
  if (alive) return alive

  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height * TOP_RATIO),
    frame: false,
    transparent: true,
    // transparent + 显式 alpha 背景，避免部分环境出现黑边
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)

  // 兜底 Esc 关闭：渲染层脚本异常时用户仍有退路
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') hideQuickChat()
  })
  // 页面刚就绪且窗口可见时补发一次（首次唤起时 script 可能还没注册监听）
  win.webContents.on('did-finish-load', () => {
    if (win.isVisible()) notifyShown(win)
  })
  win.on('closed', () => {
    if (quickWin === win) quickWin = null
  })

  loadContent(win)
  quickWin = win
  return win
}

export function showQuickChat(): void {
  const win = ensureWindow()
  recenter(win)
  // 先通知再显示：渲染层据此刷新「唤起时刻」，随后系统补发的 blur 才会落在宽限内被忽略。
  // 顺序反了会出一个真实 bug——从主窗口按钮唤起时，show() 后系统立刻补 blur，
  // 而渲染层的 shownAt 还是上一次的旧值 → 窗口刚出来就被自己关掉（用户看到闪一下没了）。
  notifyShown(win)
  if (win.isVisible()) {
    win.focus()
  } else {
    win.show()
    win.focus()
  }
  // 诊断：透明 + alwaysOnTop(screen-saver) 组合在部分 Windows 环境下 show() 后
  // 页面 visibilityState 仍是 hidden。这里落真实 visible/bounds 便于定位。
  const b = win.getBounds()
  log.info(
    '[quickchat] shown: visible=%s focused=%s minimized=%s bounds=%j',
    win.isVisible(),
    win.isFocused(),
    win.isMinimized(),
    b
  )
}

export function hideQuickChat(): void {
  const win = getQuickChatWindow()
  if (!win) return
  // 隐藏而非销毁：复用渲染进程，避免二次唤起的冷启动
  if (win.isVisible()) win.hide()
  // 诊断日志：透明窗口 hide 后页面 focus 信号会残留（与「刚 show 完」的探针一模一样），
  // 页面级信号无法区分这两种状态，窗口真实状态以这里的主进程 isVisible 为准。
  log.info('[quickchat] hide: visible=%s', win.isVisible())
}

/**
 * 让渲染层驱动窗口尺寸：回答变长时卡片需要长高，只有主进程能改窗口边界。
 * 只吃 height/weight 的安全区间，避免异常值把窗口拉成一整块屏幕。
 */
export function resizeQuickChat(width: number, height: number): void {
  const win = getQuickChatWindow()
  if (!win) return
  const w = clamp(Math.round(width) || WIDTH, MIN_WIDTH, MAX_WIDTH)
  const h = clamp(Math.round(height) || MIN_HEIGHT, MIN_HEIGHT, MAX_HEIGHT)
  const [x, y] = win.getPosition()
  win.setBounds({ x, y, width: w, height: h })
}

/**
 * 从候选链里挑第一个注册成功的热键（纯函数，便于单测；不碰 electron）。
 * 返回 hotkey=null 表示全失败（调用方应提供非热键入口兜底）。
 */
export function pickHotkey(
  candidates: readonly string[],
  tryRegister: (candidate: string) => boolean
): { hotkey: string | null; attempted: string[] } {
  const attempted: string[] = []
  for (const candidate of candidates) {
    attempted.push(candidate)
    if (tryRegister(candidate)) return { hotkey: candidate, attempted }
  }
  return { hotkey: null, attempted }
}

/**
 * 当前实际生效的热键；未注册成功为 null（此时速聊仅能经托盘菜单唤起）。
 * 托盘菜单、渲染层提示语都读这里，保证用户看到的键位就是真能用的键位。
 */
export function getActiveHotkey(): string | null {
  return activeHotkey
}

/**
 * 按降级链注册全局热键，返回第一个注册成功的组合键；全失败返回 null（不抛）。
 * 单个候选失败只 warn 并继续尝试——被占用是常态（Alt+Space 属系统保留键）。
 */
export function registerQuickChatHotkey(): string | null {
  const { hotkey, attempted } = pickHotkey(QUICKCHAT_HOTKEY_CANDIDATES, (candidate) =>
    globalShortcut.register(candidate, () => {
      try {
        showQuickChat()
      } catch (err) {
        log.error('[quickchat] show failed', err)
      }
    })
  )
  // 被占用是常态（Alt+Space 属系统保留键），逐个 warn 说清降级路径
  for (const candidate of attempted.slice(0, -1)) {
    log.warn('[quickchat] 全局热键 %s 注册失败（可能被占用），尝试下一个候选', candidate)
  }
  if (hotkey) {
    log.info('[quickchat] 全局热键已注册：%s', hotkey)
  } else {
    log.warn('[quickchat] %d 个热键候选全部注册失败，速聊仅能通过托盘菜单唤起', attempted.length)
  }
  activeHotkey = hotkey
  return hotkey
}

export function unregisterQuickChatHotkey(): void {
  if (activeHotkey) {
    globalShortcut.unregister(activeHotkey)
    activeHotkey = null
    return
  }
  // 未记录生效键时兜底清掉所有候选，避免残留占用
  for (const candidate of QUICKCHAT_HOTKEY_CANDIDATES) globalShortcut.unregister(candidate)
}

export function destroyQuickChat(): void {
  unregisterQuickChatHotkey()
  const win = getQuickChatWindow()
  if (win) win.destroy()
  quickWin = null
}
