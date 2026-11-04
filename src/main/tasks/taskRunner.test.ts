import { describe, expect, it, vi } from 'vitest'
import { createTaskRunner, type TaskBackend, type TaskExecutor } from './taskRunner'
import type { TaskRecord } from '../../shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await sleep(15)
  }
}

function makeBackend(): TaskBackend {
  const map = new Map<string, TaskRecord>()
  return {
    list: () => [...map.values()].sort((a, b) => a.createdAt - b.createdAt),
    get: (id) => map.get(id) ?? null,
    put: (t) => {
      map.set(t.id, { ...t })
    },
    remove: (id) => {
      map.delete(id)
    },
    clear: () => map.clear()
  }
}

function mkTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: Math.random().toString(36).slice(2),
    title: 't',
    prompt: 'p',
    tier: 'sonnet',
    maxTokens: 100,
    maxRetries: 1,
    status: 'queued',
    attempts: 0,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    output: '',
    error: null,
    ...over
  }
}

describe('任务编排器', () => {
  it('成功执行 → succeeded 并记录输出', async () => {
    const backend = makeBackend()
    const executor = vi.fn<TaskExecutor>(async (t) => `out:${t.prompt}`)
    const runner = createTaskRunner({ backend, executor, getConcurrency: () => 2, onEvent: () => {} })
    backend.put(mkTask({ id: 'a', prompt: 'hello' }))
    runner.start()
    await waitUntil(() => backend.get('a')!.status === 'succeeded')
    expect(backend.get('a')!.output).toBe('out:hello')
    expect(backend.get('a')!.attempts).toBe(1)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('并发不超过上限', async () => {
    const backend = makeBackend()
    let current = 0
    let maxSeen = 0
    const executor = vi.fn<TaskExecutor>(async () => {
      current++
      maxSeen = Math.max(maxSeen, current)
      await sleep(30)
      current--
      return 'x'
    })
    const runner = createTaskRunner({ backend, executor, getConcurrency: () => 2, onEvent: () => {} })
    for (let i = 0; i < 4; i++) backend.put(mkTask({ id: `t${i}` }))
    runner.start()
    await waitUntil(() => backend.list().every((t) => t.status === 'succeeded'))
    expect(maxSeen).toBeLessThanOrEqual(2)
  })

  it('失败后在重试次数内成功 → succeeded', async () => {
    const backend = makeBackend()
    let calls = 0
    const executor = vi.fn<TaskExecutor>(async () => {
      calls++
      if (calls < 3) throw new Error(`boom${calls}`)
      return 'ok'
    })
    const runner = createTaskRunner({
      backend,
      executor,
      getConcurrency: () => 1,
      retryDelayMs: 1,
      onEvent: () => {}
    })
    backend.put(mkTask({ id: 'a', maxRetries: 2 }))
    runner.start()
    await waitUntil(() => backend.get('a')!.status === 'succeeded')
    expect(backend.get('a')!.attempts).toBe(3)
    expect(backend.get('a')!.output).toBe('ok')
  })

  it('超过重试次数 → failed 且记录错误', async () => {
    const backend = makeBackend()
    const executor = vi.fn<TaskExecutor>(async () => {
      throw new Error('always')
    })
    const runner = createTaskRunner({
      backend,
      executor,
      getConcurrency: () => 1,
      retryDelayMs: 1,
      onEvent: () => {}
    })
    backend.put(mkTask({ id: 'a', maxRetries: 1 }))
    runner.start()
    await waitUntil(() => backend.get('a')!.status === 'failed')
    expect(backend.get('a')!.attempts).toBe(2)
    expect(backend.get('a')!.error).toContain('always')
  })

  it('取消排队任务 → cancelled 且未执行', async () => {
    const backend = makeBackend()
    const executor = vi.fn<TaskExecutor>(async () => 'x')
    const runner = createTaskRunner({ backend, executor, getConcurrency: () => 1, onEvent: () => {} })
    backend.put(mkTask({ id: 'a' }))
    runner.cancel('a')
    expect(backend.get('a')!.status).toBe('cancelled')
    expect(executor).not.toHaveBeenCalled()
  })

  it('取消运行中任务 → cancelled', async () => {
    const backend = makeBackend()
    const executor = vi.fn<TaskExecutor>(async (_t, signal) => {
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(resolve, 5000)
        signal.addEventListener('abort', () => {
          clearTimeout(to)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
      return 'x'
    })
    const runner = createTaskRunner({ backend, executor, getConcurrency: () => 1, onEvent: () => {} })
    backend.put(mkTask({ id: 'a' }))
    runner.start()
    await waitUntil(() => backend.get('a')!.status === 'running')
    runner.cancel('a')
    await waitUntil(() => backend.get('a')!.status === 'cancelled')
    expect(backend.get('a')!.status).toBe('cancelled')
  })

  it('重试失败任务 → 重新排队并成功', async () => {
    const backend = makeBackend()
    let calls = 0
    const executor = vi.fn<TaskExecutor>(async () => {
      calls++
      if (calls < 2) throw new Error('fail')
      return 'recovered'
    })
    const runner = createTaskRunner({
      backend,
      executor,
      getConcurrency: () => 1,
      retryDelayMs: 1,
      onEvent: () => {}
    })
    backend.put(mkTask({ id: 'a', maxRetries: 0 }))
    runner.start()
    await waitUntil(() => backend.get('a')!.status === 'failed')
    runner.retry('a')
    await waitUntil(() => backend.get('a')!.status === 'succeeded')
    expect(backend.get('a')!.output).toBe('recovered')
  })

  it('任务按创建顺序执行（FIFO）', async () => {
    const backend = makeBackend()
    const order: string[] = []
    const executor = vi.fn<TaskExecutor>(async (t) => {
      order.push(t.id)
      await sleep(10)
      return 'x'
    })
    const runner = createTaskRunner({ backend, executor, getConcurrency: () => 1, onEvent: () => {} })
    backend.put(mkTask({ id: 'first', createdAt: 1 }))
    backend.put(mkTask({ id: 'second', createdAt: 2 }))
    runner.start()
    await waitUntil(() => backend.list().every((t) => t.status === 'succeeded'))
    expect(order).toEqual(['first', 'second'])
  })

  it('暂停后不再起新任务', async () => {
    const backend = makeBackend()
    const executor = vi.fn<TaskExecutor>(async () => {
      await sleep(40)
      return 'x'
    })
    const runner = createTaskRunner({ backend, executor, getConcurrency: () => 1, onEvent: () => {} })
    backend.put(mkTask({ id: 'a' }))
    backend.put(mkTask({ id: 'b' }))
    runner.start()
    await waitUntil(() => backend.get('a')!.status === 'running')
    runner.pause()
    // a 在跑；b 应保持排队，不被启动
    await sleep(60)
    expect(backend.get('b')!.status).toBe('queued')
    expect(executor).toHaveBeenCalledTimes(1)
  })
})
