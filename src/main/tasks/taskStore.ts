/**
 * 任务队列持久化存储层（M2）。
 *
 * 每条任务一个 JSON 文件，落在 userData/tasks/<id>.json，原子写（临时文件 + rename）。
 * 任务状态只在「入队」「状态变更」「完成」时落盘，不在运行中途每帧写。
 *
 * 与 sessions.ts 一致：模块不直接 import electron，由主进程启动时
 * 通过 initTasksRoot 注入 userData 目录，便于单测在无 electron 环境下跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ModelTier, PermissionMode, TaskMode, TaskRecord } from '../../shared/types'

let _root: string | null = null

/** 主进程启动时调用一次，注入 userData 目录 */
export function initTasksRoot(userDataDir: string): void {
  _root = path.join(userDataDir, 'tasks')
}

function tasksDir(): string {
  if (!_root) throw new Error('tasks root not initialized; call initTasksRoot() first')
  return _root
}

function taskFile(id: string): string {
  // id 由本层生成（crypto.randomBytes hex），天然安全，无需额外转义
  return path.join(tasksDir(), `${id}.json`)
}

function ensureDir(): void {
  fs.mkdirSync(tasksDir(), { recursive: true })
}

function safeWrite(task: TaskRecord): void {
  ensureDir()
  const target = taskFile(task.id)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

function readOne(id: string): TaskRecord | null {
  try {
    const raw = fs.readFileSync(taskFile(id), 'utf8')
    const rec = JSON.parse(raw) as TaskRecord
    if (!rec || typeof rec.id !== 'string') return null
    return normalizeTask(rec)
  } catch {
    return null
  }
}

/** 全量列表（按 createdAt 升序，先入先出） */
export function listTasks(): TaskRecord[] {
  try {
    ensureDir()
    const files = fs.readdirSync(tasksDir()).filter((f) => f.endsWith('.json'))
    const all: TaskRecord[] = []
    for (const f of files) {
      const rec = readOne(f.replace(/\.json$/, ''))
      if (rec) all.push(rec)
    }
    all.sort((a, b) => a.createdAt - b.createdAt)
    return all
  } catch {
    return []
  }
}

export function getTask(id: string): TaskRecord | null {
  return readOne(id)
}

/** 写入/更新单条任务 */
export function putTask(task: TaskRecord): void {
  safeWrite(task)
}

export function removeTask(id: string): boolean {
  try {
    fs.rmSync(taskFile(id), { force: true })
    return true
  } catch {
    return false
  }
}

/** 清空全部任务（含已完成/失败） */
export function clearTasks(): void {
  try {
    ensureDir()
    for (const f of fs.readdirSync(tasksDir())) {
      if (f.endsWith('.json')) fs.rmSync(path.join(tasksDir(), f), { force: true })
    }
  } catch {
    /* 清空失败不影响调用方 */
  }
}

/**
 * 工厂：生成一个 queued 状态的任务记录。
 * 标题缺省取 prompt 前 40 字，保证列表可读。
 *
 * v0.3.0：新增 mode 通道选择。缺省 'text'，与 M2 行为完全一致；
 * 选 'agent' 时走 CLI，可调工具并支持 resume。
 */
export function createTaskRecord(input: {
  title?: string
  prompt: string
  tier?: ModelTier
  maxTokens?: number
  maxRetries?: number
  mode?: TaskMode
  permissionMode?: PermissionMode
  maxTurns?: number
  cwd?: string | null
}): TaskRecord {
  const now = Date.now()
  const prompt = (input.prompt ?? '').trim()
  const title = (input.title?.trim() || prompt.slice(0, 40) || '未命名任务').slice(0, 80)
  const mode: TaskMode = input.mode === 'agent' ? 'agent' : 'text'
  return {
    id: crypto.randomBytes(10).toString('hex'),
    title,
    prompt,
    tier: input.tier ?? 'sonnet',
    maxTokens: input.maxTokens ?? 4096,
    maxRetries: Math.max(0, input.maxRetries ?? 1),
    status: 'queued',
    attempts: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    output: '',
    error: null,
    lastProvider: null,
    mode,
    cliSessionId: null,
    // agent 通道才需要权限模式；text 通道不涉及工具调用
    permissionMode: mode === 'agent' ? (input.permissionMode ?? 'default') : undefined,
    maxTurns: mode === 'agent' ? Math.max(1, input.maxTurns ?? 20) : undefined,
    cwd: mode === 'agent' ? (input.cwd ?? null) : null
  }
}

/** 旧记录缺 field 时的读取兜底：mode 缺失一律按 'text'（M2 行为）处理 */
export function normalizeTask(t: TaskRecord): TaskRecord {
  if (t.mode !== 'agent') t.mode = 'text'
  if (t.cliSessionId === undefined) t.cliSessionId = null
  if (t.mode === 'agent') {
    if (!t.permissionMode) t.permissionMode = 'default'
    if (!t.maxTurns || t.maxTurns < 1) t.maxTurns = 20
    if (t.cwd === undefined) t.cwd = null
  }
  return t
}
