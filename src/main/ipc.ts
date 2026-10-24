/**
 * IPC 层：渲染层唯一入口。
 *
 * 安全约束：
 * - 密钥永不以明文返回渲染层（只回 hasKey 布尔）
 * - 渲染层传明文 Key 进来，主进程立即 safeStorage 加密后落盘
 * - 流式聊天通过单一 stream:event 通道推送，不开额外通道
 */
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import { getPetWindow } from './pet'
import log from 'electron-log'
import {
  activeProviders,
  encryptSecret,
  loadConfig,
  saveConfig,
  userDataDir,
  type AppConfig,
  type ProviderConfig
} from './core/config'
import { ensureRouter, getRouter, onFailover, reloadRouter } from './model-router'
import { callRouterText, callRouterTextDetailed, findProviderByModel } from './model-router/messages'
import { buildCliEnvOverrides, runPromptStream } from './claude/client'
import { createPermissionBroker, type PermissionBroker } from './permission-broker'
import {
  checkUpdate as runUpdateCheck,
  downloadUpdate as runUpdateDownload,
  type UpdateProgress
} from './updater'
import { getActiveHotkey, hideQuickChat, resizeQuickChat, showQuickChat } from './quickchat'
import {
  appendMessage,
  createSession,
  getSession,
  initSessionsRoot,
  listSessions,
  removeSession,
  setCliSession,
  setSessionProject,
  archiveSession,
  clearProject
} from './sessions'
import { createTaskRunner, type TaskExecutor } from './tasks/taskRunner'
import {
  clearTasks,
  createTaskRecord,
  getTask,
  initTasksRoot,
  listTasks,
  putTask,
  removeTask
} from './tasks/taskStore'
import {
  buildTasksFromTemplate,
  getTemplate,
  initTemplatesRoot,
  listTemplates,
  missingVariables,
  removeTemplate,
  renderTemplate,
  saveTemplate
} from './templates/templateStore'
import {
  getSchedule,
  initSchedulesRoot,
  listSchedules,
  markScheduleRun,
  removeSchedule,
  saveSchedule
} from './schedules/scheduleStore'
import { createScheduleRunner } from './schedules/scheduleRunner'
import { initUsageRoot, usageReport } from './usage/usageStore'
import {
  getProject,
  initProjectsRoot,
  listProjects,
  removeProject,
  saveProject
} from './projects'
import {
  endpointUrl,
  normalizeBaseUrl,
  validateBaseUrl,
  type ModelTier,
  type ProviderProtocol,
  type ScheduleRecord,
  type TaskRecord,
  type TemplateVars
} from '../shared/types'

/** 渲染层可见的供应商视图：不含任何密钥材料 */
export interface ProviderView {
  id: string
  name: string
  baseUrl: string
  /** 上游协议：anthropic 直连 / openai 需转换 */
  protocol: ProviderProtocol
  /** 实际会打到的对话端点（UI 展示用，避免用户靠猜） */
  messagesEndpoint: string
  /** 实际会打到的模型列表端点 */
  modelsEndpoint: string
  /** baseUrl 规范化提示（如"已去掉多余 /v1 后缀"），null 表示无需提示 */
  baseUrlWarning: string | null
  hasKey: boolean
  models: { opus?: string; sonnet?: string; haiku?: string }
  defaultModel?: string
  priority: number
  enabled: boolean
  builtin: boolean
}

export interface ConfigView {
  onboarded: boolean
  providers: ProviderView[]
  workspace: AppConfig['workspace']
  activeCount: number
  /** 当前默认档实际会用的模型名（首个可用供应商的 sonnet 档） */
  defaultModelNow: string
  defaultProviderNow: string
  /** 有 Key 但三档模型名为空（自动获取失败），UI 需提示重试 */
  needsModelDiscovery: boolean
  encryptionAvailable: boolean
}

function toView(pv: ProviderConfig): ProviderView {
  const protocol: ProviderProtocol = pv.protocol === 'openai' ? 'openai' : 'anthropic'
  return {
    id: pv.id,
    name: pv.name,
    baseUrl: pv.baseUrl,
    protocol,
    messagesEndpoint: endpointUrl(pv.baseUrl, protocol, 'messages'),
    modelsEndpoint: pv.modelsEndpoint?.trim() || endpointUrl(pv.baseUrl, protocol, 'models'),
    baseUrlWarning: validateBaseUrl(pv.baseUrl, protocol),
    hasKey: !!pv.apiKeyEnc,
    models: { ...pv.models },
    defaultModel: pv.defaultModel,
    priority: pv.priority,
    enabled: pv.enabled,
    builtin: pv.builtin
  }
}

