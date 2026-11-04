/**
 * 用量统计（M5 日志看板核心）。
 *
 * 数据源是路由站已有的请求日志 userData/logs/router-<date>.jsonl：
 * 每次上游尝试都会写一条（kind='route' 带 provider/请求模型→实际模型/status/ms/error，
 * 成功无 error、失败带 retryable:/stream_failure:/client_fault: 前缀），全部失败再补一条
 * kind='error'（all_providers_failed）。
 *
 * 因此本模块只做解析与聚合，不新增埋点、不碰流式热路径；模块不 import electron，
 * 由主进程通过 initUsageRoot 注入 userData 目录，便于单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DayBucket, ProviderBucket, UsageRecordView, UsageStats } from '../../shared/types'
import { estimateCost } from './pricing'

let _logsDir: string | null = null

/** 主进程启动时调用一次，注入 userData 目录（读 userData/logs） */
export function initUsageRoot(userDataDir: string): void {
  _logsDir = path.join(userDataDir, 'logs')
}

function logsDir(): string {
  if (!_logsDir) throw new Error('usage root not initialized; call initUsageRoot() first')
  return _logsDir
}

/** 路由日志的一条原始行 */
interface RouterLogLine {
  ts?: string
  kind?: string
  provider?: string
  model?: string
  requestedModel?: string
  status?: number
  ms?: number
  inputTokens?: number
  outputTokens?: number
  error?: string
  detail?: string
}

/** 日志文件名里的日期（router-YYYY-MM-DD.jsonl → YYYY-MM-DD） */
function dateOfFile(file: string): string {
  const m = /router-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)
  return m ? m[1] : ''
}

function readDayLines(date: string): RouterLogLine[] {
  const file = path.join(logsDir(), `router-${date}.jsonl`)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: RouterLogLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as RouterLogLine
      if (parsed && typeof parsed === 'object') out.push(parsed)
    } catch {
      /* 跳过半行（写入被打断） */
    }
  }
  return out
}

/** 列出日志里所有日期（升序） */
export function listLogDates(): string[] {
  try {
    return fs
      .readdirSync(logsDir())
      .map(dateOfFile)
      .filter((d) => !!d)
      .sort()
  } catch {
    return []
  }
}

/** 失败原因分类：从 error 字段前缀推断 */
function failureKind(error: string): 'failover' | 'fault' | 'fatal' {
  if (/^(retryable|stream_failure):/.test(error)) return 'failover'
  if (/^(stream_client_fault|http_?\d)/.test(error)) return 'fault'
  return 'fatal'
}

/** 原始日志行 → 展示用记录 */
function toView(line: RouterLogLine): UsageRecordView | null {
  if (line.kind !== 'route' && line.kind !== 'error') return null
  const ts = line.ts ? Date.parse(line.ts) : NaN
  if (Number.isNaN(ts)) return null
  const failed = !!line.error
  const inputTokens = typeof line.inputTokens === 'number' ? line.inputTokens : null
  const outputTokens = typeof line.outputTokens === 'number' ? line.outputTokens : null
  return {
    ts,
    provider: line.provider ?? null,
    requestedModel: line.requestedModel ?? null,
    actualModel: line.model ?? null,
    status: line.status ?? null,
    ms: line.ms ?? null,
    ok: !failed && (line.status === 200 || line.kind === 'route'),
    inputTokens,
    outputTokens,
    cost: estimateCost(line.model ?? null, ts, inputTokens ?? 0, outputTokens ?? 0),
    failureKind: failed ? failureKind(line.error as string) : null,
    error: failed ? (line.error as string).slice(0, 300) : null
  }
}

/** 查询区间内的全部记录（按时间升序） */
export function queryUsage(fromTs: number, toTs: number): UsageRecordView[] {
  const dates = listLogDates().filter((d) => {
    const start = Date.parse(`${d}T00:00:00`)
    // 文件按天分桶：跨天时取相邻一天即可（起点/终点各放宽一天容错）
    return start <= toTs + 86_400_000 && start + 86_400_000 >= fromTs
  })
  const out: UsageRecordView[] = []
  for (const d of dates) {
    for (const line of readDayLines(d)) {
      const v = toView(line)
      if (v && v.ts >= fromTs && v.ts <= toTs) out.push(v)
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/** 聚合统计：总量/成功率/故障转移次数/按供应商/按天/延迟 */
export function summarizeUsage(records: UsageRecordView[]): UsageStats {
  const total = records.length
  let ok = 0
  let failovers = 0
  let msSum = 0
  let msCount = 0
  let maxMs = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCost = 0
  let tokenRecords = 0
  const byProvider = new Map<string, ProviderBucket>()
  const byDay = new Map<string, DayBucket>()

  for (const r of records) {
    const day = new Date(r.ts).toISOString().slice(0, 10)
    const d = byDay.get(day) ?? { date: day, requests: 0, failed: 0 }
    d.requests++
    byDay.set(day, d)

    const key = r.provider ?? '(未指定)'
    const b = byProvider.get(key) ?? {
      provider: key,
      requests: 0,
      failed: 0,
      avgMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    }
    b.requests++
    byProvider.set(key, b)

    if (r.ok) ok++
    else {
      b.failed++
      d.failed++
      if (r.failureKind === 'failover') failovers++
    }
    if (typeof r.ms === 'number') {
      msSum += r.ms
      msCount++
      b.avgMs += r.ms
      if (r.ms > maxMs) maxMs = r.ms
    }
    if ((r.inputTokens ?? 0) > 0 || (r.outputTokens ?? 0) > 0) {
      tokenRecords++
      const inTok = r.inputTokens ?? 0
      const outTok = r.outputTokens ?? 0
      totalInputTokens += inTok
      totalOutputTokens += outTok
      b.inputTokens += inTok
      b.outputTokens += outTok
      if (typeof r.cost === 'number') {
        totalCost += r.cost
        b.cost += r.cost
      }
    }
  }

  const providers: ProviderBucket[] = [...byProvider.values()]
    .map((b) => ({ ...b, avgMs: b.requests > 0 ? Math.round(b.avgMs / b.requests) : 0 }))
    .sort((a, b) => b.requests - a.requests)

  const days: DayBucket[] = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    total,
    ok,
    failed: total - ok,
    failovers,
    avgMs: msCount > 0 ? Math.round(msSum / msCount) : 0,
    maxMs,
    totalInputTokens,
    totalOutputTokens,
    totalCost,
    tokenRecords,
    providers,
    days
  }
}

/** 区间查询 + 聚合一步到位 */
export function usageReport(fromTs: number, toTs: number): { records: UsageRecordView[]; stats: UsageStats } {
  const records = queryUsage(fromTs, toTs)
  return { records, stats: summarizeUsage(records) }
}