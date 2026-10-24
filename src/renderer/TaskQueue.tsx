import { useCallback, useEffect, useState } from 'react'
import type { ModelTier, TaskEvent, TaskRecord } from '../shared/preload-api'
import type { TaskStatus } from '../shared/types'

const TIER_LABEL: Record<ModelTier, string> = {
  opus: '高（opus）',
  sonnet: '中（sonnet·默认）',
  haiku: '低（haiku）'
}

const STATUS_META: Record<TaskStatus, { label: string; cls: string; dot: string }> = {
  queued: { label: '排队中', cls: 'text-[#8b9aa7] border-[#2a3640]', dot: 'bg-[#6d8294]' },
  running: { label: '执行中', cls: 'text-[#53d3e0] border-[#2f6f7a]', dot: 'bg-[#53d3e0]' },
  succeeded: { label: '完成', cls: 'text-[#5ec98b] border-[#2f5a45]', dot: 'bg-[#5ec98b]' },
  failed: { label: '失败', cls: 'text-[#e07a7a] border-[#5a2f2f]', dot: 'bg-[#e07a7a]' },
  cancelled: { label: '已取消', cls: 'text-[#e0a34c] border-[#5a4a2f]', dot: 'bg-[#e0a34c]' }
}

function Stat({ label, value, cls }: { label: string; value: number; cls?: string }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 rounded bg-[#12181e] border border-[#232c35]">
      <div className="text-[10px] text-[#6d8294] uppercase tracking-wider">{label}</div>
      <div className={`mono text-sm ${cls ?? 'text-[#d8dfe6]'}`}>{value}</div>
    </div>
  )
}