function configView(cfg: AppConfig): ConfigView {
  const actives = activeProviders(cfg)
  const head = actives[0]
  return {
    onboarded: cfg.onboarded,
    providers: cfg.providers.map(toView),
    workspace: cfg.workspace,
    activeCount: actives.length,
    defaultModelNow: head ? (head.defaultModel || head.models.sonnet || '') : '',
    /** 供应商已填 Key 但还没拿到模型名（探测失败或未探测） */
    needsModelDiscovery: actives.some((pv) => !pv.defaultModel && !pv.models.sonnet),
    defaultProviderNow: head ? head.name : '',
    encryptionAvailable: true
  }
}

/**
 * 正在执行的对话（用于中断），按 runId 索引。
 *
 * 多会话并行（M6）要求：每个 run 有独立的 AbortController，互不干扰。
 * runId 必须全局唯一——原来只用 `Date.now()`，同一毫秒内发起的第二次对话会
 * 覆盖前一条记录（后者的 finally 会把前者那条一起 delete，导致前者永远停不下来）。
 */
const running = new Map<string, AbortController>()
let runSeq = 0

function nextRunId(): string {
  runSeq += 1
  return `${Date.now()}-${runSeq}`
}

/** 档位归一化：非法值一律退到 sonnet，避免上游收到空 model */
function normalizeTier(tier?: string): ModelTier {
  return tier === 'opus' || tier === 'sonnet' || tier === 'haiku' ? tier : 'sonnet'
}

/**
 * 从 /v1/models 列表推断三档模型名。
 * 规则按「便宜快 → haiku、主力 → sonnet、强 → opus」的直觉排序，
 * 未命中关键字时回退到列表首项，保证任何供应商填完 Key 都能直接用。
 */
function inferTiers(models: string[]): { opus?: string; sonnet?: string; haiku?: string } {
  if (models.length === 0) return {}
  const find = (re: RegExp): string | undefined => models.find((m) => re.test(m))
  const sonnet = find(/flash|turbo|air|standard|plus/i) ?? models[0]
  const opus = find(/pro|max|ultra|opus|reasoning|think/i) ?? models[0]
  const haiku = find(/lite|mini|air|nano|haiku/i) ?? models[models.length - 1]
  return { opus, sonnet, haiku }
}

/** 探测供应商模型并写回配置（models 已有值时仅在 force=true 覆盖）。
 * 探测失败但该供应商有官方预设模型名时，回退为「按预设继续用」——
 * 方舟等没有模型列表端点的供应商不该被一次探测失败卡死。 */
