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

  onStreamEvent(cb: (e: { domain: string; payload: unknown }) => void): () => void {
    const handler = (_event: unknown, e: { domain: string; payload: unknown }): void => cb(e)
    ipcRenderer.on('stream:event', handler)
    return () => {
      ipcRenderer.removeListener('stream:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('workbench', api)
