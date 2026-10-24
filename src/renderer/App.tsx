import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ConfigView,
  ModelTier,
  PermissionDecision,
  PermissionRequestView,
  RouterEvent,
  SessionMeta,
  SessionProject,
  SessionRecord,
  StreamEvent
} from '../shared/preload-api'
import SettingsPage from './SettingsPage'
import MarkdownBlock from './MarkdownBlock'
import bgMain from './assets/mascot/bg-main.jpg'
import TaskQueue from './TaskQueue'
import TemplatesPanel from './TemplatesPanel'
import SchedulePanel from './SchedulePanel'
import UsagePanel from './UsagePanel'
import SessionSidebar from './SessionSidebar'

interface Msg {
  role: 'user' | 'assistant' | 'system'
  text: string
  streaming?: boolean
  /** 主进程上报的执行错误：以故障样式（红字+左标线）呈现，而非助手发言 */
  isError?: boolean
}

const TIER_LABEL: Record<ModelTier, string> = {
  opus: '高（opus 档）',
  sonnet: '中（sonnet 档 · 默认）',
  haiku: '低（haiku 档）'
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<'chat' | 'settings' | 'tasks' | 'templates' | 'schedules' | 'usage'>('chat')
  const [cfg, setCfg] = useState<ConfigView | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [tier, setTier] = useState<ModelTier>('sonnet')
  /** 应用层会话 id（与底层 CLI session 解耦，持久化用） */
  const [appSessionId, setAppSessionId] = useState<string | null>(null)
  const cliSessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState('')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  /** 会话项目（Claude Desktop 式分组） */
  const [projects, setProjects] = useState<SessionProject[]>([])
  /** 当前新建会话将归入的项目（null = 未分组） */
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  /** 当前待裁决的权限请求（null = 无弹窗） */
  const [perm, setPerm] = useState<PermissionRequestView | null>(null)
  const [permRemember, setPermRemember] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    window.workbench.getConfig().then(setCfg).catch(() => setCfg(null))
  }, [])

  const loadSessions = useCallback(() => {
    window.workbench.listSessions().then((list) => setSessions((list as SessionMeta[]) ?? []))
  }, [])

  const loadProjects = useCallback(() => {
    window.workbench.listProjects().then((list) => setProjects((list as SessionProject[]) ?? []))
  }, [])

  useEffect(refresh, [refresh])
  useEffect(loadSessions, [loadSessions])
  useEffect(loadProjects, [loadProjects])

  // 启动即续上最近一次会话（刷新不丢上下文），仅冷启动自动一次
  const bootAutoloaded = useRef(false)
  useEffect(() => {
    if (!bootAutoloaded.current && sessions.length > 0 && !appSessionId) {
      bootAutoloaded.current = true
      void openSession(sessions[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  const openSession = useCallback(async (id: string): Promise<void> => {
    const rec = (await window.workbench.getSession(id)) as SessionRecord | null
    if (!rec) return
    setAppSessionId(rec.id)
    cliSessionIdRef.current = rec.cliSessionId ?? null
    setTier(rec.tier)
    setActiveProjectId(rec.projectId ?? null)
    setMsgs(
      rec.messages.map((m) => ({ role: m.role, text: m.text, isError: m.isError }))
    )
    setPage('chat')
  }, [])

  const newSession = useCallback((projectId: string | null = null): void => {
    setAppSessionId(null)
    cliSessionIdRef.current = null
    setMsgs([])
    setActiveProjectId(projectId)
  }, [])

  useEffect(() => {
    return window.workbench.onStreamEvent((e: StreamEvent) => {
      if (e.domain === 'router') {
        const n = e.payload as RouterEvent
        const text = `↪ 故障转移：${n.fromName ?? n.from}（${n.reasonText}）→ 已切 ${n.toName ?? n.to}`
        setMsgs((prev) => [...prev, { role: 'system', text }])
        setStatus(text)
        return
      }
      if (e.domain === 'permission') {
        setPerm(e.payload as PermissionRequestView)
        setPermRemember(false)
        return
      }
      if (e.domain !== 'chat') return
      const ev = e.payload as ChatEvent
      if (ev.type === 'session') cliSessionIdRef.current = ev.sessionId
      else if (ev.type === 'delta') {
        setMsgs((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + ev.text }
          } else {
            next.push({ role: 'assistant', text: ev.text, streaming: true })
          }
          return next
        })
      } else if (ev.type === 'tool') {
        setStatus(`工具调用：${ev.name}`)
      } else if (ev.type === 'done' || ev.type === 'error') {
        setMsgs((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)))
        setBusy(false)
        if (ev.type === 'error') {
          setMsgs((prev) => [...prev, { role: 'assistant', text: ev.message ?? '执行失败', isError: true }])
        } else {
          const meta: string[] = []
          if (ev.durationMs) meta.push(`${(ev.durationMs / 1000).toFixed(1)}s`)
          if (typeof ev.costUsd === 'number') meta.push(`$${ev.costUsd.toFixed(4)}`)
          setStatus(meta.length ? `完成 · ${meta.join(' · ')}` : '完成')
        }
        loadSessions()
      }
    })
  }, [loadSessions])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    if (cfg && cfg.activeCount === 0) {
      setPage('settings')
      setStatus('请先在设置页填写至少一个供应商的 API Key')
      return
    }
    if (perm) return // 有待裁决的权限弹窗时禁止新发送
    setInput('')
    setBusy(true)
    setStatus('执行中…')
    setMsgs((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '', streaming: true }])
    const res = await window.workbench.sendChat({
      text,
      tier,
      appSessionId: appSessionId ?? undefined,
      projectId: appSessionId ? undefined : (activeProjectId ?? undefined)
    })
    if (res.appSessionId) {
      setAppSessionId(res.appSessionId)
      cliSessionIdRef.current = res.cliSessionId ?? null
      loadSessions()
    }
  }

  const stop = (): void => {
    void window.workbench.stopChat()
    setBusy(false)
    setStatus('已中断')
  }

  const decide = (allow: boolean): void => {
    if (!perm) return
    const decision: PermissionDecision = { allow, remember: permRemember }
    void window.workbench.respondPermission(perm.id, decision)
    setPerm(null)
  }

  const ready = !!cfg && cfg.activeCount > 0

  return (
    <div className="flex h-screen bg-[#0e1216] text-[#d8dfe6]">
      <aside className="w-60 shrink-0 border-r border-[#232c35] flex flex-col">
        <div className="px-4 py-4 border-b border-[#232c35]">
          <div className="font-semibold tracking-wide">ClaudeWorkbench</div>
          <div className="mono text-xs mt-1 flex items-center gap-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                cfg ? (ready ? 'bg-[#53d3e0]' : 'bg-[#e0a34c]') : 'bg-[#3a4650]'
              }`}
            />
            <span className={cfg ? (ready ? 'text-[#53d3e0]' : 'text-[#e0a34c]') : 'text-[#6d8294]'}>
              {cfg ? (ready ? 'READY' : 'STANDBY') : 'BOOT'}
            </span>
          </div>
        </div>
        <nav className="flex flex-col p-2 gap-1">
          <button
            className={`text-left px-3 py-2 rounded text-sm ${
              page === 'chat' ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]' : 'text-[#8b9aa7] hover:bg-[#151b21]'
            }`}
            onClick={() => setPage('chat')}
          >
            对话台
          </button>
          <button
            className={`text-left px-3 py-2 rounded text-sm ${
              page === 'settings'
                ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]'
                : 'text-[#8b9aa7] hover:bg-[#151b21]'
            }`}
            onClick={() => setPage('settings')}
          >
            模型路由站
          </button>
          <button
            className={`text-left px-3 py-2 rounded text-sm ${
              page === 'tasks'
                ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]'
                : 'text-[#8b9aa7] hover:bg-[#151b21]'
            }`}
            onClick={() => setPage('tasks')}
          >
            任务队列
          </button>
          <button
            className={`text-left px-3 py-2 rounded text-sm ${
              page === 'templates'
                ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]'
                : 'text-[#8b9aa7] hover:bg-[#151b21]'
            }`}
            onClick={() => setPage('templates')}
          >
            模板流水线
          </button>
          <button
            className={`text-left px-3 py-2 rounded text-sm ${
              page === 'schedules'
                ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]'
                : 'text-[#8b9aa7] hover:bg-[#151b21]'
            }`}
            onClick={() => setPage('schedules')}
          >
            定时自动化
          </button>
          <button
            className={`text-left px-3 py-2 rounded text-sm ${
              page === 'usage'
                ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]'
                : 'text-[#8b9aa7] hover:bg-[#151b21]'
            }`}
            onClick={() => setPage('usage')}
          >
            用量看板
          </button>
          <button
            className="text-left px-3 py-2 rounded text-sm text-[#53d3e0] hover:bg-[#151b21] border border-[#2f6f7a]/40"
            onClick={() => newSession()}
          >
            + 新会话
          </button>
        </nav>

        <SessionSidebar
          sessions={sessions}
          projects={projects}
          activeSessionId={appSessionId}
          activeProjectId={activeProjectId}
          timeAgo={timeAgo}
          onOpenSession={(id) => void openSession(id)}
          onNewInProject={(pid) => newSession(pid)}
          onChanged={() => {
            loadSessions()
            loadProjects()
          }}
        />

        <div className="px-4 py-3 text-xs text-[#6d8294]">
          可用供应商 <span className="mono text-[#9fb3bf]">{cfg?.activeCount ?? 0}</span> 家
          {cfg?.defaultProviderNow ? <span className="mono"> · {cfg.defaultProviderNow}</span> : ''}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {page === 'settings' ? (
          <SettingsPage cfg={cfg} onChange={refresh} />
        ) : page === 'tasks' ? (
          <TaskQueue />
        ) : page === 'templates' ? (
          <TemplatesPanel />
        ) : page === 'schedules' ? (
          <SchedulePanel />
        ) : page === 'usage' ? (
          <UsagePanel />
        ) : (
          <>
            <div
              className="flex-1 overflow-y-auto px-8 py-6 space-y-4"
              style={{
                backgroundImage: `linear-gradient(to bottom, rgba(14,18,22,0.86), rgba(14,18,22,0.6) 45%, rgba(14,18,22,0.42)), url(${bgMain})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center bottom',
              }}
            >
              {msgs.length === 0 && (
                <div className="h-full flex items-center justify-center">
                  <div className="w-full max-w-md">
                    <div className="mono text-[11px] tracking-[0.18em] text-[#53d3e0] mb-3">STANDBY</div>
                    <div className="text-[19px] text-[#d8dfe6] leading-relaxed mb-2">说下一个指令。</div>
                    <p className="text-sm text-[#8b9aa7] leading-7 mb-6">
                      Claude CLI 在后台执行，结果逐字回流；上游断供时自动换家，不中断会话。
                    </p>
                    <dl className="border-t border-[#232c35] pt-4 space-y-2 text-xs">
                      <div className="flex gap-3">
                        <dt className="w-20 shrink-0 text-[#6d8294]">默认档</dt>
                        <dd className="mono text-[#9fb3bf] break-all">{cfg?.defaultModelNow || '（未配置）'}</dd>
                      </div>
                      <div className="flex gap-3">
                        <dt className="w-20 shrink-0 text-[#6d8294]">路由链</dt>
                        <dd className="mono text-[#9fb3bf]">
                          {cfg?.defaultProviderNow || '—'}
                          {cfg && cfg.activeCount > 1 ? ` +${cfg.activeCount - 1} 备援` : ''}
                        </dd>
                      </div>
                      <div className="flex gap-3">
                        <dt className="w-20 shrink-0 text-[#6d8294]">状态</dt>
                        <dd className={ready ? 'text-[#53d3e0]' : 'text-[#e0a34c]'}>
                          {ready ? '可执行 · 输入即发车' : '未配置 · 先去「模型路由站」填 Key'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              )}
              {msgs.map((m, i) => {
                if (m.role === 'system') {
                  return (
                    <div key={i} className="flex justify-center">
                      <span className="mono text-xs px-3 py-1 rounded-full bg-[#e0a34c]/10 text-[#e0a34c] border border-[#e0a34c]/30">
                        {m.text}
                      </span>
                    </div>
                  )
                }
                if (m.role === 'user') {
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[70%] rounded-lg px-4 py-2 bg-[#24303b] text-[#e8eef4] whitespace-pre-wrap leading-7">
                        {m.text}
                      </div>
                    </div>
                  )
                }
                if (m.isError) {
                  return (
                    <div
                      key={i}
                      className="text-[#e07a7a] leading-7 border-l-2 border-[#a34d4d] pl-3 whitespace-pre-wrap"
                    >
                      {m.text}
                    </div>
                  )
                }
                return (
                  <div key={i} className="leading-7">
                    <MarkdownBlock text={m.text} />
                    {m.streaming && !m.text && <span className="text-[#6d8294]">…</span>}
                    {m.streaming && m.text && <span className="stream-cursor" />}
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-[#232c35] px-8 py-4">
              <div className="flex items-center gap-2 mb-2 text-xs text-[#6d8294]">
                <span>档位</span>
                <select
                  className="mono bg-[#151b21] border border-[#232c35] rounded px-2 py-1 text-[#d8dfe6]"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as ModelTier)}
                >
                  <option value="opus">{TIER_LABEL.opus}</option>
                  <option value="sonnet">{TIER_LABEL.sonnet}</option>
                  <option value="haiku">{TIER_LABEL.haiku}</option>
                </select>
                {appSessionId && (
                  <span className="mono ml-2">
                    对话 <span className="text-[#9fb3bf]">{appSessionId.slice(0, 8)}</span>
                  </span>
                )}
                <button
                  className="ml-auto text-[#6d8294] hover:text-[#d8dfe6]"
                  onClick={() => newSession()}
                >
                  新会话
                </button>
              </div>
              <div className="flex gap-2">
                <textarea
                  className="flex-1 h-20 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
                  placeholder={ready ? '输入指令，Ctrl+Enter 发送' : '请先在「模型路由站」填写 API Key'}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="flex flex-col gap-2">
                  <button
                    className="px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40 disabled:hover:bg-[#1e93a3]"
                    disabled={busy || !input.trim() || !!perm}
                    onClick={() => void send()}
                  >
                    发送
                  </button>
                  <button
                    className="px-4 py-2 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] disabled:opacity-40"
                    disabled={!busy}
                    onClick={stop}
                  >
                    停止
                  </button>
                </div>
              </div>
              <div className="mt-2 mono text-xs text-[#6d8294] min-h-[1rem]">{status}</div>
            </div>
          </>
        )}
      </main>

      {perm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-lg border border-[#2f6f7a] bg-[#11181f] shadow-2xl p-5">
            <div className="text-xs mono text-[#53d3e0] mb-1 tracking-wider">权限确认</div>
            <div className="text-lg text-[#e8eef4] mb-1">
              {perm.displayName ?? '工具调用'}
              <span className="ml-2 text-xs mono text-[#6d8294]">{perm.toolName}</span>
            </div>
            {perm.title && <div className="text-sm text-[#cdd8e0] mb-2">{perm.title}</div>}
            {perm.description && <div className="text-xs text-[#8b9aa7] mb-3">{perm.description}</div>}
            <div className="bg-[#0c1116] border border-[#232c35] rounded px-3 py-2 text-xs mono text-[#9fb3bf] whitespace-pre-wrap break-all mb-4 max-h-40 overflow-y-auto">
              {perm.summary}
            </div>
            {perm.reason && <div className="text-[11px] text-[#e0a34c] mb-3">触发原因：{perm.reason}</div>}
            <label className="flex items-center gap-2 text-xs text-[#8b9aa7] mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={permRemember}
                onChange={(e) => setPermRemember(e.target.checked)}
                className="accent-[#1e93a3]"
              />
              本次允许并记入会话规则（后续相同工具不再询问）
            </label>
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#cdd8e0]"
                onClick={() => decide(false)}
              >
                拒绝
              </button>
              <button
                className="px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium"
                onClick={() => decide(true)}
              >
                {permRemember ? '允许并记住' : '允许'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
