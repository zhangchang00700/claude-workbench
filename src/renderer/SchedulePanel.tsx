import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelTier, ScheduleRecord, TemplateRecord, TemplateVars } from '../shared/preload-api'
import { buildVarRows, extractVariables, missingVariables } from '../shared/template-vars'

const TIER_LABEL: Record<ModelTier, string> = {
  opus: '高（opus）',
  sonnet: '中（sonnet·默认）',
  haiku: '低（haiku）'
}

interface FormState {
  id: string | null
  name: string
  enabled: boolean
  kind: ScheduleRecord['kind']
  intervalMinutes: number
  dailyTime: string
  source: ScheduleRecord['source']
  templateId: string
  vars: Record<string, string>
  prompt: string
  tier: ModelTier
  maxRetries: number
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  enabled: true,
  kind: 'interval',
  intervalMinutes: 60,
  dailyTime: '09:00',
  source: 'prompt',
  templateId: '',
  vars: {},
  prompt: '',
  tier: 'sonnet',
  maxRetries: 1
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function freqLabel(s: ScheduleRecord): string {
  if (s.kind === 'daily') return `每天 ${s.dailyTime}`
  const m = s.intervalMinutes
  if (m % 1440 === 0) return `每 ${m / 1440} 天`
  if (m % 60 === 0) return `每 ${m / 60} 小时`
  return `每 ${m} 分钟`
}

const STATUS_META: Record<ScheduleRecord['lastStatus'], { label: string; cls: string }> = {
  never: { label: '未运行', cls: 'text-[#6d8294]' },
  ok: { label: '正常', cls: 'text-[#5ec98b]' },
  error: { label: '失败', cls: 'text-[#e07a7a]' }
}

export default function SchedulePanel(): React.JSX.Element {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [toast, setToast] = useState('')

  const refresh = useCallback(() => {
    window.workbench
      .listSchedules()
      .then((list) => setSchedules((list as ScheduleRecord[]) ?? []))
      .catch(() => setSchedules([]))
    window.workbench
      .listTemplates()
      .then((list) => setTemplates((list as TemplateRecord[]) ?? []))
      .catch(() => setTemplates([]))
  }, [])

  useEffect(refresh, [refresh])

  useEffect(() => {
    return window.workbench.onStreamEvent((e) => {
      if (e.domain !== 'schedules') return
      const ev = e.payload as { type: string; all?: ScheduleRecord[] }
      if (ev.all) setSchedules(ev.all)
    })
  }, [])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2500)
  }, [])

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === form.templateId) ?? null,
    [templates, form.templateId]
  )
  const tplVars = useMemo(
    () => (selectedTemplate ? extractVariables(selectedTemplate.prompt) : []),
    [selectedTemplate]
  )
  const tplRows = useMemo(() => buildVarRows(tplVars, form.vars), [tplVars, form.vars])
  const tplMissing = useMemo(
    () => (selectedTemplate ? missingVariables(selectedTemplate.prompt, tplRows[0] ?? {}) : []),
    [selectedTemplate, tplRows]
  )

  const select = (s: ScheduleRecord): void => {
    setForm({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      kind: s.kind,
      intervalMinutes: s.intervalMinutes,
      dailyTime: s.dailyTime,
      source: s.source,
      templateId: s.templateId ?? '',
      vars: {},
      prompt: s.prompt ?? '',
      tier: s.tier,
      maxRetries: s.maxRetries
    })
  }

  const create = (): void => setForm(EMPTY_FORM)

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      notify('计划名称不能为空')
      return
    }
    if (form.source === 'prompt' && !form.prompt.trim()) {
      notify('prompt 内容不能为空')
      return
    }
    if (form.source === 'template' && !form.templateId) {
      notify('请选择模板')
      return
    }
    const saved = (await window.workbench.saveSchedule({
      id: form.id ?? undefined,
      name: form.name,
      enabled: form.enabled,
      kind: form.kind,
      intervalMinutes: form.intervalMinutes,
      dailyTime: form.dailyTime,
      source: form.source,
      templateId: form.source === 'template' ? form.templateId : undefined,
      vars: form.source === 'template' ? (tplRows as TemplateVars[]) : undefined,
      prompt: form.source === 'prompt' ? form.prompt : undefined,
      tier: form.tier,
      maxRetries: form.maxRetries
    })) as ScheduleRecord
    setForm((f) => ({ ...f, id: saved.id }))
    notify('计划已保存')
  }

  const remove = async (): Promise<void> => {
    if (!form.id) return
    if (!confirm(`删除计划「${form.name}」？`)) return
    await window.workbench.removeSchedule(form.id)
    create()
    notify('计划已删除')
  }

  const runNow = async (id: string): Promise<void> => {
    const r = await window.workbench.runScheduleNow(id)
    notify(r.ok ? '已立即执行，任务进入队列' : (r.error ?? '执行失败'))
  }

  return (
    <div className="flex-1 flex min-w-0">
      {/* 左：计划列表 */}
      <div className="w-72 shrink-0 border-r border-[#232c35] flex flex-col">
        <div className="px-4 py-3 border-b border-[#232c35] flex items-center gap-2">
          <span className="text-sm font-semibold text-[#d8dfe6]">计划</span>
          <button
            className="ml-auto text-xs px-2 py-1 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c]"
            onClick={create}
          >
            + 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {schedules.length === 0 && (
            <p className="text-xs text-[#6d8294] px-2 py-3">
              还没有计划。定时把模板或 prompt 批量入队，到点自动执行（复用任务队列的故障转移与并发限流）。
            </p>
          )}
          {schedules.map((s) => (
            <div
              key={s.id}
              className={`rounded px-3 py-2 cursor-pointer ${
                form.id === s.id ? 'bg-[#1a2730] shadow-[inset_2px_0_0_#53d3e0]' : 'hover:bg-[#151b21]'
              }`}
              onClick={() => select(s)}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-[#d8dfe6] truncate flex-1">{s.name}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border ${
                    s.enabled ? 'text-[#5ec98b] border-[#2f5a45]' : 'text-[#6d8294] border-[#2a3640]'
                  }`}
                >
                  {s.enabled ? '启用' : '停用'}
                </span>
              </div>
              <div className="mono text-[10px] text-[#6d8294] mt-0.5">
                {freqLabel(s)} · 下次 {fmtTs(s.nextRunAt)}
              </div>
              <div className={`text-[10px] mt-0.5 ${STATUS_META[s.lastStatus].cls}`}>
                {STATUS_META[s.lastStatus].label}
                {s.lastStatus === 'error' && s.lastError ? `：${s.lastError}` : ''}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 右：编辑器 */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-5 border-b border-[#232c35] space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <input
              className="bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
              placeholder="计划名称（如：每日竞品早报）"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <select
              className="mono bg-[#151b21] border border-[#232c35] rounded px-2 py-2 text-sm text-[#d8dfe6]"
              value={form.tier}
              onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value as ModelTier }))}
            >
              <option value="opus">{TIER_LABEL.opus}</option>
              <option value="sonnet">{TIER_LABEL.sonnet}</option>
              <option value="haiku">{TIER_LABEL.haiku}</option>
            </select>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-[#8b9aa7]">触发</span>
            <select
              className="mono bg-[#151b21] border border-[#232c35] rounded px-2 py-1.5 text-sm text-[#d8dfe6]"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ScheduleRecord['kind'] }))}
            >
              <option value="interval">按间隔</option>
              <option value="daily">每天定时</option>
            </select>
            {form.kind === 'interval' ? (
              <label className="flex items-center gap-2 text-xs text-[#8b9aa7]">
                每
                <input
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, intervalMinutes: Math.max(1, Number(e.target.value) || 1) }))
                  }
                  className="mono w-20 bg-[#151b21] border border-[#232c35] rounded px-2 py-1 text-[#d8dfe6]"
                />
                分钟
              </label>
            ) : (
              <input
                className="mono bg-[#151b21] border border-[#232c35] rounded px-2 py-1.5 text-sm text-[#d8dfe6]"
                value={form.dailyTime}
                onChange={(e) => setForm((f) => ({ ...f, dailyTime: e.target.value }))}
                placeholder="HH:mm"
              />
            )}
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-[#8b9aa7]">内容</span>
            <select
              className="mono bg-[#151b21] border border-[#232c35] rounded px-2 py-1.5 text-sm text-[#d8dfe6]"
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as ScheduleRecord['source'] }))}
            >
              <option value="prompt">固定 prompt</option>
              <option value="template">模板 + 变量</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-[#8b9aa7]">
              重试次数
              <input
                type="number"
                min={0}
                max={5}
                value={form.maxRetries}
                onChange={(e) => setForm((f) => ({ ...f, maxRetries: Math.max(0, Math.min(5, Number(e.target.value) || 0)) }))}
                className="mono w-16 bg-[#151b21] border border-[#232c35] rounded px-2 py-1 text-[#d8dfe6]"
              />
            </label>
          </div>

          {form.source === 'template' ? (
            <div className="space-y-3">
              <select
                className="w-full mono bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4]"
                value={form.templateId}
                onChange={(e) => {
                  setForm((f) => ({ ...f, templateId: e.target.value, vars: {} }))
                }}
              >
                <option value="">选择模板…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {templates.length === 0 && (
                <p className="text-xs text-[#e0a34c]">还没有模板，请先到「模板流水线」创建。</p>
              )}
              {selectedTemplate && tplVars.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {tplVars.map((v) => (
                    <div key={v}>
                      <div className="mono text-xs text-[#53d3e0] mb-1">{`{{${v}}}`}</div>
                      <textarea
                        className="w-full h-20 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
                        placeholder={`每行一个 ${v} 取值`}
                        value={form.vars[v] ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, vars: { ...f.vars, [v]: e.target.value } }))}
                      />
                    </div>
                  ))}
                </div>
              )}
              {selectedTemplate && (
                <p className="text-xs text-[#6d8294]">
                  每次执行入队 {tplRows.length} 条任务
                  {tplMissing.length > 0 && <span className="text-[#e0a34c]">（有变量未填：{tplMissing.join('、')}）</span>}
                </p>
              )}
            </div>
          ) : (
            <textarea
              className="w-full h-24 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
              placeholder="到点后入队的 prompt（单条任务）"
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              className="px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
              disabled={!form.name.trim()}
              onClick={() => void save()}
            >
              保存计划
            </button>
            {form.id && (
              <>
                <button
                  className="px-3 py-2 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                  onClick={() => void runNow(form.id as string)}
                >
                  立即执行
                </button>
                <button
                  className="px-3 py-2 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] hover:text-[#e07a7a]"
                  onClick={() => void remove()}
                >
                  删除
                </button>
                <label className="flex items-center gap-2 text-xs text-[#8b9aa7] cursor-pointer ml-auto">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                    className="accent-[#1e93a3]"
                  />
                  启用（取消勾选后保存即停用）
                </label>
              </>
            )}
          </div>
        </div>

        <div className="px-8 py-4 text-xs text-[#6d8294] space-y-1">
          <p>调度器每 30 秒扫描一次；到点把任务入队后，需在「任务队列」点开始执行（或已有执行中的队列自动消化）。</p>
          <p>执行结果记录在左侧列表（上次运行时间与状态）；失败的下一步运行仍会按频率触发。</p>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded bg-[#1a2730] border border-[#2f6f7a] text-xs text-[#9fb3bf]">
          {toast}
        </div>
      )}
    </div>
  )
}
