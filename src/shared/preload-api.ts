import type { ConfigView, ProviderView } from '../main/ipc'
import type {
  ModelTier,
  PermissionDecision,
  PermissionRequestView,
  ProviderProtocol,
  ScheduleRecord,
  SessionMeta,
  SessionProject,
  SessionRecord,
  TaskEvent,
  TaskRecord,
  TemplateRecord,
  TemplateVars,
  UsageRecordView,
  UsageStats
} from './types'

export type {
  ConfigView,
  ProviderView,
  ModelTier,
  ProviderProtocol,
  PermissionDecision,
  PermissionRequestView,
  ScheduleRecord,
  SessionMeta,
  SessionProject,
  SessionRecord,
  TaskEvent,
  TaskRecord,
  TemplateRecord,
  TemplateVars,
  UsageRecordView,
  UsageStats
}

export interface StreamEvent {
  domain: string
  payload: unknown
}

/** 聊天流式事件（domain='chat' 的 payload） */
export type ChatEvent =
  | { type: 'start'; runId: string; sessionId: string | null }
  | { type: 'session'; runId: string; sessionId: string }
  | { type: 'delta'; runId: string; text: string }
  | { type: 'tool'; runId: string; name: string }
  | {
      type: 'done' | 'error'
      runId: string
      sessionId?: string | null
      message?: string
      numTurns?: number | null
      costUsd?: number | null
      durationMs?: number | null
    }

/** 路由站故障转移事件（domain='router' 的 payload） */
export interface RouterEvent {
  /** 出问题的供应商 id */
  from: string
  fromName?: string
  /** 实际承接本次请求的供应商 id */
  to: string
  toName?: string
  /** 机器可读原因（quota_exhausted / overloaded / http_429 …） */
  reason: string
  /** 中文原因（额度/余额不足 …） */
  reasonText: string
}

export interface WorkbenchApi {
  platform: string
  getVersion(): Promise<string>
  getConfig(): Promise<ConfigView>
  setProviderKey(id: string, plainKey: string): Promise<{ ok: boolean; hasKey?: boolean; error?: string }>
  updateProvider(
    id: string,
    patch: Partial<ProviderView>
  ): Promise<{ ok: boolean; provider?: ProviderView; error?: string }>
  addProvider(input: {
    id: string
    name: string
    baseUrl: string
    protocol?: ProviderProtocol
  }): Promise<{ ok: boolean; provider?: ProviderView; error?: string }>
  removeProvider(id: string): Promise<{ ok: boolean }>
  saveWorkspace(patch: Record<string, unknown>): Promise<{ ok: boolean }>
  testProvider(id: string): Promise<{ ok: boolean; models?: string[]; error?: string; ms?: number }>
  autoFillModels(id: string): Promise<{
    ok: boolean
    models?: string[]
    fromPreset?: boolean
    error?: string
    provider?: ProviderView
  }>
  sendChat(args: {
    text: string
    tier?: ModelTier
    appSessionId?: string
    /** 新建会话时归入的项目（Claude Desktop 式分组） */
    projectId?: string
  }): Promise<{ ok: boolean; appSessionId?: string; cliSessionId?: string | null; error?: string }>
  stopChat(): Promise<{ ok: boolean }>
  listSessions(): Promise<SessionMeta[]>
  getSession(id: string): Promise<SessionRecord | null>
  removeSession(id: string): Promise<{ ok: boolean }>
  setSessionProject(id: string, projectId: string | null): Promise<{ ok: boolean }>
  archiveSession(id: string, archived: boolean): Promise<{ ok: boolean }>
  // ── 会话项目（对齐 Claude Desktop Projects） ──
  listProjects(): Promise<SessionProject[]>
  saveProject(input: { id?: string; name: string; description?: string }): Promise<SessionProject>
  archiveProject(id: string, archived: boolean): Promise<{ ok: boolean }>
  removeProject(id: string): Promise<{ ok: boolean; moved: number }>
  respondPermission(id: string, decision: PermissionDecision): Promise<{ ok: boolean }>
  // ── 任务队列（M2） ──
  listTasks(): Promise<TaskRecord[]>
  createTask(input: {
    title?: string
    prompt: string
    tier?: ModelTier
    maxTokens?: number
    maxRetries?: number
    batch?: boolean
  }): Promise<{ ok: boolean; count: number; ids: string[] }>
  startTasks(): Promise<{ ok: boolean; running: boolean }>
  pauseTasks(): Promise<{ ok: boolean }>
  cancelTask(id: string): Promise<{ ok: boolean }>
  retryTask(id: string): Promise<{ ok: boolean }>
  removeTask(id: string): Promise<{ ok: boolean }>
  clearTasks(): Promise<{ ok: boolean }>
  // ── 模板流水线（M3） ──
  listTemplates(): Promise<TemplateRecord[]>
  getTemplate(id: string): Promise<TemplateRecord | null>
  saveTemplate(input: {
    id?: string
    name: string
    description?: string
    prompt: string
    tier?: ModelTier
    maxTokens?: number
    maxRetries?: number
  }): Promise<TemplateRecord>
  removeTemplate(id: string): Promise<{ ok: boolean }>
  renderTemplate(prompt: string, vars: TemplateVars): Promise<{ prompt: string; missing: string[] }>
  enqueueTemplate(id: string, rows: TemplateVars[]): Promise<{ ok: boolean; error?: string; count?: number }>
  // ── 定时自动化（M4） ──
  listSchedules(): Promise<ScheduleRecord[]>
  getSchedule(id: string): Promise<ScheduleRecord | null>
  saveSchedule(input: {
    id?: string
    name: string
    enabled?: boolean
    kind?: ScheduleRecord['kind']
    intervalMinutes?: number
    dailyTime?: string
    source?: ScheduleRecord['source']
    templateId?: string
    vars?: TemplateVars[]
    prompt?: string
    tier?: ModelTier
    maxRetries?: number
  }): Promise<ScheduleRecord>
  removeSchedule(id: string): Promise<{ ok: boolean }>
  runScheduleNow(id: string): Promise<{ ok: boolean; error?: string }>
  toggleSchedule(id: string, enabled: boolean): Promise<{ ok: boolean }>
  // ── 用量看板（M5） ──
  queryUsage(days?: number): Promise<{ records: UsageRecordView[]; stats: UsageStats }>
  onStreamEvent(cb: (e: StreamEvent) => void): () => void
}

declare global {
  interface Window {
    workbench: WorkbenchApi
  }
}
