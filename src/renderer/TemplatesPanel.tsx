import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelTier, TemplateRecord } from '../shared/preload-api'
import { buildVarRows, extractVariables, missingVariables, renderTemplate } from '../shared/template-vars'

const TIER_LABEL: Record<ModelTier, string> = {
  opus: '高（opus）',
  sonnet: '中（sonnet·默认）',
  haiku: '低（haiku）'
}

interface FormState {
  id: string | null
  name: string
  description: string
  prompt: string
  tier: ModelTier
  maxRetries: number
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  description: '',
  prompt: '',
  tier: 'sonnet',
  maxRetries: 1
}

export default function TemplatesPanel(): React.JSX.Element {
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [values, setValues] = useState<Record<string, string>>({})
  const [toast, setToast] = useState('')

  const refresh = useCallback(() => {
    window.workbench
      .listTemplates()
      .then((list) => setTemplates((list as TemplateRecord[]) ?? []))
      .catch(() => setTemplates([]))
  }, [])

  useEffect(refresh, [refresh])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2500)
  }, [])

  const vars = useMemo(() => extractVariables(form.prompt), [form.prompt])
  const rows = useMemo(() => buildVarRows(vars, values), [vars, values])
  const previewRow = rows[0] ?? {}
  const missing = useMemo(() => missingVariables(form.prompt, previewRow), [form.prompt, previewRow])
  const preview = renderTemplate(form.prompt, previewRow)

  const select = (t: TemplateRecord): void => {
    setForm({
      id: t.id,
      name: t.name,
      description: t.description,
      prompt: t.prompt,
      tier: t.tier,
      maxRetries: t.maxRetries
    })
    setValues({})
  }

  const create = (): void => {
    setForm(EMPTY_FORM)
    setValues({})
  }

  const save = async (): Promise<void> => {
    if (!form.prompt.trim()) {
      notify('模板内容不能为空')
      return
    }
    const saved = (await window.workbench.saveTemplate({
      id: form.id ?? undefined,
      name: form.name,
      description: form.description,
      prompt: form.prompt,
      tier: form.tier,
      maxRetries: form.maxRetries
    })) as TemplateRecord
    setForm((f) => ({ ...f, id: saved.id }))
    refresh()
    notify('模板已保存')
  }

  const remove = async (): Promise<void> => {
    if (!form.id) return
    if (!confirm(`删除模板「${form.name || '未命名模板'}」？`)) return
    await window.workbench.removeTemplate(form.id)
    create()
    refresh()
    notify('模板已删除')
  }

  const enqueue = async (): Promise<void> => {
    if (!form.id) {
      notify('请先保存模板再入队')
      return
    }
    if (missing.length) {
      notify(`还有变量未填：${missing.join('、')}`)
      return
    }
    const res = await window.workbench.enqueueTemplate(form.id, rows)
    if (!res.ok) {
      notify(res.error ?? '入队失败')
      return
    }
    notify(`已入队 ${res.count} 条任务，去「任务队列」点开始执行`)
  }

  return (
    <div className="flex-1 flex min-w-0">
      {/* 左：模板列表 */}
      <div className="w-64 shrink-0 border-r border-[#232c35] flex flex-col">
        <div className="px-4 py-3 border-b border-[#232c35] flex items-center gap-2">
          <span className="text-sm font-semibold text-[#d8dfe6]">模板</span>
          <button
            className="ml-auto text-xs px-2 py-1 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c]"
            onClick={create}
          >
            + 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {templates.length === 0 && (
            <p className="text-xs text-[#6d8294] px-2 py-3">还没有模板。在右侧写好 prompt，用 {'{{变量名}}'} 占位，保存后即可批量入队。</p>
          )}
          {templates.map((t) => (
            <button
              key={t.id}
              className={`w-full text-left px-3 py-2 rounded text-sm truncate ${
                form.id === t.id
                  ? 'bg-[#1a2730] text-white shadow-[inset_2px_0_0_#53d3e0]'
                  : 'text-[#8b9aa7] hover:bg-[#151b21]'
              }`}
              onClick={() => select(t)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* 右：编辑器 + 变量区 */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-5 border-b border-[#232c35] space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <input
              className="bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
              placeholder="模板名称（如：周报生成器）"
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
          <input
            className="w-full bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
            placeholder="模板说明（可选）"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <textarea
            className="w-full h-32 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
            placeholder={'模板 prompt，用 {{变量名}} 占位。例如：汇总 {{week}} 的进展，重点关注 {{focus}}'}
            value={form.prompt}
            onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
          />
          <div className="flex items-center gap-4 flex-wrap">
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
            <button
              className="px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
              disabled={!form.prompt.trim()}
              onClick={() => void save()}
            >
              保存模板
            </button>
            {form.id && (
              <button
                className="px-3 py-2 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] hover:text-[#e07a7a]"
                onClick={() => void remove()}
              >
                删除
              </button>
            )}
            <span className="mono text-[11px] text-[#6d8294]">
              {form.id ? `已保存 · ${vars.length} 个变量` : '未保存的新模板'}
            </span>
          </div>
        </div>

        {/* 变量填写区 */}
        {vars.length > 0 && (
          <div className="px-8 py-5 border-b border-[#232c35]">
            <div className="text-sm font-semibold text-[#d8dfe6] mb-1">变量填充</div>
            <p className="text-xs text-[#6d8294] mb-3">
              每个变量一行一个取值：N 行 = 入队 N 条任务；只有一个取值时所有任务共用。
            </p>
            <div className="grid grid-cols-2 gap-3">
              {vars.map((v) => (
                <div key={v}>
                  <div className="mono text-xs text-[#53d3e0] mb-1">{`{{${v}}}`}</div>
                  <textarea
                    className="w-full h-20 resize-none bg-[#12181e] border border-[#232c35] rounded px-3 py-2 text-sm text-[#e8eef4] placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
                    placeholder={`每行一个 ${v} 取值`}
                    value={values[v] ?? ''}
                    onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-4 flex-wrap">
              <button
                className="px-4 py-2 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
                disabled={!form.id || missing.length > 0}
                onClick={() => void enqueue()}
              >
                入队 {rows.length} 条任务
              </button>
              {missing.length > 0 && (
                <span className="text-xs text-[#e0a34c]">未填变量：{missing.join('、')}</span>
              )}
            </div>
          </div>
        )}

        {/* 渲染预览 */}
        {form.prompt.trim() && (
          <div className="px-8 py-5">
            <div className="text-sm font-semibold text-[#d8dfe6] mb-2">渲染预览（第一条）</div>
            <pre className="whitespace-pre-wrap break-all bg-[#0c1116] border border-[#232c35] rounded px-3 py-2 text-xs text-[#cdd8e0] max-h-48 overflow-y-auto">
              {preview}
            </pre>
          </div>
        )}
      </div>

      {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded bg-[#1a2730] border border-[#2f6f7a] text-xs text-[#9fb3bf]">{toast}</div>}
    </div>
  )
}
