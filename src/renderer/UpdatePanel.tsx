import { useCallback, useEffect, useState } from 'react'
import { pick } from './bridge'

interface CheckResult {
  hasUpdate: boolean
  current?: string
  latest?: string
  notes?: string
  assetName?: string
  assetSize?: number
  error?: string
}

interface DownloadResult {
  ok: boolean
  path?: string
  error?: string
}

interface ProgressPayload {
  phase: string
  percent?: number
  message?: string
}

/** 更新通道（契约由主进程提供；未落地时全部按可选处理，不阻塞 UI） */
interface UpdateApi {
  checkUpdate?(): Promise<CheckResult>
  downloadUpdate?(): Promise<DownloadResult>
  onUpdateProgress?(cb: (p: ProgressPayload) => void): () => void
  openUpdateFolder?(path: string): Promise<{ ok: boolean }>
}

function apiFn<K extends keyof UpdateApi>(k: K): UpdateApi[K] | undefined {
  return pick(k) as UpdateApi[K] | undefined
}

type Stage = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'downloaded' | 'failed'

const PHASE_LABEL: Record<string, string> = {
  check: '正在查询…',
  found: '发现新版本',
  download: '下载中',
  write: '写入中',
  done: '完成',
  error: '失败'
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function phaseText(p: ProgressPayload): string {
  const label = PHASE_LABEL[p.phase] ?? p.message ?? p.phase
  return typeof p.percent === 'number' ? `${label} ${Math.round(p.percent)}%` : label
}

export default function UpdatePanel(): React.JSX.Element {
  const [ver, setVer] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [info, setInfo] = useState<CheckResult | null>(null)
  const [note, setNote] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState<ProgressPayload | null>(null)

  useEffect(() => {
    window.workbench
      .getVersion()
      .then((v) => setVer(v ?? ''))
      .catch(() => setVer(''))
  }, [])

  // 下载进度：只订阅一次，进度属于本次下载而非面板生命周期
  useEffect(() => {
    const on = apiFn('onUpdateProgress')
    if (!on) return
    return on((p) => {
      setProgress(p)
      if (p.phase === 'error') {
        setStage('failed')
        setNote(p.message ?? '下载失败')
      }
    })
  }, [])

  const check = useCallback(async (): Promise<void> => {
    const fn = apiFn('checkUpdate')
    if (!fn) {
      setStage('failed')
      setNote('更新通道未接入：主进程未提供 checkUpdate')
      return
    }
    setStage('checking')
    setNote('')
    setInfo(null)
    setSavedPath('')
    setCopied(false)
    let r: CheckResult
    try {
      // contextBridge 对不存在的 key 也返回 function，真正的缺失会在调用时暴露
      r = await fn()
    } catch (err) {
      setStage('failed')
      setNote(`更新通道不可用：${String((err as Error)?.message ?? err)}`)
      return
    }
    if (r.error && !r.hasUpdate) {
      setStage('failed')
      setNote(`检查失败：${r.error}`)
      return
    }
    setInfo(r)
    if (r.current) setVer(r.current)
    setStage(r.hasUpdate ? 'available' : 'uptodate')
  }, [])

  const download = useCallback(async (): Promise<void> => {
    const fn = apiFn('downloadUpdate')
    if (!fn) {
      setStage('failed')
      setNote('下载通道未接入：主进程未提供 downloadUpdate')
      return
    }
    setStage('downloading')
    setNote('')
    setProgress(null)
    let r: DownloadResult
    try {
      r = await fn()
    } catch (err) {
      setStage('failed')
      setNote(`下载通道不可用：${String((err as Error)?.message ?? err)}`)
      return
    }
    if (r.ok && r.path) {
      setSavedPath(r.path)
      setStage('downloaded')
    } else {
      setStage('failed')
      setNote(r.error ?? '下载失败')
    }
  }, [])

  const openFolder = useCallback(async (): Promise<void> => {
    if (!savedPath) return
    const fn = apiFn('openUpdateFolder')
    if (fn) {
      await fn(savedPath)
      return
    }
    // 无通道时退化：把完整路径交给用户（可复制）
    try {
      await navigator.clipboard.writeText(savedPath)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }, [savedPath])

  const pct = typeof progress?.percent === 'number' ? Math.min(100, Math.max(0, progress.percent)) : null

  return (
    <div className="border-t border-[#232c35] px-4 py-3" data-update-stage={stage}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[#6d8294]">版本</span>
        <span className="mono text-xs text-[#9fb3bf]" data-update-version={ver}>
          {ver ? `v${ver}` : '—'}
        </span>
        <button
          data-update-check="1"
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-[#9fb3bf] enabled:hover:bg-[#1a2129] disabled:opacity-40"
          disabled={stage === 'checking' || stage === 'downloading'}
          onClick={() => void check()}
        >
          {stage === 'checking' ? '检查中…' : '检查更新'}
        </button>
      </div>

      {stage === 'uptodate' && (
        <div className="mt-1.5 text-[11px] leading-5 text-[#7fd39a]">
          已是最新版本（v{ver}）
          <span className="mono ml-1 text-[#5f7382]">{new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>
        </div>
      )}

      {stage === 'available' && info?.hasUpdate && (
        <div className="mt-1.5">
          <div className="text-[11px] leading-5 text-[#e0a34c]">
            有新版本 <span className="mono font-medium">v{info.latest}</span>
            {typeof info.assetSize === 'number' && info.assetSize > 0 && (
              <span className="mono ml-1 text-[#8b9aa7]">{fmtSize(info.assetSize)}</span>
            )}
          </div>
          {info.assetName && (
            <div className="mono mt-0.5 truncate text-[10px] text-[#5f7382]" title={info.assetName}>
              {info.assetName}
            </div>
          )}
          {info.notes && (
            <div className="mt-1 max-h-[54px] overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-[#8b9aa7]">
              {info.notes}
            </div>
          )}
          <button
            data-update-download="1"
            className="mt-1.5 w-full rounded bg-[#1e93a3] px-2 py-1 text-[11px] font-medium text-[#06282c] hover:bg-[#26aebf]"
            onClick={() => void download()}
          >
            下载更新
          </button>
        </div>
      )}

      {stage === 'downloading' && (
        <div className="mt-1.5">
          <div className="mono text-[10px] text-[#53d3e0]">
            {progress ? phaseText(progress) : '准备下载…'}
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-[#1a2129]">
            <div
              className="h-full rounded bg-[#53d3e0] transition-[width] duration-200"
              style={{ width: pct === null ? '35%' : `${pct}%` }}
            />
          </div>
          {pct === null && <div className="mt-1 text-[10px] text-[#5f7382]">未上报百分比时按不确定进度显示</div>}
        </div>
      )}

      {stage === 'downloaded' && (
        <div className="mt-1.5">
          <div className="text-[11px] leading-5 text-[#7fd39a]">已下载完成</div>
          <div className="mono mt-0.5 break-all text-[10px] leading-4 text-[#5f7382]">{savedPath}</div>
          <button
            data-update-open="1"
            className="mt-1.5 w-full rounded bg-[#173038] px-2 py-1 text-[11px] text-[#7ddceb] hover:bg-[#1d3d47]"
            onClick={() => void openFolder()}
          >
            打开所在文件夹
          </button>
          {copied && <div className="mt-1 text-[10px] text-[#7fd39a]">路径已复制（主进程未提供打开通道）</div>}
        </div>
      )}

      {stage === 'failed' && (
        <div className="mt-1.5 text-[11px] leading-5 text-[#e07a7a]">{note || '更新失败'}</div>
      )}
    </div>
  )
}
