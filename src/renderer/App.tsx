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
import UpdatePanel from './UpdatePanel'
import bgMain from './assets/mascot/bg-main.jpg'
import TaskQueue from './TaskQueue'
import TemplatesPanel from './TemplatesPanel'
import SchedulePanel from './SchedulePanel'
import UsagePanel from './UsagePanel'
import SessionSidebar from './SessionSidebar'
import { pick } from './bridge'

interface Msg {
  role: 'user' | 'assistant' | 'system'
  text: string
  streaming?: boolean
  /** 主进程上报的执行错误：以故障样式（红字+左标线）呈现，而非助手发言 */
  isError?: boolean
}

/** 一个打开的会话页签。key 是页签本地 id，与持久化的 appSessionId 解耦 */
interface Tab {
  key: string
  /** 持久化会话 id；新会话在首次发出前为 null */
  appSessionId: string | null
  /** 底层 CLI session（resume 用），每页签独立，切 tab 不串上下文 */
  cliSessionId: string | null
  title: string
  msgs: Msg[]
  /** 页签各自的输入框草稿：切走再切回，写到一半的话还在 */
  draft: string
  status: string
  tier: ModelTier
  projectId: string | null
  busy: boolean
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

function titleOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return '新会话'
  return one.length > 24 ? `${one.slice(0, 24)}…` : one
}

let tabSeq = 0
function makeTab(projectId: string | null = null): Tab {
  tabSeq += 1
  return {
    key: `t${Date.now().toString(36)}${tabSeq}`,
    appSessionId: null,
    cliSessionId: null,
    title: '新会话',
    msgs: [],
    draft: '',
    status: '',
    tier: 'sonnet',
    projectId,
    busy: false
  }
}

function tabFromRecord(rec: SessionRecord): Tab {
  tabSeq += 1
  return {
    key: `t${Date.now().toString(36)}${tabSeq}`,
    appSessionId: rec.id,
    cliSessionId: rec.cliSessionId ?? null,
    title: rec.title || '新会话',
    msgs: rec.messages.map((m) => ({ role: m.role, text: m.text, isError: m.isError })),
    draft: '',
    status: '',
    tier: rec.tier,
    projectId: rec.projectId ?? null,
    busy: false
  }
}

/** 主进程下发的数据/事件通道（契约未落地时经 pick 拿到 undefined，调用方回落真实桥接） */
interface BridgeApi {
  onSessionOpen?(cb: (appSessionId: string) => void): () => void
  onStreamEvent(cb: (e: StreamEvent) => void): () => void
  getConfig(): Promise<ConfigView>
  getSession(id: string): Promise<SessionRecord | null>
  sendChat(args: {
    text: string
    tier?: ModelTier
    appSessionId?: string
    projectId?: string
  }): Promise<{ ok: boolean; appSessionId?: string; cliSessionId?: string | null; error?: string }>
  /** 速聊条入口：热键之外的常驻按钮（主进程未提供时按钮给出明确反馈） */
  quickChatShow?(): Promise<{ ok: boolean }>
  /** 当前实际生效的全局热键（降级链结果）；按钮上显示真实键位，不写死 Alt+Space */
  getQuickChatHotkey?(): Promise<string>
}