export default function TaskQueue(): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [tier, setTier] = useState<ModelTier>('sonnet')
  const [maxRetries, setMaxRetries] = useState(1)
  const [batch, setBatch] = useState(false)
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const refresh = useCallback(() => {
    window.workbench
      .listTasks()
      .then((list) => setTasks((list as TaskRecord[]) ?? []))
      .catch(() => setTasks([]))
  }, [])

  useEffect(refresh, [refresh])

  useEffect(() => {
    return window.workbench.onStreamEvent((e) => {
      if (e.domain !== 'tasks') return
      const ev = e.payload as TaskEvent
      if (ev.type === 'cleared') {
        setTasks([])
        setRunning(false)
        return
      }
      const next = ev.all
      setTasks(next)
      setRunning(next.some((t) => t.status === 'running' || t.status === 'queued'))
    })
  }, [])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2500)
  }, [])

  const add = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text) return
    const res = await window.workbench.createTask({
      title: title.trim() || undefined,
      prompt: text,
      tier,
      maxRetries,
      batch
    })
    notify(batch ? `已加入 ${res.count} 条任务` : '已加入队列')
    setPrompt('')
    setTitle('')
  }

  const start = async (): Promise<void> => {
    const r = await window.workbench.startTasks()
    setRunning(r.running)
    if (!r.running) notify('没有排队中的任务')
  }

  const pause = async (): Promise<void> => {
    await window.workbench.pauseTasks()
    setRunning(false)
  }

  const clear = async (): Promise<void> => {
    if (!confirm('清空全部任务（含已完成/失败）？此操作不可撤销。')) return
    await window.workbench.clearTasks()
  }

  const retryFailed = async (): Promise<void> => {
    const failed = tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled')
    for (const t of failed) await window.workbench.retryTask(t.id)
    notify(`已重试 ${failed.length} 条`)
  }

  const counts = {
    total: tasks.length,
    running: tasks.filter((t) => t.status === 'running').length,
    queued: tasks.filter((t) => t.status === 'queued').length,
    done: tasks.filter((t) => t.status === 'succeeded').length,
    failed: tasks.filter((t) => t.status === 'failed').length
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* 顶部：新增任务表单 */}
      <div className="border-b border-[#232c35] px-8 py-5">
        <div className="text-sm font-semibold text-[#d8dfe6] mb-3">新建任务</div>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <input
            className="bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
            placeholder={batch ? '每行一条任务（按行批量拆分）' : '任务标题（留空则取首句）'}
            value={title}
            disabled={batch}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select
            className="mono bg-[#151b21] border border-[#232c35] rounded px-2 py-2 text-sm text-[#d8dfe6]"
            value={tier}
            onChange={(e) => setTier(e.target.value as ModelTier)}
          >
            <option value="opus">{TIER_LABEL.opus}</option>
            <option value="sonnet">{TIER_LABEL.sonnet}</option>
            <option value="haiku">{TIER_LABEL.haiku}</option>
          </select>
        </div>
        <textarea
          className="mt-3 w-full h-24 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
          placeholder={batch ? '把多行 prompt 粘进来，每行一条任务' : '输入任务指令（纯文本 prompt，由路由站批量执行）'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="mt-3 flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-[#8b9aa7] cursor-pointer">
            <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} className="accent-[#1e93a3]" />
            批量（按行拆分）
          </label>
          <label className="flex items-center gap-2 text-xs text-[#8b9aa7]">
            重试次数
            <input
              type="number"
              min={0}
              max={5}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              className="mono w-16 bg-[#151b21] border border-[#232c35] rounded px-2 py-1 text-[#d8dfe6]"
            />
          </label>
          <button
            className="ml-auto px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
            disabled={!prompt.trim()}
            onClick={() => void add()}
          >
            加入队列
          </button>
        </div>
      </div>

      {/* 控制条 + 统计 */}
      <div className="flex items-center gap-3 px-8 py-3 border-b border-[#232c35]">
        {running ? (
          <button className="px-4 py-1.5 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]" onClick={() => void pause()}>
            暂停
          </button>
        ) : (
          <button
            className="px-4 py-1.5 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
            disabled={counts.queued === 0}
            onClick={() => void start()}
          >
            开始
          </button>
        )}
        <button className="px-3 py-1.5 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] disabled:opacity-40" disabled={counts.failed === 0} onClick={() => void retryFailed()}>
          重试失败
        </button>
        <button className="px-3 py-1.5 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] disabled:opacity-40" disabled={tasks.length === 0} onClick={() => void clear()}>
          清空
        </button>
        <div className="ml-auto flex gap-2">
          <Stat label="总计" value={counts.total} />
          <Stat label="排队" value={counts.queued} cls="text-[#6d8294]" />
          <Stat label="执行" value={counts.running} cls="text-[#53d3e0]" />
          <Stat label="完成" value={counts.done} cls="text-[#5ec98b]" />
          <Stat label="失败" value={counts.failed} cls="text-[#e07a7a]" />
        </div>
      </div>

      {toast && <div className="px-8 py-1 mono text-xs text-[#6d8294]">{toast}</div>}

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto px-8 py-4 space-y-2">
        {tasks.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="mono text-[11px] tracking-[0.18em] text-[#53d3e0] mb-2">TASK QUEUE</div>
              <p className="text-sm text-[#8b9aa7]">队列为空。在上方填写 prompt 后「加入队列」，再点「开始」批量执行。</p>
              <p className="text-xs text-[#6d8294] mt-2">任务由本地路由站统一执行，自动享受故障转移与并发限流。</p>
            </div>
          </div>
        )}
        {tasks.map((t) => {
          const meta = STATUS_META[t.status]
          const isOpen = expanded === t.id
          return (
            <div key={t.id} className="rounded-lg border border-[#232c35] bg-[#12181e] px-4 py-3">
              <div className="flex items-start gap-3">
                <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full ${meta.dot} ${t.status === 'running' ? 'animate-pulse' : ''}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[#d8dfe6] truncate">{t.title}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
                    <span className="mono text-[10px] text-[#6d8294]">档位 {t.tier}</span>
                    <span className="mono text-[10px] text-[#6d8294]">
                      尝试 {t.attempts}/{t.maxRetries + 1}
                    </span>
                  </div>
                  <div className="text-xs text-[#7c8c98] mt-0.5 truncate">{t.prompt}</div>
                  {t.status === 'failed' && t.error && (
                    <div className="text-[11px] text-[#e07a7a] mt-1 truncate">错误：{t.error}</div>
                  )}
                  {(t.status === 'succeeded' || (t.status === 'failed' && t.output)) && (
                    <button
                      className="text-[11px] text-[#53d3e0] hover:underline mt-1"
                      onClick={() => setExpanded(isOpen ? null : t.id)}
                    >
                      {isOpen ? '收起输出' : '查看输出'}
                    </button>
                  )}
                  {isOpen && (t.output || t.error) && (
                    <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-all bg-[#0c1116] border border-[#232c35] rounded px-3 py-2 text-xs text-[#cdd8e0]">
                      {t.output || t.error}
                    </pre>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  {(t.status === 'queued' || t.status === 'running') && (
                    <button
                      className="text-[11px] px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#e0a34c]"
                      onClick={() => void window.workbench.cancelTask(t.id)}
                    >
                      取消
                    </button>
                  )}
                  {(t.status === 'failed' || t.status === 'cancelled') && (
                    <button
                      className="text-[11px] px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() => void window.workbench.retryTask(t.id)}
                    >
                      重试
                    </button>
                  )}
                  <button
                    className="text-[11px] px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#6d8294] hover:text-[#e07a7a]"
                    onClick={() => void window.workbench.removeTask(t.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
