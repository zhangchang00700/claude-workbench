/**
 * 定时调度器（M4）。
 *
 * 一个 30 秒 tick 的轮询循环：到点（nextRunAt <= now 且 enabled）的计划
 * 逐个回调 onDue（串行，避免同时刻多计划把上游打爆）；单计划回调抛错
 * 不影响其他计划。计划执行体（把模板/prompt 转成任务入队）由 IPC 层注入。
 *
 * 不依赖 electron，now/tickMs 可注入，便于单测。
 */
import type { ScheduleRecord } from '../../shared/types'

export interface ScheduleRunner {
  start(): void
  stop(): void
  isRunning(): boolean
  /** 立即触发一次扫描（单测与「立即执行」按钮也可复用） */
  tick(): Promise<number>
}

export function createScheduleRunner(opts: {
  list: () => ScheduleRecord[]
  onDue: (rec: ScheduleRecord) => Promise<void> | void
  tickMs?: number
  now?: () => number
}): ScheduleRunner {
  const tickMs = Math.max(1000, opts.tickMs ?? 30_000)
  const now = opts.now ?? (() => Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  let scanning = false

  async function tick(): Promise<number> {
    if (scanning) return 0 // 上一轮没扫完，跳过本轮（背压）
    scanning = true
    let fired = 0
    try {
      const due = opts
        .list()
        .filter((s) => s.enabled && s.nextRunAt <= now())
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
      for (const rec of due) {
        try {
          await opts.onDue(rec)
          fired++
        } catch {
          // 单计划失败由 onDue 内部记状态；这里只保证不中断循环
        }
      }
    } finally {
      scanning = false
    }
    return fired
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(() => void tick(), tickMs)
      // 不 unref：主进程常驻，调度器应随应用生命周期存活
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
    isRunning(): boolean {
      return timer !== null
    },
    tick
  }
}
