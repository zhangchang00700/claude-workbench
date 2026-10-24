import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearTasks,
  createTaskRecord,
  getTask,
  initTasksRoot,
  listTasks,
  putTask,
  removeTask
} from './taskStore'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-task-'))
  initTasksRoot(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('任务存储层', () => {
  it('创建 + 读取', () => {
    const t = createTaskRecord({ prompt: '写一段开场白', tier: 'sonnet' })
    expect(t.id).toMatch(/^[0-9a-f]+$/)
    expect(t.status).toBe('queued')
    expect(t.attempts).toBe(0)
    expect(t.title).toContain('写一段开场白')
    putTask(t)
    expect(getTask(t.id)).not.toBeNull()
    expect(getTask(t.id)!.prompt).toBe('写一段开场白')
  })

  it('标题缺省取 prompt 前 40 字', () => {
    const long = 'x'.repeat(100)
    const t = createTaskRecord({ prompt: long })
    expect(t.title.length).toBeLessThanOrEqual(80)
    expect(t.title).toBe(long.slice(0, 40))
  })

  it('缺省 maxTokens/maxRetries 有合理值', () => {
    const t = createTaskRecord({ prompt: 'p' })
    expect(t.maxTokens).toBe(4096)
    expect(t.maxRetries).toBe(1)
  })

  it('列表按 createdAt 升序（FIFO）', () => {
    const a = createTaskRecord({ prompt: 'A' })
    const b = createTaskRecord({ prompt: 'B' })
    // 人为错开时间戳
    a.createdAt = 10
    b.createdAt = 20
    putTask(a)
    putTask(b)
    const ids = listTasks().map((t) => t.id)
    expect(ids[0]).toBe(a.id)
    expect(ids[1]).toBe(b.id)
  })

  it('写入后立即能在列表看到（原子写）', () => {
    const t = createTaskRecord({ prompt: 'p' })
    putTask(t)
    // 模拟状态变更再写
    t.status = 'running'
    t.attempts = 1
    putTask(t)
    const got = getTask(t.id)!
    expect(got.status).toBe('running')
    expect(got.attempts).toBe(1)
  })

  it('删除 + 清空', () => {
    const t = createTaskRecord({ prompt: 'p' })
    putTask(t)
    expect(removeTask(t.id)).toBe(true)
    expect(getTask(t.id)).toBeNull()
    expect(listTasks().length).toBe(0)

    putTask(createTaskRecord({ prompt: 'q1' }))
    putTask(createTaskRecord({ prompt: 'q2' }))
    expect(listTasks().length).toBe(2)
    clearTasks()
    expect(listTasks().length).toBe(0)
  })
})
