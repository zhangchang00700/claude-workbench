// 速聊条渲染层：常驻轻量提问窗（Esc / 失焦即收起，可投送到完整会话）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownBlock from './MarkdownBlock'
import './styles.css'
import './quickchat.css'
import type { ModelTier } from '../shared/preload-api'
import { pick } from './bridge'

interface AskResult {
  ok: boolean
  text?: string
  error?: string
  ms?: number
  provider?: string
}

interface HandoffResult {
  ok: boolean
  appSessionId?: string
  error?: string
}

/** 速聊通道（契约由主进程提供；尚未落地时全部按可选处理，不阻塞 UI） */
interface QuickChatApi {
  quickChatAsk?(a: { text: string; tier?: ModelTier }): Promise<AskResult>
  quickChatHandoff?(a: { text: string; tier?: ModelTier; answer?: string }): Promise<HandoffResult>
  quickChatHide?(): Promise<void>
  /** 高度随回答增长：渲染层测出期望尺寸，由主进程真正 resize 窗口 */
  quickChatResize?(a: { width: number; height: number }): Promise<{ ok: boolean }>
  onQuickChatShown?(cb: () => void): () => void
  /** 当前实际生效的全局热键（主进程降级链注册结果）；空态据此显示「按 XXX 唤起」 */
  getQuickChatHotkey?(): Promise<string>
}

function apiFn<K extends keyof QuickChatApi>(k: K): QuickChatApi[K] | undefined {
  return pick(k) as QuickChatApi[K] | undefined
}

type Phase = 'idle' | 'asking' | 'done' | 'error'

