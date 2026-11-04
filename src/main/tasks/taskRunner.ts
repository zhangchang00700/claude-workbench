/**
 * 任务编排器（M2 核心）。
 *
 * 职责：从存储层拉取 queued 任务，在并发上限内并行执行，处理失败重试、
 * 暂停（让在跑的跑完、不再起新的）、取消（abort 运行中的 / 直接置取消未起的）、
 * 以及「重试失败任务」。
 *
 * 关键解耦：**executor 可注入**。生产环境注入直连路由站的 fetch 执行器；
 * 单测注入假执行器，从而不依赖 electron / 网络即可验证并发与重试逻辑。
 *
 * 设计取舍：
 * - 重试退避期间仍占用该任务的并发槽位（M2 简单可靠；maxRetries 小、退避短，影响可忽略）
 * - 暂停为 graceful：不 abort 正在跑的任务，仅停止调度新任务
 * - 全部 queued 且 inflight 为 0 时自动退出 pump 循环
 */
import type { TaskRecord } from '../../shared/types'

/** 单条任务执行器：拿到任务与一个 AbortSignal，返回最终文本。失败必须 reject（runner 据此重试/判定失败）。 */
export type TaskExecutor = (task: TaskRecord, signal: AbortSignal) => Promise<string>

/** 存储后端（实现复用 taskStore 的模块函数） */
export interface TaskBackend {
  list(): TaskRecord[]
  get(id: string): TaskRecord | null
  put(task: TaskRecord): void
  remove(id: string): void
  clear(): void
}

/** 实时事件（与渲染层 TaskEvent 对齐；all 为最新全量列表） */
export type TaskRunnerEvent =
  | { type: 'created' | 'updated'; task: TaskRecord; all: TaskRecord[] }
  | { type: 'removed'; id: string; all: TaskRecord[] }
  | { type: 'cleared' }

export interface TaskRunnerDeps {
  backend: TaskBackend
  executor: TaskExecutor
  /** 并发上限（取自 workspace.maxConcurrent，至少 1） */
  getConcurrency: () => number
  /** 状态变更回调（→ 渲染层 stream:event domain='tasks'） */
  onEvent: (e: TaskRunnerEvent) => void
  /** 重试退避基数（毫秒），默认 800 */
  retryDelayMs?: number
}

export interface TaskRunner {
  /** 启动调度（若已在跑则无操作） */
  start(): void
  /** 暂停：停止调度新任务，在跑的继续 */
  pause(): void
  /** 取消某任务：运行中则 abort，未起则直接置 cancelled */
  cancel(id: string): void
  /** 把失败/已取消任务重置为 queued 并启动调度 */
  retry(id: string): void
  isRunning(): boolean
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const { backend, executor, getConcurrency, onEvent } = deps
  const retryDelayMs = deps.retryDelayMs ?? 800

  let running = false
  const inflight = new Map<string, AbortController>()

  const emit = (type: TaskRunnerEvent['type'], task?: TaskRecord, id?: string): void => {
    if (type === 'cleared') {
      onEvent({ type: 'cleared' })
      return
    }
    if (type === 'removed') {
      onEvent({ type: 'removed', id: id ?? task?.id ?? '', all: backend.list() })
      return
    }
    onEvent({ type, task: task!, all: backend.list() })
  }

  /** 执行单条任务（含内部重试循环）；结束时维护 inflight 与事件 */
  const runOne = async (task: TaskRecord): Promise<void> => {
    const ac = new AbortController()
    inflight.set(task.id, ac)

    task.status = 'running'
    task.startedAt = Date.now()
    if (task.attempts === 0) task.attempts = 1
    backend.put(task)
    emit('updated', task)

    let lastErr = ''
    const maxAttempts = task.maxRetries + 1
    for (let attempt = task.attempts; attempt <= maxAttempts; attempt++) {
      if (ac.signal.aborted) break
      task.attempts = attempt
      backend.put(task)
      try {
        const out = await executor(task, ac.signal)
        if (ac.signal.aborted) break // 执行中途被取消
        task.output = out
        task.error = null
        task.status = 'succeeded'
        task.finishedAt = Date.now()
        backend.put(task)
        inflight.delete(task.id)
        emit('updated', task)
        return
      } catch (err) {
        lastErr = String((err as Error)?.message ?? err).slice(0, 500)
        if (ac.signal.aborted || (err as Error)?.name === 'AbortError') break
        if (attempt < maxAttempts) {
          // 退避后重试（仍占该并发槽位，M2 简单可靠）
          await sleep(Math.min(2000, retryDelayMs * attempt))
          if (ac.signal.aborted) break
        }
      }
    }

    const aborted = ac.signal.aborted
    task.status = aborted ? 'cancelled' : 'failed'
    task.error = aborted ? task.error ?? '已取消' : lastErr
    if (task.finishedAt == null) task.finishedAt = Date.now()
    backend.put(task)
    inflight.delete(task.id)
    emit('updated', task)
  }

  /** 调度主循环：在并发上限内持续拉取 queued 任务 */
  const pump = async (): Promise<void> => {
    while (running) {
      const queued = backend.list().filter((t) => t.status === 'queued')
      if (queued.length === 0) {
        if (inflight.size === 0) {
          running = false
          break
        }
        await sleep(50) // 等至少一个在跑的完成
        continue
      }
      if (inflight.size >= getConcurrency()) {
        await sleep(50)
        continue
      }
      void runOne(queued[0]) // 同步前缀会立即把该任务标记 running 并计入 inflight
    }
  }

  const start = (): void => {
    if (running) return
    const hasQueued = backend.list().some((t) => t.status === 'queued')
    if (!hasQueued) return
    running = true
    void pump()
  }

  const pause = (): void => {
    running = false // 在跑的继续执行，仅停止起新的
  }

  const cancel = (id: string): void => {
    const task = backend.get(id)
    if (!task) return
    const ac = inflight.get(id)
    if (ac) {
      ac.abort() // runOne 会捕获并置 cancelled
      return
    }
    // 还没开跑（queued/paused）：直接置取消
    if (task.status === 'queued') {
      task.status = 'cancelled'
      task.finishedAt = Date.now()
      backend.put(task)
      emit('updated', task)
    }
  }

  const retry = (id: string): void => {
    const task = backend.get(id)
    if (!task) return
    if (task.status !== 'failed' && task.status !== 'cancelled') return
    task.status = 'queued'
    task.attempts = 0
    task.output = ''
    task.error = null
    task.startedAt = null
    task.finishedAt = null
    backend.put(task)
    emit('updated', task)
    start()
  }

  return {
    start,
    pause,
    cancel,
    retry,
    isRunning: () => running
  }
}
