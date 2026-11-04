import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  computeNextRun,
  getSchedule,
  initSchedulesRoot,
  listSchedules,
  markScheduleRun,
  normalizeTime,
  removeSchedule,
  saveSchedule
} from './scheduleStore'
import { createScheduleRunner } from './scheduleRunner'
import type { ScheduleRecord } from '../../shared/types'

let tmp: string | null = null

function useTmpRoot(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sch-'))
  initSchedulesRoot(tmp)
  return tmp
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('computeNextRun', () => {
  it('interval：from + N 分钟', () => {
    const from = 1_000_000_000_000
    expect(computeNextRun({ kind: 'interval', intervalMinutes: 30, dailyTime: '09:00' }, from)).toBe(
      from + 30 * 60_000
    )
  })

  it('interval 下限 1 分钟', () => {
    const from = 1_000_000_000_000
    expect(computeNextRun({ kind: 'interval', intervalMinutes: 0, dailyTime: '09:00' }, from)).toBe(
      from + 60_000
    )
  })

  it('daily：当天未过取当天，已过取明天', () => {
    const day = new Date(2026, 9, 17, 10, 0, 0).getTime() // 2026-10-17 10:00 本地
    expect(computeNextRun({ kind: 'daily', intervalMinutes: 60, dailyTime: '09:00' }, day)).toBe(
      new Date(2026, 9, 18, 9, 0, 0).getTime()
    )
    const morning = new Date(2026, 9, 17, 7, 0, 0).getTime()
    expect(computeNextRun({ kind: 'daily', intervalMinutes: 60, dailyTime: '09:00' }, morning)).toBe(
      new Date(2026, 9, 17, 9, 0, 0).getTime()
    )
    // 恰好等于时刻也算已过（<=），取明天
    const exact = new Date(2026, 9, 17, 9, 0, 0).getTime()
    expect(computeNextRun({ kind: 'daily', intervalMinutes: 60, dailyTime: '09:00' }, exact)).toBe(
      new Date(2026, 9, 18, 9, 0, 0).getTime()
    )
  })
})

describe('normalizeTime', () => {
  it('补零与钳制；非法回落 09:00', () => {
    expect(normalizeTime('9:5')).toBe('09:05')
    expect(normalizeTime('23:59')).toBe('23:59')
    expect(normalizeTime('25:99')).toBe('23:59')
    expect(normalizeTime('abc')).toBe('09:00')
    expect(normalizeTime('')).toBe('09:00')
  })
})

describe('计划 CRUD + 运行推进', () => {
  it('新建 → 列表 → 更新（保留 createdAt）→ 删除', () => {
    useTmpRoot()
    const s1 = saveSchedule({ name: '早报', kind: 'daily', dailyTime: '08:30', prompt: '生成早报' })
    const s2 = saveSchedule({ name: '巡检', intervalMinutes: 15, prompt: '巡检任务' })
    expect(s1.enabled).toBe(true)
    expect(s1.nextRunAt).toBeGreaterThan(Date.now() - 1000)
    expect(listSchedules().map((s) => s.name)).toEqual(['巡检', '早报']) // nextRunAt 升序

    const updated = saveSchedule({ id: s1.id, name: '早报V2', dailyTime: '07:00' })
    expect(updated.createdAt).toBe(s1.createdAt)
    expect(updated.dailyTime).toBe('07:00')
    expect(updated.prompt).toBe('生成早报') // 未传的字段保留

    expect(removeSchedule(s2.id)).toBe(true)
    expect(getSchedule(s2.id)).toBeNull()
    expect(listSchedules()).toHaveLength(1)
  })

  it('markScheduleRun：记录上次运行并按规则推进下次', () => {
    useTmpRoot()
    const s = saveSchedule({ name: '巡检', intervalMinutes: 15, prompt: 'x' })
    const before = s.nextRunAt
    const after = markScheduleRun(s, false, '上游 503')
    expect(after.lastStatus).toBe('error')
    expect(after.lastError).toBe('上游 503')
    expect(after.nextRunAt).toBeGreaterThan(before)
    expect(after.lastRunAt).not.toBeNull()
    const ok = markScheduleRun(after, true, null)
    expect(ok.lastStatus).toBe('ok')
    expect(ok.lastError).toBeNull()
  })
})

describe('scheduleRunner', () => {
  const rec = (over: Partial<ScheduleRecord>): ScheduleRecord => ({
    id: 'x',
    name: 'x',
    enabled: true,
    kind: 'interval',
    intervalMinutes: 60,
    dailyTime: '09:00',
    source: 'prompt',
    tier: 'sonnet',
    maxRetries: 1,
    lastRunAt: null,
    nextRunAt: 0,
    lastStatus: 'never',
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  })

  it('到点且 enabled → 触发；未启用不触发', async () => {
    const onDue = vi.fn()
    const runner = createScheduleRunner({
      list: () => [rec({ id: 'a', nextRunAt: 100 }), rec({ id: 'b', enabled: false, nextRunAt: 100 })],
      onDue,
      now: () => 200
    })
    expect(await runner.tick()).toBe(1)
    expect(onDue).toHaveBeenCalledTimes(1)
    expect(onDue.mock.calls[0][0].id).toBe('a')
  })

  it('多个到点按 nextRunAt 升序逐个触发', async () => {
    const order: string[] = []
    const runner = createScheduleRunner({
      list: () => [rec({ id: 'late', nextRunAt: 150 }), rec({ id: 'early', nextRunAt: 100 })],
      onDue: async (r) => {
        order.push(r.id)
      },
      now: () => 200
    })
    await runner.tick()
    expect(order).toEqual(['early', 'late'])
  })

  it('单计划抛错不中断其他计划', async () => {
    const done: string[] = []
    const runner = createScheduleRunner({
      list: () => [rec({ id: 'bad', nextRunAt: 100 }), rec({ id: 'good', nextRunAt: 100 })],
      onDue: (r) => {
        if (r.id === 'bad') throw new Error('boom')
        done.push(r.id)
      },
      now: () => 200
    })
    expect(await runner.tick()).toBe(1) // 只计成功的
    expect(done).toEqual(['good'])
  })

  it('未到点不触发；start/stop/isRunning', async () => {
    vi.useFakeTimers()
    const onDue = vi.fn()
    const runner = createScheduleRunner({
      list: () => [rec({ nextRunAt: Number.MAX_SAFE_INTEGER })],
      onDue,
      tickMs: 1000
    })
    expect(await runner.tick()).toBe(0)
    runner.start()
    expect(runner.isRunning()).toBe(true)
    vi.advanceTimersByTime(3100)
    expect(onDue).not.toHaveBeenCalled()
    runner.stop()
    expect(runner.isRunning()).toBe(false)
    vi.useRealTimers()
  })
})