async function autoFillModels(
  id: string,
  force = false
): Promise<{ models: string[]; filled: boolean; fromPreset?: boolean; error?: string }> {
  await ensureRouter(loadConfig)
  const router = getRouter()
  const cfg0 = loadConfig()
  const pv0 = cfg0.providers.find((p) => p.id === id)
  const presetModels = pv0
    ? [pv0.models.opus, pv0.models.sonnet, pv0.models.haiku, pv0.defaultModel].filter(
        (x): x is string => typeof x === 'string' && !!x
      )
    : []
  if (!router) return { models: presetModels, filled: false, fromPreset: presetModels.length > 0, error: '路由站未启动' }
  const probe = await router.probeProvider(id)
  if (!probe.ok || probe.models.length === 0) {
    return {
      models: presetModels,
      filled: false,
      fromPreset: presetModels.length > 0,
      error: probe.error ?? '模型列表为空'
    }
  }

  const cfg = loadConfig()
  const pv = cfg.providers.find((p) => p.id === id)
  if (!pv) return { models: probe.models, filled: false }
  const empty = !pv.models.opus && !pv.models.sonnet && !pv.models.haiku
  if (empty || force) {
    pv.models = inferTiers(probe.models)
    pv.defaultModel = pv.models.sonnet
    saveConfig(cfg)
    void applyConfigChange()
  }
  return { models: probe.models, filled: empty || force }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  initSessionsRoot(userDataDir())
  const emit = (domain: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('stream:event', { domain, payload })
    const pet = getPetWindow()
    if (pet) pet.webContents.send('stream:event', { domain, payload })
  }

  /** 起路由站并挂上故障转移回调：换供应商时界面能看到「谁挂了 → 切到谁」 */
  const ensureRouterReady = async (): Promise<{ baseUrl: string; localToken: string }> => {
    const r = await ensureRouter(loadConfig)
    onFailover((n) => emit('router', n))
    return r
  }

  /** 权限确认闸门：CLI 要调工具时弹窗问用户，裁决回传 CLI */
  const permissionBroker: PermissionBroker = createPermissionBroker(
    (view) => emit('permission', view),
    () => getWindow() !== null
  )

  // ───────── 任务队列（M2） ─────────
  initTasksRoot(userDataDir())
  initTemplatesRoot(userDataDir())
  initSchedulesRoot(userDataDir())
  initUsageRoot(userDataDir())
  initProjectsRoot(userDataDir())

  /**
   * 生产执行器：直连本地路由站 /v1/messages（stream:false），由路由站完成
   * 模型解析、故障转移与熔断。调用体抽到 model-router/messages.ts，
   * 与速聊条 quickChatAsk 共用同一条链路（同端点、同鉴权、同兜底）。
   */
  const taskExecutor: TaskExecutor = async (task, signal) => {
    const r = await ensureRouterReady()
    return callRouterText(
      { baseUrl: r.baseUrl, localToken: loadConfig().router.localToken },
      { prompt: task.prompt, tier: task.tier, maxTokens: task.maxTokens, signal }
    )
  }

  const taskRunner = createTaskRunner({
    backend: { list: listTasks, get: getTask, put: putTask, remove: removeTask, clear: clearTasks },
    executor: taskExecutor,
    getConcurrency: () => Math.max(1, loadConfig().workspace.maxConcurrent || 1),
    onEvent: (e) => emit('tasks', e)
  })

  ipcMain.handle('tasks:list', () => listTasks())

  ipcMain.handle('tasks:get', (_e, id: string) => getTask(id))

  /** 新增任务：batch=true 时按行拆分 prompt，每行一条 */
  ipcMain.handle(
    'tasks:create',
    (
      _e,
      input: {
        title?: string
        prompt: string
        tier?: ModelTier
        maxTokens?: number
        maxRetries?: number
        batch?: boolean
      }
    ) => {
      const tier: ModelTier =
        input.tier === 'opus' || input.tier === 'sonnet' || input.tier === 'haiku' ? input.tier : 'sonnet'
      const created: TaskRecord[] = []
      if (input.batch) {
        const lines = (input.prompt ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
        for (const line of lines) {
          created.push(
            createTaskRecord({ title: input.title, prompt: line, tier, maxTokens: input.maxTokens, maxRetries: input.maxRetries })
          )
        }
      } else {
        created.push(
          createTaskRecord({
            title: input.title,
            prompt: input.prompt,
            tier,
            maxTokens: input.maxTokens,
            maxRetries: input.maxRetries
          })
        )
      }
      for (const t of created) putTask(t)
      if (created.length) emit('tasks', { type: 'created', task: created[created.length - 1], all: listTasks() })
      return { ok: true, count: created.length, ids: created.map((t) => t.id) }
    }
  )

  ipcMain.handle('tasks:start', () => {
    taskRunner.start()
    return { ok: true, running: taskRunner.isRunning() }
  })

  ipcMain.handle('tasks:pause', () => {
    taskRunner.pause()
    return { ok: true, running: taskRunner.isRunning() }
  })

  ipcMain.handle('tasks:cancel', (_e, id: string) => {
    taskRunner.cancel(id)
    return { ok: true }
  })

  ipcMain.handle('tasks:retry', (_e, id: string) => {
    taskRunner.retry(id)
    return { ok: true }
  })

  ipcMain.handle('tasks:remove', (_e, id: string) => {
    removeTask(id)
    emit('tasks', { type: 'removed', id, all: listTasks() })
    return { ok: true }
  })

  ipcMain.handle('tasks:clear', () => {
    clearTasks()
    emit('tasks', { type: 'cleared' })
    return { ok: true }
  })

  // ── 模板流水线（M3） ──

  ipcMain.handle('templates:list', () => listTemplates())

  ipcMain.handle('templates:get', (_e, id: string) => getTemplate(id))

  /** 新建/更新模板（带 id 走更新） */
  ipcMain.handle(
    'templates:save',
    (
      _e,
      input: {
        id?: string
        name: string
        description?: string
        prompt: string
        tier?: ModelTier
        maxTokens?: number
        maxRetries?: number
      }
    ) => {
      const tier: ModelTier =
        input.tier === 'opus' || input.tier === 'sonnet' || input.tier === 'haiku' ? input.tier : 'sonnet'
      return saveTemplate({ ...input, tier })
    }
  )

  ipcMain.handle('templates:remove', (_e, id: string) => {
    removeTemplate(id)
    return { ok: true }
  })

  /** 渲染预览（不落盘）：返回填充结果与仍缺失的变量名 */
  ipcMain.handle('templates:render', (_e, prompt: string, vars: TemplateVars) => ({
    prompt: renderTemplate(prompt, vars),
    missing: missingVariables(prompt, vars)
  }))

  /** 模板 × 变量组 → 批量入队（复用 M2 任务队列与 stream:event 通道） */
  ipcMain.handle('templates:enqueue', (_e, id: string, rows: TemplateVars[]) => {
    const tpl = getTemplate(id)
    if (!tpl) return { ok: false, error: '模板不存在' }
    const usable = (rows ?? []).filter((r) => r && Object.keys(r).length > 0)
    if (!usable.length) return { ok: false, error: '没有可入队的变量组' }
    const tasks = buildTasksFromTemplate(tpl, usable)
    for (const t of tasks) putTask(t)
    emit('tasks', { type: 'created', task: tasks[tasks.length - 1], all: listTasks() })
    return { ok: true, count: tasks.length }
  })

  // ── 定时自动化（M4） ──

  /** 把一条计划兑现为任务入队（调度器到点与「立即执行」共用） */
  const runSchedule = (rec: ScheduleRecord): { ok: boolean; error?: string } => {
    if (rec.source === 'template') {
      const tpl = rec.templateId ? getTemplate(rec.templateId) : null
      if (!tpl) return { ok: false, error: '计划引用的模板不存在' }
      const rows = rec.vars && rec.vars.length > 0 ? rec.vars : [{}]
      if (rows.length === 1 && missingVariables(tpl.prompt, rows[0]).length > 0) {
        return { ok: false, error: '模板含变量但计划未配置变量组' }
      }
      const tasks = buildTasksFromTemplate(tpl, rows)
      for (const t of tasks) putTask(t)
      emit('tasks', { type: 'created', task: tasks[tasks.length - 1], all: listTasks() })
      return { ok: true }
    }
    const text = (rec.prompt ?? '').trim()
    if (!text) return { ok: false, error: '计划未配置 prompt' }
    const t = createTaskRecord({ title: rec.name, prompt: text, tier: rec.tier, maxRetries: rec.maxRetries })
    putTask(t)
    emit('tasks', { type: 'created', task: t, all: listTasks() })
    return { ok: true }
  }

  /** 执行计划并推进状态（lastRunAt/nextRunAt/lastStatus），广播 schedules 事件 */
  const runScheduleAndMark = async (rec: ScheduleRecord): Promise<void> => {
    const r = runSchedule(rec)
    const after = markScheduleRun(rec, r.ok, r.ok ? null : (r.error ?? '未知错误'))
    emit('schedules', { type: 'updated', schedule: after, all: listSchedules() })
  }

  const scheduleRunner = createScheduleRunner({
    list: listSchedules,
    onDue: (rec) => runScheduleAndMark(rec)
  })
  scheduleRunner.start()

  ipcMain.handle('schedules:list', () => listSchedules())

  ipcMain.handle('schedules:get', (_e, id: string) => getSchedule(id))

  ipcMain.handle(
    'schedules:save',
    (
      _e,
      input: {
        id?: string
        name: string
        enabled?: boolean
        kind?: ScheduleRecord['kind']
        intervalMinutes?: number
        dailyTime?: string
        source?: ScheduleRecord['source']
        templateId?: string
        vars?: ScheduleRecord['vars']
        prompt?: string
        tier?: ModelTier
        maxRetries?: number
      }
    ) => {
      const saved = saveSchedule(input)
      emit('schedules', { type: 'updated', schedule: saved, all: listSchedules() })
      return saved
    }
  )

  ipcMain.handle('schedules:remove', (_e, id: string) => {
    removeSchedule(id)
    emit('schedules', { type: 'removed', id, all: listSchedules() })
    return { ok: true }
  })

  /** 立即执行一次（不改变启用状态；执行后按规则推进 nextRunAt） */
  ipcMain.handle('schedules:runNow', async (_e, id: string) => {
    const rec = getSchedule(id)
    if (!rec) return { ok: false, error: '计划不存在' }
    await runScheduleAndMark(rec)
    return { ok: true }
  })

  /** 启停开关 */
  ipcMain.handle('schedules:toggle', (_e, id: string, enabled: boolean) => {
    const rec = getSchedule(id)
    if (!rec) return { ok: false, error: '计划不存在' }
    const saved = saveSchedule({ id, name: rec.name, enabled })
    emit('schedules', { type: 'updated', schedule: saved, all: listSchedules() })
    return { ok: true, schedule: saved }
  })

  // ── 用量看板（M5） ──

  /** 区间用量：读取路由站请求日志（userData/logs/router-<date>.jsonl）并聚合 */
  ipcMain.handle('usage:query', (_e, q?: { days?: number }) => {
    const days = Math.max(1, Math.min(90, Math.round(q?.days ?? 1)))
    const toTs = Date.now()
    const fromTs = toTs - days * 86_400_000
    const report = usageReport(fromTs, toTs)
    // 记录列表只回最近 200 条，聚合值基于全量
    return { ...report, records: report.records.slice(-200).reverse() }
  })

  ipcMain.handle('config:get', () => configView(loadConfig()))

  /** 设置供应商 Key（明文进、密文存）；保存后重启路由站使配置生效 */
  ipcMain.handle('config:setKey', async (_e, id: string, plainKey: string) => {
    const cfg = loadConfig()
    const pv = cfg.providers.find((p) => p.id === id)
    if (!pv) return { ok: false, error: '供应商不存在' }
    pv.apiKeyEnc = plainKey ? encryptSecret(plainKey) : ''
    cfg.onboarded = cfg.onboarded || !!pv.apiKeyEnc
    saveConfig(cfg)
    await applyConfigChange()
    // 填 Key 后自动获取该供应商可用模型并补足三档（需求：填 key 即可用）
    const auto = pv.apiKeyEnc ? await autoFillModels(id) : { models: [], filled: false }
    return { ok: true, hasKey: !!pv.apiKeyEnc, autoModels: auto.models.length, autoFilled: auto.filled }
  })

  /** 更新供应商字段（baseUrl/模型名/优先级/启用） */
  ipcMain.handle('config:updateProvider', (_e, id: string, patch: Partial<ProviderView>) => {
    const cfg = loadConfig()
    const pv = cfg.providers.find((p) => p.id === id)
    if (!pv) return { ok: false, error: '供应商不存在' }
    if (patch.protocol === 'openai' || patch.protocol === 'anthropic') pv.protocol = patch.protocol
    if (typeof patch.baseUrl === 'string') {
      pv.baseUrl = normalizeBaseUrl(patch.baseUrl, pv.protocol ?? 'anthropic')
    }
    if (typeof patch.priority === 'number') pv.priority = patch.priority
    if (typeof patch.enabled === 'boolean') pv.enabled = patch.enabled
    if (patch.models) pv.models = { ...pv.models, ...patch.models }
    if (typeof patch.defaultModel === 'string') pv.defaultModel = patch.defaultModel.trim() || undefined
    saveConfig(cfg)
    void applyConfigChange()
    return { ok: true, provider: toView(pv) }
  })

  /** 新增自定义供应商（第 6 家及以后） */
  ipcMain.handle(
    'config:addProvider',
    (_e, input: { id: string; name: string; baseUrl: string; protocol?: ProviderProtocol }) => {
    const cfg = loadConfig()
    const id = (input.id || '').trim().replace(/[^a-zA-Z0-9-_]/g, '')
    if (!id || !input.baseUrl) return { ok: false, error: '请填写 id 与 base url' }
    if (cfg.providers.some((p) => p.id === id)) return { ok: false, error: 'id 已存在' }
    const protocol: ProviderProtocol = input.protocol === 'openai' ? 'openai' : 'anthropic'
    const pv: ProviderConfig = {
      id,
      name: input.name?.trim() || id,
      baseUrl: normalizeBaseUrl(input.baseUrl, protocol),
      protocol,
      apiKeyEnc: '',
      models: {},
      priority: cfg.providers.length + 1,
      enabled: true,
      builtin: false
    }
    cfg.providers.push(pv)
    saveConfig(cfg)
    void applyConfigChange()
    return { ok: true, provider: toView(pv) }
    }
  )

  ipcMain.handle('config:removeProvider', (_e, id: string) => {
    const cfg = loadConfig()
    const before = cfg.providers.length
    cfg.providers = cfg.providers.filter((p) => p.id !== id || p.builtin)
    saveConfig(cfg)
    void applyConfigChange()
    return { ok: cfg.providers.length < before }
  })

  /** 保存工作区设置 */
  ipcMain.handle('config:saveWorkspace', (_e, patch: Partial<AppConfig['workspace']>) => {
    const cfg = loadConfig()
    Object.assign(cfg.workspace, patch ?? {})
    saveConfig(cfg)
    return { ok: true, workspace: cfg.workspace }
  })

  /** 手动触发：重新拉取该供应商模型并覆盖三档映射 */
  ipcMain.handle('provider:autoFill', async (_e, id: string) => {
    const r = await autoFillModels(id, true)
    const cfg = loadConfig()
    const pv = cfg.providers.find((p) => p.id === id)
    return {
      ok: r.models.length > 0,
      models: r.models,
      fromPreset: r.fromPreset === true,
      error: r.error,
      provider: pv ? toView(pv) : undefined
    }
  })

  /** 测试连接：拉该供应商 /v1/models */
  ipcMain.handle('provider:test', async (_e, id: string) => {
    await ensureRouterReady()
    const router = getRouter()
    if (!router) return { ok: false, error: '路由站未启动' }
    return router.probeProvider(id)
  })

  /** 流式对话 */
  ipcMain.handle(
    'chat:send',
    async (_e, args: { text: string; tier?: ModelTier; appSessionId?: string; cwd?: string; projectId?: string }) => {
      const cfg = loadConfig()
      if (activeProviders(cfg).length === 0) {
        emit('chat', { type: 'error', message: '尚未配置任何可用供应商：请先在设置页填写 API Key' })
        return { ok: false, error: 'no_provider' }
      }
      const router = await ensureRouterReady()
      const runId = nextRunId()
      const tier = normalizeTier(args.tier)

      // 会话持久化：复用已有应用会话（续聊）或新建
      const existing = args.appSessionId ? getSession(args.appSessionId) : null
      const appSessionId = existing
        ? existing.id
        : createSession(tier, args.text, args.projectId ?? null).id
      const cliSessionId = existing?.cliSessionId ?? null
      appendMessage(appSessionId, { role: 'user', text: args.text, ts: Date.now() })

      // 每个 run 独立 AbortController：多会话并行时互不影响，
      // cliSessionId 也按各自的 appSessionId 落盘（见下方 setCliSession），不会互相覆盖。
      const ac = new AbortController()
      running.set(runId, ac)

      // stream 事件统一带 appSessionId（新增字段，不删旧字段）：
      // 渲染层据此按 tab 归流；老订阅者忽略新字段行为不变。
      emit('chat', { type: 'start', runId, sessionId: appSessionId, appSessionId })
      try {
        const res = await runPromptStream(
          args.text,
          {
            env: buildCliEnvOverrides(router, { tier }),
            cwd: args.cwd || cfg.workspace.defaultDir,
            tier,
            resume: cliSessionId ?? undefined,
            permissionMode: cfg.workspace.permissionMode,
            abortController: ac,
            canUseTool: permissionBroker.handler
          },
          {
            onSession: (id) => {
              setCliSession(appSessionId, id)
              emit('chat', { type: 'session', runId, sessionId: id, appSessionId })
            },
            onDelta: (t) => emit('chat', { type: 'delta', runId, text: t, appSessionId }),
            onTool: (name) => emit('chat', { type: 'tool', runId, name, appSessionId })
          }
        )
        appendMessage(appSessionId, {
          role: 'assistant',
          text: res.isError ? `执行失败（${res.errorSubtype ?? 'error'}）` : res.text,
          isError: res.isError,
          ts: Date.now()
        })
        emit('chat', {
          type: res.isError ? 'error' : 'done',
          runId,
          sessionId: res.sessionId,
          appSessionId,
          message: res.isError ? `执行失败（${res.errorSubtype ?? 'error'}）` : undefined,
          numTurns: res.numTurns,
          costUsd: res.costUsd,
          durationMs: res.durationMs
        })
        return { ok: !res.isError, appSessionId, cliSessionId: res.sessionId }
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        log.error('[chat] failed', err)
        appendMessage(appSessionId, { role: 'assistant', text: message, isError: true, ts: Date.now() })
        emit('chat', { type: 'error', runId, message, appSessionId })
        return { ok: false, error: message, appSessionId }
      } finally {
        running.delete(runId)
      }
    }
  )

  /** 会话历史：列表（元信息） */
  ipcMain.handle('sessions:list', () => listSessions())

  /** 会话历史：读取完整记录 */
  ipcMain.handle('sessions:get', (_e, id: string) => getSession(id))

  /** 会话历史：删除 */
  ipcMain.handle('sessions:remove', (_e, id: string) => {
    const ok = removeSession(id)
    return { ok }
  })

  /** 会话：移入/移出项目（projectId=null 为未分组） */
  ipcMain.handle('sessions:setProject', (_e, id: string, projectId: string | null) => ({
    ok: setSessionProject(id, projectId ?? null)
  }))

  /** 会话：归档/取消归档 */
  ipcMain.handle('sessions:archive', (_e, id: string, archived: boolean) => ({
    ok: archiveSession(id, Boolean(archived))
  }))

  // ── 会话项目（对齐 Claude Desktop Projects） ──

  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('projects:save', (_e, input: { id?: string; name: string; description?: string }) =>
    saveProject(input)
  )

  /** 项目归档（同 Claude Desktop：归档后沉底，仍可访问其下会话） */
  ipcMain.handle('projects:archive', (_e, id: string, archived: boolean) => {
    const p = getProject(id)
    if (!p) return { ok: false, error: '项目不存在' }
    const saved = saveProject({ id, name: p.name, description: p.description, archived: Boolean(archived) })
    return { ok: true, project: saved }
  })

  /** 删除项目：其下会话退回未分组（不连坐删数据） */
  ipcMain.handle('projects:remove', (_e, id: string) => {
    const moved = clearProject(id)
    const ok = removeProject(id)
    return { ok, moved }
  })

  /** 权限确认：渲染层裁决回传 */
  ipcMain.handle('permission:respond', (_e, id: string, decision: { allow: boolean; remember: boolean }) => {
    const ok = permissionBroker.respond(id, decision)
    return { ok }
  })

  ipcMain.handle('chat:stop', () => {
    for (const [, ac] of running) ac.abort()
    running.clear()
    return { ok: true }
  })

  // ── 速聊条（M6 v0.2.0） ──

  /**
   * 速聊问答：**不起 CLI**（冷启动 10s+ 不可接受），直连本地路由站 /v1/messages
   * 发一次 stream:false，与任务队列执行器共用 model-router/messages.ts 的同一条链路，
   * 因此自动继承路由站的模型解析 / 故障转移 / 熔断。
   */
  ipcMain.handle(
    'quickchat:ask',
    async (
      _e,
      args: { text: string; tier?: ModelTier }
    ): Promise<{ ok: boolean; text?: string; error?: string; ms?: number; provider?: string }> => {
      const started = Date.now()
      const prompt = (args?.text ?? '').trim()
      if (!prompt) return { ok: false, error: '请输入内容', ms: Date.now() - started }
      // activeProviders 已按 priority 排序，反查供应商时取首个命中即UI应展示的那个
      const actives = activeProviders(loadConfig())
      if (actives.length === 0) {
        return { ok: false, error: '尚未配置任何可用供应商：请先在设置页填写 API Key', ms: Date.now() - started }
      }
      try {
        const router = await ensureRouterReady()
        const r = await callRouterTextDetailed(
          { baseUrl: router.baseUrl, localToken: loadConfig().router.localToken },
          { prompt, tier: normalizeTier(args?.tier), maxTokens: 2048 }
        )
        // 实际承接本次请求的供应商显示名（发生过故障转移时最有意义）：
        // 由响应里的真实模型名反查配置，拿不到就留空，渲染层自行降级显示
        const provider = findProviderByModel(actives, r.model)
        return { ok: true, text: r.text, provider, ms: Date.now() - started }
      } catch (err) {
        log.error('[quickchat] ask failed', err)
        return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300), ms: Date.now() - started }
      }
    }
  )

  /**
   * 速聊答疑转正式会话：createSession + appendMessage（全部复用 sessions.ts，不另起存储），
   * 然后通过 stream:event 推 domain='session' + {type:'open'} 让主窗口打开它，最后收起速聊窗。
   */
  ipcMain.handle(
    'quickchat:handoff',
    (
      _e,
      args: { text: string; tier?: ModelTier; answer?: string }
    ): { ok: boolean; appSessionId?: string; error?: string } => {
      const text = (args?.text ?? '').trim()
      if (!text) return { ok: false, error: '内容为空，无法创建会话' }
      const rec = createSession(normalizeTier(args?.tier), text, null)
      appendMessage(rec.id, { role: 'user', text, ts: Date.now() })
      // 渲染层传入助手原文时写第二条，让投递后的会话里问答成对；
      // 用户手打投送（无 answer）则只写 user 一条，不产生空气泡。
      const answer = (args?.answer ?? '').trim()
      if (answer) {
        appendMessage(rec.id, { role: 'assistant', text: answer, ts: Date.now() })
      }

      // 投递到主窗口：domain='session' + {type:'open', appSessionId}
      // （渲染层 App.tsx 已按这个形状订阅；同域 channel 'session:open' 的直连接口由 preload 的
      //  onSessionOpen 复用同一条 stream:event 派生，避免两处推送造成重复处理）
      emit('session', { type: 'open', appSessionId: rec.id })
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
      }
      hideQuickChat()
      return { ok: true, appSessionId: rec.id }
    }
  )

  /** 收起速聊窗（隐藏不销毁） */
  ipcMain.handle('quickchat:hide', (): void => {
    hideQuickChat()
  })

  /** 当前实际生效的全局热键（降级链注册结果）；未注册成功时返回空串 */
  ipcMain.handle('quickchat:hotkey', (): string => getActiveHotkey() ?? '')

  /**
   * 唤起速聊窗：主窗口「⚡ 速聊」按钮与托盘菜单共用。
   * 这是全局热键失效时的必经入口（三个候选全被占用时用户仍有路可走）。
   */
  ipcMain.handle('quickchat:show', (): { ok: boolean } => {
    try {
      showQuickChat()
      return { ok: true }
    } catch (err) {
      log.error('[quickchat] show via ipc failed', err)
      return { ok: false }
    }
  })

  /**
   * 高度随回答增长：渲染层测出期望尺寸后交主进程真正 resize 窗口。
   * 这是渲染层（fe）在契约之外追加的配套接口，仅主进程侧实现，不改已有契约。
   */
  ipcMain.handle(
    'quickchat:resize',
    (_e, args: { width: number; height: number }): { ok: boolean } => {
      resizeQuickChat(Number(args?.width), Number(args?.height))
      return { ok: true }
    }
  )

  // ── 自动更新（M6 v0.2.0） ──

  /**
   * 检测更新：走 gh api（本机代理只放行 api.github.com，github.com 一律超时，
   * electron-updater 默认通道不可用）。任何失败都回 error 字符串，不抛异常。
   */
  ipcMain.handle('update:check', async () => {
    const res = await runUpdateCheck({ currentVersion: app.getVersion() })
    if (res.error) log.warn('[updater] check failed: %s', res.error)
    return res
  })

  /**
   * 下载更新包到磁盘并打开所在文件夹；不做静默自替换。
   * 进度经 'update:progress' 通道推送给所有窗口（preload 侧由 onUpdateProgress 接收）。
   */
  ipcMain.handle('update:download', async () => {
    const onProgress = (p: UpdateProgress): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('update:progress', p)
      }
    }
    // 优先落到 Downloads，拿不到再退 os.tmpdir()
    let dir: string | undefined
    try {
      dir = app.getPath('downloads')
    } catch {
      dir = undefined
    }
    const res = await runUpdateDownload({ currentVersion: app.getVersion(), dir, onProgress })
    if (res.ok && res.path) {
      log.info('[updater] downloaded -> %s', res.path)
      // 不做静默自替换（放后续版本）：把下载目录打开给用户，由用户自行解覆盖盖
      shell.showItemInFolder(res.path)
    } else {
      log.warn('[updater] download failed: %s', res.error ?? '未知原因')
    }
    return res
  })

  /**
   * 打开更新包所在文件夹（渲染层「打开文件夹」按钮用）。
   * 同样是契约之外的配套接口；只做 reveal，不安装、不替换。
   */
  ipcMain.handle('update:openFolder', (_e, target: string): { ok: boolean; error?: string } => {
    const p = typeof target === 'string' ? target : ''
    if (!p) return { ok: false, error: '路径为空' }
    try {
      if (!fs.existsSync(p)) return { ok: false, error: '文件不存在（可能已被清理）' }
      shell.showItemInFolder(p)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) }
    }
  })
}

/**
 * 配置变更后让新 Key / 模型映射立即生效：热加载，不重启。
 *
 * 不重启是硬要求：CLI 进程启动时把 router.baseUrl 写进 env，重启会换端口，
 * 正在跑的长会话下一轮请求就会打到死端口上（ECONNREFUSED）。
 * 路由站的 getConfig 每次请求实时求值，所以热加载足够生效。
 */
async function applyConfigChange(): Promise<void> {
  try {
    await reloadRouter(loadConfig)
  } catch (err) {
    log.error('[router] reload failed', err)
  }
}
