import { contextBridge, ipcRenderer } from 'electron'
import type { ConfigView, ProviderView } from '../main/ipc'
import type { ModelTier } from '../shared/types'

export type { ConfigView, ProviderView }

const api = {
  platform: process.platform,
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  getConfig: (): Promise<ConfigView> => ipcRenderer.invoke('config:get'),
  setProviderKey: (id: string, plainKey: string): Promise<{ ok: boolean; hasKey?: boolean; error?: string }> =>
    ipcRenderer.invoke('config:setKey', id, plainKey),
  updateProvider: (
    id: string,
    patch: Partial<ProviderView>
  ): Promise<{ ok: boolean; provider?: ProviderView; error?: string }> =>
    ipcRenderer.invoke('config:updateProvider', id, patch),
  addProvider: (
    input: { id: string; name: string; baseUrl: string }
  ): Promise<{ ok: boolean; provider?: ProviderView; error?: string }> =>
    ipcRenderer.invoke('config:addProvider', input),
  removeProvider: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('config:removeProvider', id),
  saveWorkspace: (patch: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('config:saveWorkspace', patch),
  testProvider: (id: string): Promise<{ ok: boolean; models?: string[]; error?: string; ms?: number }> =>
    ipcRenderer.invoke('provider:test', id),
  autoFillModels: (
    id: string
  ): Promise<{ ok: boolean; models?: string[]; provider?: ProviderView }> =>
    ipcRenderer.invoke('provider:autoFill', id),

  sendChat: (args: {
    text: string
    tier?: ModelTier
    appSessionId?: string
  }): Promise<{ ok: boolean; appSessionId?: string; cliSessionId?: string | null; error?: string }> =>
    ipcRenderer.invoke('chat:send', args),
  stopChat: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:stop'),

  listSessions: (): Promise<unknown> => ipcRenderer.invoke('sessions:list'),
  getSession: (id: string): Promise<unknown> => ipcRenderer.invoke('sessions:get', id),
  removeSession: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('sessions:remove', id),
  setSessionProject: (id: string, projectId: string | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sessions:setProject', id, projectId),
  archiveSession: (id: string, archived: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sessions:archive', id, archived),

  listProjects: (): Promise<unknown> => ipcRenderer.invoke('projects:list'),
  saveProject: (input: unknown): Promise<unknown> => ipcRenderer.invoke('projects:save', input),
  archiveProject: (id: string, archived: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('projects:archive', id, archived),
  removeProject: (id: string): Promise<{ ok: boolean; moved: number }> =>
    ipcRenderer.invoke('projects:remove', id),
  respondPermission: (id: string, decision: { allow: boolean; remember: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('permission:respond', id, decision),

  listTasks: (): Promise<unknown> => ipcRenderer.invoke('tasks:list'),
  createTask: (
    input: { title?: string; prompt: string; tier?: ModelTier; maxTokens?: number; maxRetries?: number; batch?: boolean }
  ): Promise<{ ok: boolean; count: number; ids: string[] }> => ipcRenderer.invoke('tasks:create', input),
  startTasks: (): Promise<{ ok: boolean; running: boolean }> => ipcRenderer.invoke('tasks:start'),
  pauseTasks: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:pause'),
  cancelTask: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:cancel', id),
  retryTask: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:retry', id),
  removeTask: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:remove', id),
  clearTasks: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:clear'),

  listTemplates: (): Promise<unknown> => ipcRenderer.invoke('templates:list'),
  getTemplate: (id: string): Promise<unknown> => ipcRenderer.invoke('templates:get', id),
  saveTemplate: (input: unknown): Promise<unknown> => ipcRenderer.invoke('templates:save', input),
  removeTemplate: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('templates:remove', id),
  renderTemplate: (prompt: string, vars: unknown): Promise<unknown> =>
    ipcRenderer.invoke('templates:render', prompt, vars),
  enqueueTemplate: (id: string, rows: unknown): Promise<unknown> =>
    ipcRenderer.invoke('templates:enqueue', id, rows),

  listSchedules: (): Promise<unknown> => ipcRenderer.invoke('schedules:list'),
  getSchedule: (id: string): Promise<unknown> => ipcRenderer.invoke('schedules:get', id),
  saveSchedule: (input: unknown): Promise<unknown> => ipcRenderer.invoke('schedules:save', input),
  removeSchedule: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('schedules:remove', id),
  runScheduleNow: (id: string): Promise<unknown> => ipcRenderer.invoke('schedules:runNow', id),
  toggleSchedule: (id: string, enabled: boolean): Promise<unknown> =>
    ipcRenderer.invoke('schedules:toggle', id, enabled),

  queryUsage: (days?: number): Promise<unknown> => ipcRenderer.invoke('usage:query', { days }),

  // ── 全局速聊条（M6 v0.2.0） ──
  quickChatAsk: (
    args: { text: string; tier?: ModelTier }
  ): Promise<{ ok: boolean; text?: string; error?: string; ms?: number; provider?: string }> =>
    ipcRenderer.invoke('quickchat:ask', args),
  quickChatHandoff: (
    args: { text: string; tier?: ModelTier; answer?: string }
  ): Promise<{ ok: boolean; appSessionId?: string; error?: string }> =>
    ipcRenderer.invoke('quickchat:handoff', args),
  quickChatHide: (): Promise<void> => ipcRenderer.invoke('quickchat:hide'),
  // 签名与 onStreamEvent 完全同构：返回退订函数。
  // 契约（preload-api.ts）把它声明为 void 是为了固定调用面；这里返回更多不破坏任何调用方。
  onQuickChatShown(cb: () => void) {
    const handler = (): void => cb()
    ipcRenderer.on('quickchat:shown', handler)
    return () => {
      ipcRenderer.removeListener('quickchat:shown', handler)
    }
  },
  // 契约之外、渲染层追加的配套接口：高度随回答增长时让主进程真正 resize 窗口
  quickChatResize: (args: { width: number; height: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('quickchat:resize', args),
  /**
   * 速聊投送到正式会话：由通用 stream:event 通道派生
   * （主进程推 domain='session' / payload={type:'open', appSessionId}），
   * 不额外开第二条推送，避免重复处理。
   */
  onSessionOpen(cb: (appSessionId: string) => void): () => void {
    const handler = (
      _event: unknown,
      e: { domain: string; payload: { type?: string; appSessionId?: string } }
    ): void => {
      if (e?.domain !== 'session') return
      if (e.payload?.type && e.payload.type !== 'open') return
      if (e.payload?.appSessionId) cb(e.payload.appSessionId)
    }
    ipcRenderer.on('stream:event', handler)
    return () => {
      ipcRenderer.removeListener('stream:event', handler)
    }
  },

  // ── 自动更新（M6 v0.2.0） ──
  checkUpdate: (): Promise<{
    hasUpdate: boolean
    current: string
    latest?: string
    notes?: string
    assetName?: string
    assetSize?: number
    error?: string
  }> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('update:download'),
  onUpdateProgress(cb: (p: { phase: string; percent?: number; message?: string }) => void) {
    const handler = (_event: unknown, p: { phase: string; percent?: number; message?: string }): void =>
      cb(p)
    ipcRenderer.on('update:progress', handler)
    return () => {
      ipcRenderer.removeListener('update:progress', handler)
    }
  },
  // 契约之外、渲染层追加的配套接口：打开更新包所在文件夹（不做安装）
  openUpdateFolder: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('update:openFolder', path),
  getQuickChatHotkey: (): Promise<string> => ipcRenderer.invoke('quickchat:hotkey'),
  quickChatShow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('quickchat:show'),

  onStreamEvent(cb: (e: { domain: string; payload: unknown }) => void): () => void {
    const handler = (_event: unknown, e: { domain: string; payload: unknown }): void => cb(e)
    ipcRenderer.on('stream:event', handler)
    return () => {
      ipcRenderer.removeListener('stream:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('workbench', api)
