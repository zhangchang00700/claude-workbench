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
  | { type: 'start'; runId: string; sessionId: string | null; appSessionId: string }
  | { type: 'session'; runId: string; sessionId: string; appSessionId: string }
  | { type: 'delta'; runId: string; text: string; appSessionId: string }
  | { type: 'tool'; runId: string; name: string; appSessionId: string }
  | {
      type: 'done' | 'error'
      runId: string
      sessionId?: string | null
      appSessionId: string
      message?: string
      numTurns?: number | null
      costUsd?: number | null
      durationMs?: number | null
    }

/** 更新下载进度（domain='updates' / 'update:progress' 通道的 payload） */
export interface UpdateProgressView {
  /** downloading / done / error */
  phase: string
  /** 0-100 */
  percent?: number
  message?: string
}

/** 速聊条查询结果 */
export interface QuickChatAskResult {
  ok: boolean
  text?: string
  error?: string
  /** 端到端耗时（毫秒） */
  ms?: number
  /** 实际承接本次请求的供应商显示名（按响应里的真实模型名反查；查不到为空） */
  provider?: string
}

/** 速聊条「投递到完整会话」结果 */
export interface QuickChatHandoffResult {
  ok: boolean
  appSessionId?: string
}

/** 更新检测结果 */
export interface UpdateCheckView {
  hasUpdate: boolean
  current: string
  latest?: string
  notes?: string
  assetName?: string
  assetSize?: number
  error?: string
}

/** 更新下载结果 */
export interface UpdateDownloadView {
  ok: boolean
  path?: string
  error?: string
}

/**
 * 速聊条投递到完整会话时广播的事件（domain='session:open' 的 payload）。
 * 走通用 stream:event 通道，fe 用 window.workbench.onStreamEvent 过滤 domain 即可。
 */
export interface SessionOpenPayload {
  appSessionId: string
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
  // ── 全局速聊条（M6 v0.2.0） ──
  /**
   * 速聊问答：直连本地路由站取纯文本（不起 CLI），返回文本、供应商显示名与端到端耗时 ms。
   * tier 缺省 sonnet；失败一律 {ok:false, error}，不抛。
   */
  quickChatAsk(args: { text: string; tier?: ModelTier }): Promise<QuickChatAskResult>
  /**
   * 把这条速聊问答落成一个正式会话（createSession + appendMessage），返回 appSessionId。
   * answer 传助手原文：投递后的会话里问答成对；不传（用户手打投送）则只写 user 一条，不产生空气泡。
   */
  quickChatHandoff(args: { text: string; tier?: ModelTier; answer?: string }): Promise<QuickChatHandoffResult>
  /** 收起速聊窗（隐藏而非销毁） */
  quickChatHide(): Promise<void>
  /**
   * 速聊窗每次被唤起都触发（Alt+Space 再次按下时同样触发），渲染层据此聚焦输入框。
   * 契约类型为 void；运行时同时返回退订函数（声明处限宽、实现处放宽）。
   */
  onQuickChatShown(cb: () => void): void
  // ── 下列三项为渲染层（fe）在契约之外追加的配套接口，属于增量，不改动上面 7 条的签名 ──
  /** 速聊窗高度随回答增长：渲染层测出期望尺寸，由主进程真正 resize */
  quickChatResize(args: { width: number; height: number }): Promise<{ ok: boolean }>
  /** 速聊投送到正式会话时回调 appSessionId（由 stream:event domain='session' 派生） */
  onSessionOpen(cb: (appSessionId: string) => void): () => void
  /** 打开更新包所在文件夹（只 reveal，不安装、不静默替换） */
  openUpdateFolder(path: string): Promise<{ ok: boolean; error?: string }>
  /**
   * 当前实际生效的全局热键。Alt+Space 在 Windows 上常被系统窗口菜单占用，主进程按
   * Alt+Space → Ctrl+Alt+Space → Alt+Shift+Space 降级链取第一个注册成功的；
   * 渲染层据此显示「按 XXX 唤起」，绝不写死键位（用户按了没反应是最糟的体验）。
   */
  getQuickChatHotkey(): Promise<string>
  /** 唤起速聊窗（主窗口按钮 / 托盘菜单共用；全局热键失效时的必经入口） */
  quickChatShow(): Promise<{ ok: boolean }>
  // ── 自动更新（M6 v0.2.0） ──
  /** 检测更新（走 gh api，不经 github.com）；失败回 error 字段而非抛异常 */
  checkUpdate(): Promise<UpdateCheckView>
  /** 下载更新包到磁盘（不做静默自替换），阶段进度经 onUpdateProgress 推送 */
  downloadUpdate(): Promise<UpdateDownloadView>
  /** 契约类型为 void；运行时同时返回退订函数（同 onQuickChatShown） */
  onUpdateProgress(cb: (p: UpdateProgressView) => void): void
  onStreamEvent(cb: (e: StreamEvent) => void): () => void
}

declare global {
  interface Window {
    workbench: WorkbenchApi
  }
}