function apiFn<K extends keyof BridgeApi>(k: K): BridgeApi[K] | undefined {
  return pick(k) as BridgeApi[K] | undefined
}

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<'chat' | 'settings' | 'tasks' | 'templates' | 'schedules' | 'usage'>('chat')
  const [cfg, setCfg] = useState<ConfigView | null>(null)
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab()])
  const [activeKey, setActiveKey] = useState('')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  /** 会话项目（Claude Desktop 式分组） */
  const [projects, setProjects] = useState<SessionProject[]>([])
  /** 当前待裁决的权限请求（null = 无弹窗） */
  const [perm, setPerm] = useState<PermissionRequestView | null>(null)
  const [permRemember, setPermRemember] = useState(false)
  /** 速聊入口的反馈：点完必须有下文，不能让人以为按钮是坏的 */
  const [qcHint, setQcHint] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // 首帧把初始页签设为当前页签
  useEffect(() => {
    setActiveKey(tabsRef.current[0]?.key ?? '')
  }, [])

  // 页签读镜像：让事件回调能同步读到最新页签，同时保持 updater 纯净
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey

  // 流式事件按 runId 路由到对应页签：后台页签照样收增量，切回来内容完整
  const runTarget = useRef(new Map<string, string>())
  /** 尚未确定归属的 run（runId -> appSessionId），等会话归属落定再接上 */
  const runPending = useRef(new Map<string, string>())
  /** 本次 send 的发起页签，供 start 事件到达前的归属判定 */
  const pendingSender = useRef<string | null>(null)

  const refresh = useCallback(() => {
    const fn = apiFn('getConfig')
    void (fn ? fn() : window.workbench.getConfig())
      .then(setCfg)
      .catch(() => setCfg(null))
  }, [])

  const loadSessions = useCallback(() => {
    window.workbench.listSessions().then((list) => setSessions((list as SessionMeta[]) ?? []))
  }, [])

  const loadRecord = useCallback(async (id: string): Promise<SessionRecord | null> => {
    const fn = apiFn('getSession')
    const r = fn ? await fn(id) : await window.workbench.getSession(id)
    return (r as SessionRecord) ?? null
  }, [])

  const loadProjects = useCallback(() => {
    window.workbench.listProjects().then((list) => setProjects((list as SessionProject[]) ?? []))
  }, [])

  useEffect(refresh, [refresh])
  useEffect(loadSessions, [loadSessions])
  useEffect(loadProjects, [loadProjects])

  const patchTab = useCallback((key: string, fn: (t: Tab) => Tab) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? fn(t) : t)))
  }, [])

  const findTabBySession = useCallback((id: string | undefined | null): string | null => {
    if (!id) return null
    const hit = tabsRef.current.find((t) => t.appSessionId === id)
    return hit ? hit.key : null
  }, [])

  const activate = useCallback((key: string): void => {
    setActiveKey(key)
    setPage('chat')
  }, [])

  /** 唤起速聊条：热键被占用时这是唯一入口，点了必须有下文 */
  /** 速聊按钮上显示的真实生效热键（由主进程降级链决定；Alt+Space 常被系统占用，写死会造成「按了没反应」） */
  const [qcHotkey, setQcHotkey] = useState('')
  useEffect(() => {
    const fn = apiFn('getQuickChatHotkey')
    if (!fn) return
    let alive = true
    void fn()
      .then((k) => {
        if (alive && k) setQcHotkey(k)
      })
      .catch(() => {
        /* 静默降级：拿不到就不显示键位，不影响唤起功能 */
      })
    return () => {
      alive = false
    }
  }, [])

  const openQuickChat = useCallback(async (): Promise<void> => {
    const fn = apiFn('quickChatShow')
    if (!fn) {
      setQcHint('入口未接入：主进程未提供 quickChatShow')
      return
    }
    try {
      await fn()
      setQcHint('')
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      // contextBridge 对不存在的 key 也返回 function，缺失会在调用时以这类错误暴露
      setQcHint(
        /could not be cloned|is not a function|Cannot read propert/i.test(msg)
          ? '速聊入口未接入：主进程未提供 quickChatShow（当前只能靠热键唤起）'
          : `唤起失败：${msg}`
      )
    }
  }, [])

  const openTab = useCallback((projectId: string | null = null): void => {
    const t = makeTab(projectId)
    setTabs((prev) => [...prev, t])
    setActiveKey(t.key)
    setPage('chat')
  }, [])

  /** 只关页签，绝不删会话数据：会话仍在侧边栏，点开就回来 */
  const closeTab = useCallback((key: string): void => {
    const prev = tabsRef.current
    const idx = prev.findIndex((t) => t.key === key)
    if (idx < 0) return
    const next = prev.filter((t) => t.key !== key)
    if (next.length === 0) {
      // 最后一个页签关掉后留一个空白页签，不让界面塌成空壳
      const fresh = makeTab()
      setTabs([fresh])
      setActiveKey(fresh.key)
    } else {
      setTabs(next)
      if (key === activeKeyRef.current) setActiveKey(next[Math.min(idx, next.length - 1)].key)
    }
    runTarget.current.forEach((tabKey, runId) => {
      if (tabKey === key) runTarget.current.delete(runId)
    })
  }, [])

  /** 打开（或切到）某个持久化会话；尚无归属页签时新开一个 */
  const openSessionInTab = useCallback(async (id: string): Promise<void> => {
    const hitNow = tabsRef.current.find((t) => t.appSessionId === id)
    if (hitNow) {
      setActiveKey(hitNow.key)
      setPage('chat')
      return
    }
    const rec = await loadRecord(id)
    if (!rec) return
    const hitLater = tabsRef.current.find((t) => t.appSessionId === id)
    if (hitLater) {
      setActiveKey(hitLater.key)
      setPage('chat')
      return
    }
    const t = tabFromRecord(rec)
    setTabs((prev) => [...prev, t])
    setActiveKey(t.key)
    setPage('chat')
  }, [loadRecord])

  // 启动即续上最近一次会话（刷新不丢上下文），仅冷启动自动一次
  const bootAutoloaded = useRef(false)
  useEffect(() => {
    if (bootAutoloaded.current || sessions.length === 0) return
    bootAutoloaded.current = true
    void (async () => {
      const rec = await loadRecord(sessions[0].id)
      if (!rec) return
      setTabs((prev) =>
        prev.map((t, i) => {
          // 冷启动期间可能已被速聊投送占了位置，有内容就不覆盖
          if (i !== 0 || t.appSessionId || t.msgs.length > 0) return t
          return {
            ...t,
            appSessionId: rec.id,
            cliSessionId: rec.cliSessionId ?? null,
            title: rec.title || '新会话',
            msgs: rec.messages.map((m) => ({ role: m.role, text: m.text, isError: m.isError })),
            tier: rec.tier,
            projectId: rec.projectId ?? null
          }
        })
      )
    })()
  }, [sessions, loadRecord])

  // 速聊投送过来：「打开/切到该会话」
  useEffect(() => {
    // contextBridge 对不存在的 key 也返回 function，只能在调用时甄别：
    // 注册失败就落回 stream:event 兜底，两路语义一致
    const direct = apiFn('onSessionOpen')
    if (direct) {
      try {
        const off = direct((id) => void openSessionInTab(id))
        if (typeof off === 'function') return off
      } catch {
        /* 落到下面的兜底 */
      }
    }
    const onStream = apiFn('onStreamEvent')
    if (!onStream) return
    return onStream((e: StreamEvent) => {
      if (e.domain !== 'session') return
      const p = e.payload as { type?: string; appSessionId?: string; id?: string }
      if (p?.type && p.type !== 'open') return
      const id = p?.appSessionId ?? p?.id
      if (id) void openSessionInTab(id)
    })
  }, [openSessionInTab])

  useEffect(() => {
    const onStream = apiFn('onStreamEvent')
    if (!onStream) return
    return onStream((e: StreamEvent) => {
      if (e.domain === 'router') {
        const n = e.payload as RouterEvent
        const text = `↪ 故障转移：${n.fromName ?? n.from}（${n.reasonText}）→ 已切 ${n.toName ?? n.to}`
        // 故障转移事件不带 runId，落到正在跑的页签；都没有则给当前页签
        const key = tabsRef.current.find((t) => t.busy)?.key ?? activeKeyRef.current
        if (key) {
          patchTab(key, (t) => ({ ...t, msgs: [...t.msgs, { role: 'system', text }], status: text }))
        }
        return
      }
      if (e.domain === 'permission') {
        setPerm(e.payload as PermissionRequestView)
        setPermRemember(false)
        return
      }
      if (e.domain !== 'chat') return
      const ev = e.payload as ChatEvent
      const startSessionId = ev.type === 'start' ? ev.sessionId : null

      if (ev.type === 'start') {
        const known = findTabBySession(startSessionId) ?? pendingSender.current
        if (known) {
          runTarget.current.set(ev.runId, known)
          pendingSender.current = null
          // 新会话首次发出时，把主进程分配的 id 绑到页签上
          if (startSessionId) {
            patchTab(known, (t) => (t.appSessionId ? t : { ...t, appSessionId: startSessionId }))
          }
        } else if (startSessionId) {
          // 还不知道归属（多为速聊投送）：先挂起，等 session:open 落定
          runPending.current.set(ev.runId, startSessionId)
        }
        return
      }

      // 归属后来才落定（session:open 到达）：把此前挂起的 run 接到对应页签
      if (ev.type === 'delta' && !runTarget.current.has(ev.runId)) {
        const sid = runPending.current.get(ev.runId)
        if (!sid) return
        const key = findTabBySession(sid)
        if (!key) return
        runTarget.current.set(ev.runId, key)
        runPending.current.delete(ev.runId)
      }

      const key = runTarget.current.get(ev.runId)
      if (!key) return

      if (ev.type === 'session') {
        patchTab(key, (t) => ({ ...t, cliSessionId: ev.sessionId }))
      } else if (ev.type === 'delta') {
        patchTab(key, (t) => {
          const next = [...t.msgs]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + ev.text }
          } else {
            next.push({ role: 'assistant', text: ev.text, streaming: true })
          }
          return { ...t, msgs: next }
        })
      } else if (ev.type === 'tool') {
        patchTab(key, (t) => ({ ...t, status: `工具调用：${ev.name}` }))
      } else if (ev.type === 'done' || ev.type === 'error') {
        runTarget.current.delete(ev.runId)
        runPending.current.delete(ev.runId)
        if (ev.type === 'error') {
          patchTab(key, (t) => ({
            ...t,
            busy: false,
            status: `失败 · ${ev.message ?? '执行失败'}`,
            msgs: [
              ...t.msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
              { role: 'assistant', text: ev.message ?? '执行失败', isError: true }
            ]
          }))
        } else {
          const meta: string[] = []
          if (ev.durationMs) meta.push(`${(ev.durationMs / 1000).toFixed(1)}s`)
          if (typeof ev.costUsd === 'number') meta.push(`$${ev.costUsd.toFixed(4)}`)
          patchTab(key, (t) => ({
            ...t,
            busy: false,
            msgs: t.msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
            status: meta.length ? `完成 · ${meta.join(' · ')}` : '完成'
          }))
        }
        loadSessions()
      }
    })
  }, [findTabBySession, loadSessions, patchTab])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [tabs, activeKey])

  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0]

  const send = async (): Promise<void> => {
    if (!active) return
    const text = active.draft.trim()
    if (!text || active.busy) return
    if (cfg && cfg.activeCount === 0) {
      setPage('settings')
      patchTab(active.key, (t) => ({ ...t, status: '请先在设置页填写至少一个供应商的 API Key' }))
      return
    }
    if (perm) return // 有待裁决的权限弹窗时禁止新发送
    const key = active.key
    const isFirst = active.msgs.length === 0
    patchTab(key, (t) => ({
      ...t,
      draft: '',
      busy: true,
      status: '执行中…',
      title: isFirst ? titleOf(text) : t.title,
      msgs: [...t.msgs, { role: 'user', text }, { role: 'assistant', text: '', streaming: true }]
    }))
    pendingSender.current = key
    const args = {
      text,
      tier: active.tier,
      appSessionId: active.appSessionId ?? undefined,
      projectId: active.appSessionId ? undefined : (active.projectId ?? undefined)
    }
    const doSend = apiFn('sendChat')
    const res = doSend ? await doSend(args) : await window.workbench.sendChat(args)
    if (res.appSessionId) {
      patchTab(key, (t) => ({
        ...t,
        appSessionId: res.appSessionId ?? t.appSessionId,
        cliSessionId: res.cliSessionId ?? t.cliSessionId
      }))
      loadSessions()
    }
  }

  const stop = (): void => {
    void window.workbench.stopChat()
    if (active) patchTab(active.key, (t) => ({ ...t, busy: false, status: '已中断' }))
  }

  const decide = (allow: boolean): void => {
    if (!perm) return
    const decision: PermissionDecision = { allow, remember: permRemember }
    void window.workbench.respondPermission(perm.id, decision)
    setPerm(null)
  }

  const ready = !!cfg && cfg.activeCount > 0
  const msgs = active?.msgs ?? []
  const busy = active?.busy ?? false

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
          <button
            data-quickchat-open="1"
            className="mt-2 w-full rounded border border-[#2f6f7a]/40 px-2 py-1 text-[11px] text-[#7ddceb] hover:bg-[#173038]"
            title="随手一问：独立小窗，Esc 收起，想接着聊就投送到完整会话"
            onClick={() => void openQuickChat()}
          >
            ⚡ 速聊 <span className="mono text-[10px] text-[#5f7382]">{qcHotkey || '托盘/热键'}</span>
          </button>
          {qcHint && <div className="mt-1 text-[10px] leading-4 text-[#e0a34c]">{qcHint}</div>}
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
            onClick={() => openTab()}
          >
            + 新会话
          </button>
        </nav>

        <SessionSidebar
          sessions={sessions}
          projects={projects}
          activeSessionId={active?.appSessionId ?? null}
          activeProjectId={active?.projectId ?? null}
          timeAgo={timeAgo}
          onOpenSession={(id) => void openSessionInTab(id)}
          onNewInProject={(pid) => openTab(pid)}
          onChanged={() => {
            loadSessions()
            loadProjects()
          }}
        />

        <UpdatePanel />

        <div className="px-4 py-3 text-xs text-[#6d8294]">
          可用供应商 <span className="mono text-[#9fb3bf]">{cfg?.activeCount ?? 0}</span> 家
          {cfg?.defaultProviderNow ? <span className="mono"> · {cfg.defaultProviderNow}</span> : ''}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {page !== 'chat' ? (
          page === 'settings' ? (
            <SettingsPage cfg={cfg} onChange={refresh} />
          ) : page === 'tasks' ? (
            <TaskQueue />
          ) : page === 'templates' ? (
            <TemplatesPanel />
          ) : page === 'schedules' ? (
            <SchedulePanel />
          ) : (
            <UsagePanel />
          )
        ) : (
          <>
            {/* 会话页签条：后台页签继续跑，进行中页签带呼吸点 */}
            <div className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-[#232c35] bg-[#0e1216] px-2 pt-2">
              {tabs.map((t) => {
                const on = t.key === activeKey
                return (
                  <div
                    key={t.key}
                    data-tab-key={t.key}
                    data-tab-busy={t.busy ? '1' : '0'}
                    className={`group flex shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1.5 ${
                      on ? 'border-[#2f6f7a] bg-[#1a2730]' : 'border-transparent bg-[#151b21] hover:bg-[#1a2129]'
                    }`}
                  >
                    <button
                      data-tab-title={t.key}
                      className="flex max-w-[190px] items-center gap-1.5"
                      onClick={() => activate(t.key)}
                      title={t.title}
                    >
                      {t.busy && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#53d3e0]"
                          title="仍在输出中"
                        />
                      )}
                      <span className={`truncate text-xs ${on ? 'text-white' : 'text-[#8b9aa7]'}`}>{t.title}</span>
                    </button>
                    <button
                      data-tab-close={t.key}
                      className="shrink-0 rounded px-1 text-[11px] leading-4 text-[#5f7382] opacity-0 transition-opacity hover:bg-[#24303b] hover:text-[#cdd8e0] group-hover:opacity-100"
                      title="关闭页签（会话保留，可从左侧重新打开）"
                      onClick={() => closeTab(t.key)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
              <button
                data-tab-new="1"
                className="mb-0.5 shrink-0 rounded px-2 py-0.5 text-sm text-[#6d8294] hover:bg-[#1a2129] hover:text-[#cdd8e0]"
                title="新会话页签"
                onClick={() => openTab()}
              >
                +
              </button>
            </div>

            <div
              className="flex-1 overflow-y-auto px-8 py-6 space-y-4"
              style={{
                backgroundImage: `linear-gradient(to bottom, rgba(14,18,22,0.86), rgba(14,18,22,0.6) 45%, rgba(14,18,22,0.42)), url(${bgMain})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center bottom'
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
                        <dt className="w-20 shrink-0 text-[#6d8294]">速聊</dt>
                        <dd className="text-[#8b9aa7]">随手一问走独立小窗，Esc 收起；想接着聊就「投送到完整会话」。</dd>
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
                  value={active?.tier ?? 'sonnet'}
                  onChange={(e) => {
                    const tier = e.target.value as ModelTier
                    if (active) patchTab(active.key, (t) => ({ ...t, tier }))
                  }}
                >
                  <option value="opus">{TIER_LABEL.opus}</option>
                  <option value="sonnet">{TIER_LABEL.sonnet}</option>
                  <option value="haiku">{TIER_LABEL.haiku}</option>
                </select>
                {active?.appSessionId && (
                  <span className="mono ml-2">
                    对话 <span className="text-[#9fb3bf]">{active.appSessionId.slice(0, 8)}</span>
                  </span>
                )}
                <button className="ml-auto text-[#6d8294] hover:text-[#d8dfe6]" onClick={() => openTab()}>
                  新会话
                </button>
              </div>
              <div className="flex gap-2">
                <textarea
                  className="flex-1 h-20 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
                  placeholder={ready ? '输入指令，Ctrl+Enter 发送' : '请先在「模型路由站」填写 API Key'}
                  value={active?.draft ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (active) patchTab(active.key, (t) => ({ ...t, draft: v }))
                  }}
                  onKeyDown={(e) => {
                    // 输入法组词中的 Ctrl+Enter 是选词，不当作发送
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="flex flex-col gap-2">
                  <button
                    className="px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40 disabled:hover:bg-[#1e93a3]"
                    disabled={busy || !(active?.draft ?? '').trim() || !!perm}
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
              <div className="mt-2 mono text-xs text-[#6d8294] min-h-[1rem]">{active?.status ?? ''}</div>
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