const HINT = 'Enter 发送 · Shift+Enter 换行 · Esc 关闭'
/** 卡片宽度固定；高度由内容决定后交给主进程 resize */
const CARD_W = 640
const BODY_MAX = 460

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function QuickChat(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [draft, setDraft] = useState('')
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<AskResult | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  /** 唤起时间戳：抑制唤起瞬间的失焦抖动（窗口拿到焦点前会先来一次 blur） */
  const shownAt = useRef(Date.now())
  /** 实际生效的全局热键：由主进程降级链决定（Alt+Space 常被系统占用），写死会造成「按了没反应」 */
  const [hotkey, setHotkey] = useState('')

  // 拉一次真实热键；拿不到就静默降级为不显示键位提示，不影响其它功能
  useEffect(() => {
    const fn = apiFn('getQuickChatHotkey')
    if (!fn) return
    let alive = true
    void fn()
      .then((k) => {
        if (alive && k) setHotkey(k)
      })
      .catch(() => {
        /* 静默降级 */
      })
    return () => {
      alive = false
    }
  }, [])

  const focusInput = useCallback((): void => {
    const ta = inputRef.current
    if (!ta) return
    ta.focus()
    const end = ta.value.length
    ta.setSelectionRange(end, end)
  }, [])

  const hide = useCallback((): void => {
    const fn = apiFn('quickChatHide')
    if (!fn) return
    try {
      void fn()
    } catch {
      /* 收起失败不致命：主进程还有 before-input-event 的 Esc 兜底 */
    }
  }, [])

  /** 每次唤起都是一次全新速聊：清掉上一轮问答，不残留旧答案 */
  const reset = useCallback((): void => {
    shownAt.current = Date.now()
    setPhase('idle')
    setDraft('')
    setQuestion('')
    setResult(null)
    focusInput()
  }, [focusInput])

  // 通道一：主进程通知「速聊窗已显示」
  useEffect(() => {
    const on = apiFn('onQuickChatShown')
    if (!on) return
    try {
      const off = on(reset)
      if (typeof off === 'function') return off
    } catch {
      /* 通道异常不阻塞渲染，mount 聚焦仍是兜底 */
    }
  }, [reset])

  // 通道二：mount 自身也聚焦（主进程未推事件时的兜底）
  useEffect(() => {
    focusInput()
    const t = window.setTimeout(focusInput, 60)
    return () => window.clearTimeout(t)
  }, [focusInput])

  // 失焦即收起：唤起瞬间（含从主窗口按钮/IPC 唤起时系统补发的 blur）忽略，
  // 否则窗口刚出来就被自己关掉。宽限 1000ms：覆盖主进程 show→focus 与焦点回移的全过程。
  useEffect(() => {
    const onBlur = (): void => {
      if (Date.now() - shownAt.current < 1000) return
      hide()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [hide])

  // 高度随回答增长：把测出的期望尺寸交给主进程 resize（无通道则静默）
  useLayoutEffect(() => {
    const resize = apiFn('quickChatResize')
    if (!resize) return
    const head = headRef.current?.offsetHeight ?? 0
    const foot = footRef.current?.offsetHeight ?? 0
    const body = Math.min(bodyRef.current?.scrollHeight ?? 0, BODY_MAX)
    const h = Math.min(Math.max(head + body + foot + 20, 156), 680)
    void resize({ width: CARD_W, height: h })
  }, [phase, draft, result])

  // 输入框随内容长高，约 4 行封顶
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 116)}px`
  }, [draft])

  const ask = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || phase === 'asking') return
    setDraft('')
    setQuestion(text)
    setResult(null)
    setPhase('asking')
    const fn = apiFn('quickChatAsk')
    if (!fn) {
      setResult({ ok: false, error: '速聊通道未接入：主进程未提供 quickChatAsk' })
      setPhase('error')
      return
    }
    const t0 = performance.now()
    let r: AskResult
    try {
      r = await fn({ text })
    } catch (err) {
      setResult({ ok: false, error: String((err as Error)?.message ?? err) })
      setPhase('error')
      return
    }
    const ms = typeof r?.ms === 'number' ? r.ms : Math.round(performance.now() - t0)
    setResult({ ...r, ms })
    setPhase(r?.ok && r.text ? 'done' : 'error')
  }, [draft, phase])

  const handoff = useCallback(async (): Promise<void> => {
    const text = (draft.trim() || question).trim()
    if (!text) return
    const fn = apiFn('quickChatHandoff')
    if (!fn) {
      setResult({ ok: false, error: '投送通道未接入：主进程未提供 quickChatHandoff' })
      setPhase('error')
      return
    }
    // 带上助手原文：投递后的会话里问答成对（无回答的手打投送只写 user 一条）
    await fn({ text, answer: result?.ok ? (result.text ?? '') : '' })
    hide()
  }, [draft, question, result, hide])

  // Esc 收起：挂在 window 上，焦点不在输入框时同样生效
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hide])

  // 调试探针（CDP 验证用）
  useEffect(() => {
    ;(window as unknown as { __qcState: () => unknown }).__qcState = () => ({
      phase,
      draft,
      question,
      answerLen: result?.text?.length ?? 0,
      ms: result?.ms ?? null,
      provider: result?.provider ?? null
    })
  }, [phase, draft, question, result])

  const canHandoff = (draft.trim() || question).length > 0
  const bridgeMissing = !apiFn('quickChatAsk')

  return (
    <div className="h-full w-full p-2.5">
      <div
        data-qc-phase={phase}
        data-qc-bridge={bridgeMissing ? 'missing' : 'ready'}
        className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-[#2a3a44] bg-[#0b0f13]/94 shadow-[0_24px_64px_rgba(0,0,0,0.55)] backdrop-blur-xl"
      >
        {/* 顶栏：无按钮，整条可拖动整窗（主进程若用无边框窗时生效） */}
        <div ref={headRef} className="qc-drag flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full bg-[#53d3e0] ${
              phase === 'asking' ? 'animate-pulse' : ''
            }`}
          />
          <span className="mono text-[10px] tracking-[0.2em] text-[#53d3e0]">QUICK CHAT</span>
          <span className="mono ml-auto text-[10px] text-[#4a5763]">速聊 · 不落会话</span>
        </div>

        {/* 回答区：高度随回答增长，超出内部滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-1">
          <div ref={bodyRef}>
            {phase === 'idle' && (
              <div className="flex min-h-[96px] flex-col justify-center">
                <div className="text-[14px] leading-7 text-[#a9b8c4]">问点什么…</div>
                <div className="mt-1 text-[11px] leading-5 text-[#5f7382]">
                  随手一问，答完即走；想接着聊，投送到完整会话里继续。
                </div>
                {hotkey ? (
                  <div className="mt-1 text-[11px] leading-5 text-[#5f7382]">
                    任意界面按 <span className="mono rounded bg-[#1a2730] px-1 text-[#9fb3bf]">{hotkey}</span>{' '}
                    唤起本条 · Esc 收起
                  </div>
                ) : null}
              </div>
            )}

            {phase === 'asking' && (
              <div className="py-1">
                <div className="mb-2 border-l-2 border-[#2f6f7a] pl-2.5 text-[12px] leading-6 text-[#9fb3bf]">
                  {question}
                </div>
                <div className="space-y-2" aria-live="polite" aria-busy="true">
                  <div className="h-2.5 w-[92%] animate-pulse rounded bg-[#1a2730]" />
                  <div className="h-2.5 w-[74%] animate-pulse rounded bg-[#1a2730] [animation-delay:140ms]" />
                  <div className="h-2.5 w-[52%] animate-pulse rounded bg-[#1a2730] [animation-delay:280ms]" />
                </div>
                <div className="mono mt-2 text-[10px] text-[#53d3e0]">思考中…</div>
              </div>
            )}

            {phase === 'done' && result?.text && (
              <div className="py-1">
                <div className="mb-2 truncate border-l-2 border-[#2f6f7a] pl-2.5 text-[12px] leading-6 text-[#9fb3bf]">
                  {question}
                </div>
                <MarkdownBlock text={result.text} />
                <div className="mono mt-2 border-t border-[#232c35] pt-1.5 text-[10px] text-[#5f7382]">
                  {typeof result.ms === 'number' ? fmtMs(result.ms) : ''}
                  {result.provider ? ` · ${result.provider}` : ''}
                </div>
              </div>
            )}

            {phase === 'error' && (
              <div className="py-1">
                {question && (
                  <div className="mb-2 truncate border-l-2 border-[#a34d4d] pl-2.5 text-[12px] leading-6 text-[#9fb3bf]">
                    {question}
                  </div>
                )}
                <div className="border-l-2 border-[#a34d4d] pl-2.5 text-[12px] leading-6 text-[#e07a7a]">
                  {result?.error ?? '提问失败'}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 输入区 */}
        <div ref={footRef} className="shrink-0 px-3 pb-3">
          <div className="flex items-end gap-2 rounded-xl border border-[#232c35] bg-[#12181e]/70 px-2.5 py-1.5 focus-within:border-[#2f6f7a]">
            <textarea
              ref={inputRef}
              rows={1}
              data-qc-input="1"
              className="max-h-[116px] flex-1 resize-none bg-transparent text-[13px] leading-6 text-[#e8eef4] outline-none placeholder:text-[#4a5763]"
              placeholder="问点什么…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 输入法组词过程中的 Enter 是选词，不当作发送
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void ask()
                }
              }}
            />
            {phase === 'asking' ? (
              <span className="mb-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#53d3e0]" />
            ) : (
              <button
                data-qc-send="1"
                className="mb-0.5 shrink-0 rounded px-2.5 py-1 text-[12px] font-medium text-[#06282c] transition-colors enabled:bg-[#1e93a3] enabled:hover:bg-[#26aebf] disabled:border disabled:border-[#2f6f7a]/40 disabled:text-[#5f7382]"
                disabled={!draft.trim()}
                onClick={() => void ask()}
              >
                发送
              </button>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <button
              data-qc-handoff="1"
              className="rounded px-1.5 py-0.5 text-[11px] text-[#7ddceb] transition-colors enabled:hover:bg-[#173038] disabled:opacity-50"
              disabled={!canHandoff}
              onClick={() => void handoff()}
              title="把这句话投送到主窗口的完整会话里继续聊"
            >
              ↩ 投送到完整会话
            </button>
            <span className="mono ml-auto text-[10px] text-[#3f4c57]">{HINT}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<QuickChat />)
