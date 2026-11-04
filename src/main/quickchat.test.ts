import { describe, expect, it, vi } from 'vitest'

// quickchat.ts 顶层就 import electron（BrowserWindow/globalShortcut/screen/app），
// node 环境直接加载会炸；这里只测导出的纯函数 pickHotkey，用 mock 挡住 electron。
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppPath: (): string => '', getPath: (): string => '' },
  globalShortcut: { register: (): boolean => false, unregister: (): void => {} },
  screen: {
    getPrimaryDisplay: (): { workArea: { x: number; y: number; width: number; height: number } } => ({
      workArea: { x: 0, y: 0, width: 0, height: 0 }
    }),
    getDisplayNearestPoint: (): { workArea: { x: number; y: number; width: number; height: number } } => ({
      workArea: { x: 0, y: 0, width: 0, height: 0 }
    }),
    getCursorScreenPoint: (): { x: number; y: number } => ({ x: 0, y: 0 })
  }
}))
vi.mock('electron-log', () => ({
  default: { info: (): void => {}, warn: (): void => {}, error: (): void => {} }
}))

import { QUICKCHAT_HOTKEY_CANDIDATES, pickHotkey } from './quickchat'

describe('pickHotkey 热键降级链', () => {
  it('第一个候选可用时取第一个（Alt+Space 心智不变）', () => {
    const r = pickHotkey(QUICKCHAT_HOTKEY_CANDIDATES, () => true)
    expect(r.hotkey).toBe('Alt+Space')
    expect(r.attempted).toEqual(['Alt+Space'])
  })

  it('第一个被系统占用时降级到第二个（Ctrl+Alt+Space）', () => {
    const r = pickHotkey(QUICKCHAT_HOTKEY_CANDIDATES, (c) => c === 'Ctrl+Alt+Space')
    expect(r.hotkey).toBe('Ctrl+Alt+Space')
    expect(r.attempted).toEqual(['Alt+Space', 'Ctrl+Alt+Space'])
  })

  it('全部被占用时 hotkey=null，且整个链都尝试过（调用方走托盘兜底）', () => {
    const r = pickHotkey(QUICKCHAT_HOTKEY_CANDIDATES, () => false)
    expect(r.hotkey).toBeNull()
    expect(r.attempted).toEqual([...QUICKCHAT_HOTKEY_CANDIDATES])
  })

  it('空候选链安全返回 null，不抛', () => {
    const r = pickHotkey([], () => true)
    expect(r.hotkey).toBeNull()
    expect(r.attempted).toEqual([])
  })

  it('候选链本身不含 Ctrl+Space（中文输入法中英文切换，绝不能用）', () => {
    expect((QUICKCHAT_HOTKEY_CANDIDATES as readonly string[]).includes('Ctrl+Space')).toBe(false)
  })
})
