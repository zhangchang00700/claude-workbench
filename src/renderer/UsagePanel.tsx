import { useCallback, useEffect, useState } from 'react'
import type { UsageRecordView, UsageStats } from '../shared/preload-api'

const RANGES = [
  { days: 1, label: '今天' },
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' }
]

function Stat({ label, value, cls }: { label: string; value: number | string; cls?: string }): React.JSX.Element {
  return (
    <div className="px-3 py-2 rounded bg-[#12181e] border border-[#232c35] min-w-[92px]">
      <div className="text-[10px] text-[#6d8294] uppercase tracking-wider">{label}</div>
      <div className={`mono text-sm ${cls ?? 'text-[#d8dfe6]'}`}>{value}</div>
    </div>
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** token 数紧凑显示：1234 → 1.2k，1234567 → 1.23M */
function fmtTok(n: number): string {
  if (!n) return '-'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 金额：<0.01 显示 4 位小数，否则 2 位 */
function fmtMoney(n: number): string {
  if (!n) return '—'
  return `¥${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
}

const FAIL_LABEL: Record<'failover' | 'fault' | 'fatal', { label: string; cls: string }> = {
  failover: { label: '已转移', cls: 'text-[#e0a34c]' },
  fault: { label: '请求错', cls: 'text-[#e07a7a]' },
  fatal: { label: '失败', cls: 'text-[#e07a7a]' }
}

export default function UsagePanel(): React.JSX.Element {
  const [days, setDays] = useState(1)
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [records, setRecords] = useState<UsageRecordView[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    window.workbench
      .queryUsage(days)
      .then((r) => {
        setStats(r.stats)
        setRecords(r.records ?? [])
      })
      .catch(() => {
        setStats(null)
        setRecords([])
      })
      .finally(() => setLoading(false))
  }, [days])

  useEffect(refresh, [refresh])
  // 路由站每次请求都会写日志，切回本面板时刷新一次即可看到最新
  useEffect(() => {
    const t = window.setInterval(refresh, 15_000)
    return () => window.clearInterval(t)
  }, [refresh])

  const maxDay = stats?.days.reduce((m, d) => Math.max(m, d.requests), 0) ?? 0
  const okRate = stats && stats.total > 0 ? Math.round((stats.ok / stats.total) * 100) : 0

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-y-auto px-8 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">用量看板</h2>
        <span className="text-xs text-[#6d8294]">数据来自路由站请求日志，实时反映每次上游尝试</span>
        <div className="ml-auto flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              className={`text-xs px-2.5 py-1 rounded ${
                days === r.days ? 'bg-[#1e93a3] text-[#06282c]' : 'bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]'
              }`}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* 统计卡 */}
      <div className="flex gap-3 flex-wrap">
        <Stat label="总请求" value={stats?.total ?? 0} />
        <Stat label="成功" value={stats?.ok ?? 0} cls="text-[#5ec98b]" />
        <Stat label="失败" value={stats?.failed ?? 0} cls="text-[#e07a7a]" />
        <Stat label="成功率" value={`${okRate}%`} cls={okRate >= 95 ? 'text-[#5ec98b]' : 'text-[#e0a34c]'} />
        <Stat label="故障转移" value={stats?.failovers ?? 0} cls="text-[#e0a34c]" />
        <Stat label="平均延迟" value={`${stats?.avgMs ?? 0}ms`} />
        <Stat label="输入 token" value={fmtTok(stats?.totalInputTokens ?? 0)} />
        <Stat label="输出 token" value={fmtTok(stats?.totalOutputTokens ?? 0)} />
        <Stat label="估算费用" value={fmtMoney(stats?.totalCost ?? 0)} cls="text-[#53d3e0]" />
        {loading && <div className="mono text-xs text-[#6d8294] self-end">刷新中…</div>}
      </div>

      {/* 每日请求量 */}
      {stats && stats.days.length > 0 && (
        <div className="rounded border border-[#232c35] bg-[#12181e] px-4 py-3">
          <div className="text-xs text-[#8b9aa7] mb-2">每日请求量（红=失败）</div>
          <div className="flex items-end gap-1 h-20">
            {stats.days.map((d) => {
              const h = maxDay > 0 ? Math.max(2, Math.round((d.requests / maxDay) * 64)) : 2
              const failH = d.requests > 0 ? Math.max(1, Math.round((d.failed / maxDay) * 64)) : 0
              return (
                <div key={d.date} className="flex flex-col items-center gap-1" title={`${d.date} ${d.requests} 次 / 失败 ${d.failed}`}>
                  <div className="flex flex-col justify-end w-5" style={{ height: 64 }}>
                    <div className="bg-[#53d3e0] rounded-t" style={{ height: h }} />
                    <div className="bg-[#e07a7a]" style={{ height: failH }} />
                  </div>
                  <span className="mono text-[9px] text-[#6d8294]">{d.date.slice(5)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 按供应商 */}
      <div className="rounded border border-[#232c35] bg-[#12181e]">
        <div className="px-4 py-2 border-b border-[#232c35] text-xs text-[#8b9aa7]">按供应商</div>
        {stats && stats.providers.length > 0 ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#6d8294]">
                <th className="text-left px-4 py-2 font-normal">供应商</th>
                <th className="text-right px-4 py-2 font-normal">请求</th>
                <th className="text-right px-4 py-2 font-normal">失败</th>
                <th className="text-right px-4 py-2 font-normal">平均延迟</th>
                <th className="text-right px-4 py-2 font-normal">输入/输出</th>
                <th className="text-right px-4 py-2 font-normal">估算费用</th>
              </tr>
            </thead>
            <tbody className="mono">
              {stats.providers.map((p) => (
                <tr key={p.provider} className="border-t border-[#1a2129]">
                  <td className="px-4 py-1.5 text-[#d8dfe6]">{p.provider}</td>
                  <td className="px-4 py-1.5 text-right text-[#d8dfe6]">{p.requests}</td>
                  <td className={`px-4 py-1.5 text-right ${p.failed > 0 ? 'text-[#e07a7a]' : 'text-[#6d8294]'}`}>
                    {p.failed}
                  </td>
                  <td className="px-4 py-1.5 text-right text-[#9fb3bf]">{p.avgMs}ms</td>
                  <td className="px-4 py-1.5 text-right text-[#9fb3bf]">
                    {fmtTok(p.inputTokens)}/{fmtTok(p.outputTokens)}
                  </td>
                  <td className="px-4 py-1.5 text-right text-[#53d3e0]">{fmtMoney(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-4 text-xs text-[#6d8294]">暂无数据</div>
        )}
      </div>

      {/* 最近记录 */}
      <div className="rounded border border-[#232c35] bg-[#12181e]">
        <div className="px-4 py-2 border-b border-[#232c35] text-xs text-[#8b9aa7]">
          最近请求（最多 200 条，含被转移的失败尝试）
        </div>
        {records.length > 0 ? (
          <div className="max-h-80 overflow-y-auto">
            {records.map((r, i) => (
              <div
                key={`${r.ts}-${i}`}
                className="px-4 py-1.5 text-xs mono border-t border-[#1a2129] flex items-center gap-3"
              >
                <span className="text-[#6d8294] shrink-0">{fmtTime(r.ts)}</span>
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-[#5ec98b]' : 'bg-[#e07a7a]'}`} />
                <span className="text-[#d8dfe6] w-24 truncate">{r.provider ?? '(未指定)'}</span>
                <span className="text-[#8b9aa7] w-40 truncate">
                  {r.requestedModel ?? '-'} → {r.actualModel ?? '-'}
                </span>
                <span className="text-[#6d8294] w-14 text-right">{r.ms ?? '-'}ms</span>
                <span className="text-[#9fb3bf] w-28 text-right">
                  {(r.inputTokens ?? 0) > 0 || (r.outputTokens ?? 0) > 0
                    ? `${fmtTok(r.inputTokens ?? 0)}/${fmtTok(r.outputTokens ?? 0)}`
                    : '-'}
                </span>
                <span className="text-[#53d3e0] w-20 text-right">{fmtMoney(r.cost ?? 0)}</span>
                <span className="text-[#6d8294] w-10 text-right">{r.status ?? '-'}</span>
                {r.ok ? (
                  <span className="text-[#5ec98b]">OK</span>
                ) : (
                  <span className={FAIL_LABEL[r.failureKind ?? 'fatal'].cls}>
                    {FAIL_LABEL[r.failureKind ?? 'fatal'].label} {r.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-4 text-xs text-[#6d8294]">
            暂无请求记录。发一条对话或跑一次任务队列，这里就会出现每次上游尝试（成功/失败/被转移）。
          </div>
        )}
      </div>

      <p className="text-[11px] text-[#6d8294]">
        说明：token 由路由站从上游响应中捕获（流式取 message_delta / usage 帧）；
        金额按官方价目表估算——DeepSeek 区分工作日峰谷（9-12/14-18 为高峰），Kimi 按输入 20 / 输出 100 元每百万 token。
        未收录价目的模型（GLM/阶跃/方舟等）只统计 token 不计金额
        {stats && stats.total > 0 ? `；本期有 ${stats.tokenRecords}/${stats.total} 条请求抓到 token` : ''}。
      </p>
    </div>
  )
}