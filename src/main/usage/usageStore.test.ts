import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initUsageRoot, listLogDates, queryUsage, summarizeUsage, usageReport } from './usageStore'

let tmp: string | null = null

/** 建一份假 userData（日志写在 <tmp>/logs），返回根目录 */
function useTmpLogs(lines: { date: string; entries: Record<string, unknown>[] }[]): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-usage-'))
  const dir = path.join(tmp, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  for (const { date, entries } of lines) {
    fs.writeFileSync(
      path.join(dir, `router-${date}.jsonl`),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    )
  }
  initUsageRoot(tmp)
  return tmp
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('路由日志 → 用量记录', () => {
  it('解析成功/失败/故障转移，跳过无关 kind 与坏行', () => {
    useTmpLogs([
      {
        date: '2026-10-17',
        entries: [
          { ts: '2026-10-17T02:00:00.000Z', kind: 'route', provider: 'glm', model: 'glm-5.3', requestedModel: 'wb-opus', status: 200, ms: 1200 },
          { ts: '2026-10-17T02:00:05.000Z', kind: 'route', provider: 'kimi', model: 'kimi-k3', requestedModel: 'wb-opus', status: 429, ms: 300, error: 'retryable:quota_exhausted' },
          { ts: '2026-10-17T02:00:06.000Z', kind: 'health', provider: 'kimi', error: 'circuit_open' },
          { ts: 'not-a-date', kind: 'route', provider: 'x' }
        ]
      }
    ])
    // 手工补一条坏行（JSON 半行）验证容错
    fs.appendFileSync(path.join(tmp as string, 'logs', 'router-2026-10-17.jsonl'), '{"ts":"2026-10-17T02:00:07.000Z","kind":"ro\n', 'utf8')

    const from = Date.parse('2026-10-17T00:00:00Z')
    const to = Date.parse('2026-10-18T00:00:00Z')
    const recs = queryUsage(from, to)
    expect(recs).toHaveLength(2) // health 与坏行不计
    expect(recs[0].ok).toBe(true)
    expect(recs[0].provider).toBe('glm')
    expect(recs[0].actualModel).toBe('glm-5.3')
    expect(recs[0].requestedModel).toBe('wb-opus')
    expect(recs[1].ok).toBe(false)
    expect(recs[1].failureKind).toBe('failover')
  })

  it('listLogDates 只认 router-*.jsonl 且升序', () => {
    useTmpLogs([
      { date: '2026-10-18', entries: [] },
      { date: '2026-10-16', entries: [] }
    ])
    fs.writeFileSync(path.join(tmp as string, 'logs', 'other.txt'), 'x', 'utf8')
    expect(listLogDates()).toEqual(['2026-10-16', '2026-10-18'])
  })

  it('区间过滤：跨天边界只取区间内', () => {
    useTmpLogs([
      { date: '2026-10-16', entries: [{ ts: '2026-10-16T23:59:00.000Z', kind: 'route', provider: 'a', status: 200, ms: 10 }] },
      { date: '2026-10-17', entries: [{ ts: '2026-10-17T00:30:00.000Z', kind: 'route', provider: 'b', status: 200, ms: 20 }] }
    ])
    const recs = queryUsage(Date.parse('2026-10-17T00:00:00Z'), Date.parse('2026-10-17T23:59:00Z'))
    expect(recs).toHaveLength(1)
    expect(recs[0].provider).toBe('b')
  })
})

describe('聚合统计', () => {
  it('总量/成功率/故障转移/延迟/按供应商/按天', () => {
    useTmpLogs([
      {
        date: '2026-10-17',
        entries: [
          { ts: '2026-10-17T01:00:00.000Z', kind: 'route', provider: 'glm', status: 200, ms: 100 },
          { ts: '2026-10-17T01:00:10.000Z', kind: 'route', provider: 'glm', status: 200, ms: 300 },
          { ts: '2026-10-17T01:00:20.000Z', kind: 'route', provider: 'kimi', status: 429, ms: 200, error: 'retryable:overloaded' },
          { ts: '2026-10-17T01:00:30.000Z', kind: 'route', provider: 'kimi', status: 400, ms: 50, error: 'stream_client_fault:model_not_found' }
        ]
      }
    ])
    const { stats } = usageReport(
      Date.parse('2026-10-17T00:00:00Z'),
      Date.parse('2026-10-18T00:00:00Z')
    )
    expect(stats.total).toBe(4)
    expect(stats.ok).toBe(2)
    expect(stats.failed).toBe(2)
    expect(stats.failovers).toBe(1) // 只有 retryable 计入
    expect(stats.avgMs).toBe(163) // (100+300+200+50)/4 ≈ 163
    expect(stats.maxMs).toBe(300)
    expect(stats.providers.map((p) => p.provider)).toEqual(['glm', 'kimi'])
    expect(stats.providers[0]).toMatchObject({ requests: 2, failed: 0, avgMs: 200 })
    expect(stats.providers[1]).toMatchObject({ requests: 2, failed: 2 })
    expect(stats.days).toHaveLength(1)
    expect(stats.days[0]).toMatchObject({ date: '2026-10-17', requests: 4, failed: 2 })
  })

  it('空数据不炸', () => {
    useTmpLogs([])
    const { records, stats } = usageReport(0, Date.now())
    expect(records).toEqual([])
    expect(stats.total).toBe(0)
    expect(stats.avgMs).toBe(0)
    expect(stats.providers).toEqual([])
    expect(summarizeUsage([]).days).toEqual([])
  })

  it('未指定供应商归入 (未指定)', () => {
    useTmpLogs([
      {
        date: '2026-10-17',
        entries: [{ ts: '2026-10-17T01:00:00.000Z', kind: 'error', requestedModel: 'wb-sonnet', error: 'all_providers_failed' }]
      }
    ])
    const { stats } = usageReport(
      Date.parse('2026-10-17T00:00:00Z'),
      Date.parse('2026-10-18T00:00:00Z')
    )
    expect(stats.total).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.providers[0].provider).toBe('(未指定)')
  })

  it('token 与费用：有价目的累加，无价目的只计 token 不计钱', () => {
    useTmpLogs([
      {
        date: '2026-10-14',
        entries: [
          // 2026-10-14 10:00 本地 = 高峰；deepseek-flash 高峰 2/8
          {
            ts: new Date(2026, 9, 14, 10, 0, 0).toISOString(),
            kind: 'route',
            provider: 'deepseek',
            model: 'deepseek-flash',
            status: 200,
            ms: 100,
            inputTokens: 1_000_000,
            outputTokens: 1_000_000
          },
          // glm 无价目：只统计 token
          {
            ts: new Date(2026, 9, 14, 10, 5, 0).toISOString(),
            kind: 'route',
            provider: 'glm',
            model: 'glm-5.3',
            status: 200,
            ms: 200,
            inputTokens: 500,
            outputTokens: 300
          },
          // 没抓到 token 的旧记录
          {
            ts: new Date(2026, 9, 14, 10, 10, 0).toISOString(),
            kind: 'route',
            provider: 'deepseek',
            model: 'deepseek-flash',
            status: 200,
            ms: 50
          }
        ]
      }
    ])
    const from = new Date(2026, 9, 14, 0, 0, 0).getTime()
    const to = new Date(2026, 9, 15, 0, 0, 0).getTime()
    const { stats, records } = usageReport(from, to)
    expect(stats.total).toBe(3)
    expect(stats.totalInputTokens).toBe(1_000_500)
    expect(stats.totalOutputTokens).toBe(1_000_300)
    expect(stats.tokenRecords).toBe(2) // 第三条没 token
    // deepseek 高峰 1M 输入 + 1M 输出 = 2 + 8 = 10 元；glm 无价目不累加
    expect(stats.totalCost).toBeCloseTo(10, 6)
    const ds = stats.providers.find((p) => p.provider === 'deepseek')!
    expect(ds.inputTokens).toBe(1_000_000)
    expect(ds.cost).toBeCloseTo(10, 6)
    const glm = stats.providers.find((p) => p.provider === 'glm')!
    expect(glm.inputTokens).toBe(500)
    expect(glm.cost).toBe(0)
    // 记录级：无价目模型 cost 为 null（前端显示 '—'）
    expect(records.find((r) => r.actualModel === 'glm-5.3')!.cost).toBeNull()
  })
})