/**
 * 定时计划持久化存储层（M4）。
 *
 * 每个计划一个 JSON 文件，落 userData/schedules/<id>.json，原子写（临时文件 + rename）。
 * 与 sessions/tasks/templates 一致：模块不直接 import electron，由主进程启动时
 * 通过 initSchedulesRoot 注入 userData 目录，便于单测在无 electron 环境下跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ModelTier, ScheduleRecord } from '../../shared/types'

let _root: string | null = null

/** 主进程启动时调用一次，注入 userData 目录 */
export function initSchedulesRoot(userDataDir: string): void {
  _root = path.join(userDataDir, 'schedules')
}

function schedulesDir(): string {
  if (!_root) throw new Error('schedules root not initialized; call initSchedulesRoot() first')
  return _root
}

function scheduleFile(id: string): string {
  return path.join(schedulesDir(), `${id}.json`)
}

function ensureDir(): void {
  fs.mkdirSync(schedulesDir(), { recursive: true })
}

function safeWrite(rec: ScheduleRecord): void {
  ensureDir()
  const target = scheduleFile(rec.id)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

function readOne(id: string): ScheduleRecord | null {
  try {
    const raw = fs.readFileSync(scheduleFile(id), 'utf8')
    const rec = JSON.parse(raw) as ScheduleRecord
    if (!rec || typeof rec.id !== 'string') return null
    return rec
  } catch {
    return null
  }
}

/** 全量列表（按 nextRunAt 升序，快触发的在前） */
export function listSchedules(): ScheduleRecord[] {
  try {
    ensureDir()
    const all: ScheduleRecord[] = []
    for (const f of fs.readdirSync(schedulesDir())) {
      if (!f.endsWith('.json')) continue
      const rec = readOne(f.replace(/\.json$/, ''))
      if (rec) all.push(rec)
    }
    all.sort((a, b) => a.nextRunAt - b.nextRunAt)
    return all
  } catch {
    return []
  }
}

export function getSchedule(id: string): ScheduleRecord | null {
  return readOne(id)
}

/** 新建或更新计划（带 id 且已存在则更新，保留 createdAt） */
export function saveSchedule(input: {
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
}): ScheduleRecord {
  const now = Date.now()
  const existing = input.id ? readOne(input.id) : null
  const rec: ScheduleRecord = {
    id: existing?.id ?? crypto.randomBytes(10).toString('hex'),
    name: (input.name ?? '').trim() || '未命名计划',
    enabled: input.enabled ?? existing?.enabled ?? true,
    kind: input.kind ?? existing?.kind ?? 'interval',
    intervalMinutes: Math.max(1, input.intervalMinutes ?? existing?.intervalMinutes ?? 60),
    dailyTime: normalizeTime(input.dailyTime ?? existing?.dailyTime ?? '09:00'),
    source: input.source ?? existing?.source ?? 'prompt',
    templateId: input.templateId ?? existing?.templateId,
    vars: input.vars ?? existing?.vars,
    prompt: input.prompt ?? existing?.prompt,
    tier: input.tier ?? existing?.tier ?? 'sonnet',
    maxRetries: Math.max(0, input.maxRetries ?? existing?.maxRetries ?? 1),
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: computeNextRun(
      {
        kind: input.kind ?? existing?.kind ?? 'interval',
        intervalMinutes: Math.max(1, input.intervalMinutes ?? existing?.intervalMinutes ?? 60),
        dailyTime: normalizeTime(input.dailyTime ?? existing?.dailyTime ?? '09:00')
      },
      now
    ),
    lastStatus: existing?.lastStatus ?? 'never',
    lastError: existing?.lastError ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  safeWrite(rec)
  return rec
}

export function removeSchedule(id: string): boolean {
  try {
    fs.rmSync(scheduleFile(id), { force: true })
    return true
  } catch {
    return false
  }
}

/** 'HH:mm' 规范化；非法值回落 09:00 */
export function normalizeTime(raw: string): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((raw ?? '').trim())
  if (!m) return '09:00'
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const min = Math.min(59, Math.max(0, Number(m[2])))
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/**
 * 计算下一次触发时间（纯函数，可单测）。
 * interval：from + N 分钟（忽略秒级抖动，按整周期推进）。
 * daily：本地时间今天/明天的 HH:mm；已过则取明天。
 */
export function computeNextRun(
  rule: { kind: ScheduleRecord['kind']; intervalMinutes: number; dailyTime: string },
  from: number
): number {
  if (rule.kind === 'daily') {
    const [h, min] = normalizeTime(rule.dailyTime).split(':').map(Number)
    const d = new Date(from)
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min, 0, 0)
    if (target.getTime() <= from) target.setDate(target.getDate() + 1)
    return target.getTime()
  }
  return from + Math.max(1, rule.intervalMinutes) * 60_000
}

/** 到点执行后推进状态：lastRunAt=now、nextRunAt 从 now 起算、按结果记状态 */
export function markScheduleRun(rec: ScheduleRecord, ok: boolean, error: string | null): ScheduleRecord {
  const now = Date.now()
  const next: ScheduleRecord = {
    ...rec,
    lastRunAt: now,
    nextRunAt: computeNextRun(rec, now),
    lastStatus: ok ? 'ok' : 'error',
    lastError: ok ? null : (error ?? '未知错误').slice(0, 500),
    updatedAt: now
  }
  safeWrite(next)
  return next
}
