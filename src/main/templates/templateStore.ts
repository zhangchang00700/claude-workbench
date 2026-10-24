/**
 * 提示词模板存储层（M3 模板流水线）。
 *
 * 每个模板一个 JSON 文件，落 userData/templates/<id>.json，原子写（临时文件 + rename）。
 * 与 sessions.ts / taskStore.ts 一致：模块不直接 import electron，由主进程启动时
 * 通过 initTemplatesRoot 注入 userData 目录，便于单测在无 electron 环境下跑。
 *
 * 模板入队逻辑（buildTasksFromTemplate）产出 TaskRecord，复用 M2 任务队列执行，
 * 因此模板天然享受路由站的故障转移、熔断与并发限流。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ModelTier, TaskRecord, TemplateRecord, TemplateVars } from '../../shared/types'
import { extractVariables, missingVariables, renderTemplate } from '../../shared/template-vars'
import { createTaskRecord } from '../tasks/taskStore'

// 变量纯函数的单一真源在 shared/template-vars.ts（渲染层共用），此处转出保持既有 import 路径
export { extractVariables, missingVariables, renderTemplate }

let _root: string | null = null

/** 主进程启动时调用一次，注入 userData 目录 */
export function initTemplatesRoot(userDataDir: string): void {
  _root = path.join(userDataDir, 'templates')
}

function templatesDir(): string {
  if (!_root) throw new Error('templates root not initialized; call initTemplatesRoot() first')
  return _root
}

function templateFile(id: string): string {
  // id 由本层生成（crypto.randomBytes hex），天然安全，无需额外转义
  return path.join(templatesDir(), `${id}.json`)
}

function ensureDir(): void {
  fs.mkdirSync(templatesDir(), { recursive: true })
}

function safeWrite(tpl: TemplateRecord): void {
  ensureDir()
  const target = templateFile(tpl.id)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(tpl, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

function readOne(id: string): TemplateRecord | null {
  try {
    const raw = fs.readFileSync(templateFile(id), 'utf8')
    const rec = JSON.parse(raw) as TemplateRecord
    if (!rec || typeof rec.id !== 'string' || typeof rec.prompt !== 'string') return null
    return rec
  } catch {
    return null
  }
}

/** 全量列表（按 updatedAt 倒序，最近编辑的在前） */
export function listTemplates(): TemplateRecord[] {
  try {
    ensureDir()
    const files = fs.readdirSync(templatesDir()).filter((f) => f.endsWith('.json'))
    const all: TemplateRecord[] = []
    for (const f of files) {
      const rec = readOne(f.replace(/\.json$/, ''))
      if (rec) all.push(rec)
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    return all
  } catch {
    return []
  }
}

export function getTemplate(id: string): TemplateRecord | null {
  return readOne(id)
}

/** 新建或更新模板（带 id 且已存在则更新，保留 createdAt） */
export function saveTemplate(input: {
  id?: string
  name: string
  description?: string
  prompt: string
  tier?: ModelTier
  maxTokens?: number
  maxRetries?: number
}): TemplateRecord {
  const now = Date.now()
  const existing = input.id ? readOne(input.id) : null
  const rec: TemplateRecord = {
    id: existing?.id ?? crypto.randomBytes(10).toString('hex'),
    name: (input.name ?? '').trim() || '未命名模板',
    description: (input.description ?? '').trim(),
    prompt: input.prompt ?? '',
    tier: input.tier ?? 'sonnet',
    maxTokens: input.maxTokens ?? 4096,
    maxRetries: Math.max(0, input.maxRetries ?? 1),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  safeWrite(rec)
  return rec
}

export function removeTemplate(id: string): boolean {
  try {
    fs.rmSync(templateFile(id), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 模板 × 变量组 → 任务列表（流水线核心）。
 * rows 每一行是一条任务的变量取值；单行值时所有任务共用。
 * 多条任务的标题加「 · i/N」后缀，避免列表里一堆同名。
 */
export function buildTasksFromTemplate(tpl: TemplateRecord, rows: TemplateVars[]): TaskRecord[] {
  const total = rows.length
  return rows.map((row, i) => {
    const prompt = renderTemplate(tpl.prompt, row)
    const suffix = total > 1 ? ` · ${i + 1}/${total}` : ''
    return createTaskRecord({
      title: `${tpl.name}${suffix}`,
      prompt,
      tier: tpl.tier,
      maxTokens: tpl.maxTokens,
      maxRetries: tpl.maxRetries
    })
  })
}
