import { useState } from 'react'
import { PROTOCOL_SPECS, endpointUrl, normalizeBaseUrl } from '../shared/types'
import type { ConfigView, ProviderProtocol, ProviderView } from '../shared/preload-api'

interface Props {
  cfg: ConfigView | null
  onChange: () => void
}

interface TestState {
  running: boolean
  ok?: boolean
  message?: string
  models?: string[]
}

export default function SettingsPage({ cfg, onChange }: Props): React.JSX.Element {
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [newPv, setNewPv] = useState<{ id: string; name: string; baseUrl: string; protocol: ProviderProtocol }>({
    id: '',
    name: '',
    baseUrl: '',
    protocol: 'anthropic'
  })

  if (!cfg) return <div className="p-8 text-[#8b9aa7]">加载中…</div>

  const saveKey = async (id: string): Promise<void> => {
    const v = keys[id]
    if (v === undefined || v === '') return
    setBusyId(id)
    await window.workbench.setProviderKey(id, v)
    setKeys((p) => ({ ...p, [id]: '' }))
    setBusyId(null)
    onChange()
  }

  const test = async (id: string): Promise<void> => {
    setTests((p) => ({ ...p, [id]: { running: true } }))
    const r = await window.workbench.testProvider(id)
    setTests((p) => ({
      ...p,
      [id]: {
        running: false,
        ok: r.ok,
        message: r.ok ? `可用 · ${r.models?.length ?? 0} 个模型 · ${r.ms ?? 0}ms` : r.error ?? '失败',
        models: r.models
      }
    }))
  }

  const autoFill = async (id: string): Promise<void> => {
    setBusyId(id)
    const r = await window.workbench.autoFillModels(id)
    setBusyId(null)
    setTests((p) => ({
      ...p,
      [id]: {
        running: false,
        ok: r.ok,
        message: r.ok
          ? r.fromPreset
            ? `模型列表端点不可用（${r.error ?? '未知原因'}），已按官方预设模型名继续路由`
            : `已自动填入三档模型 · 共 ${r.models?.length ?? 0} 个`
          : '自动获取失败，请检查 Key 与 base url',
        models: r.models
      }
    }))
    onChange()
  }

  const toggle = async (pv: ProviderView, enabled: boolean): Promise<void> => {
    await window.workbench.updateProvider(pv.id, { enabled })
    onChange()
  }

  const setPriority = async (pv: ProviderView, priority: number): Promise<void> => {
    await window.workbench.updateProvider(pv.id, { priority })
    onChange()
  }

  const saveEdit = async (
    pv: ProviderView,
    patch: { baseUrl?: string; sonnet?: string; haiku?: string; opus?: string; protocol?: ProviderProtocol }
  ): Promise<void> => {
    await window.workbench.updateProvider(pv.id, {
      baseUrl: patch.baseUrl,
      protocol: patch.protocol,
      models: { opus: patch.opus, sonnet: patch.sonnet, haiku: patch.haiku }
    })
    setEditing(null)
    onChange()
  }

  /** 设为主用：优先级置 0（最小），排在降级链首位 */
  const setPrimary = async (pv: ProviderView): Promise<void> => {
    await window.workbench.updateProvider(pv.id, { priority: 0 })
    onChange()
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      <h2 className="text-lg font-semibold mb-1">模型路由站</h2>
      <p className="text-xs text-[#8b9aa7] mb-5">
        填入 API Key 即可入路由；按优先级自动故障转移。Key 经系统加密存储，不以明文返回界面。
      </p>

      <div className="mb-5 rounded border border-[#232c35] bg-[#151b21] px-4 py-3 text-sm">
        <div>
          当前默认档模型：
          <span className="mono text-[#7ddceb] font-medium">{cfg.defaultModelNow || '（未配置）'}</span>
          {cfg.defaultProviderNow ? (
            <span>
              {' '}
              · 来自 <span className="mono">{cfg.defaultProviderNow}</span>
            </span>
          ) : (
            ''
          )}
        </div>
        <div className="text-xs text-[#8b9aa7] mt-1">
          可用供应商 {cfg.activeCount} 家 · 降级链 <span className="mono">wb-sonnet → wb-haiku</span> · 档位降级
          <span className="mono"> opus → sonnet → haiku</span>
        </div>
        {cfg.needsModelDiscovery && (
          <div className="text-xs text-[#e0a34c] mt-2">
            有供应商已填 Key 但未取到模型名，点「自动获取模型」重试（否则该供应商不会参与路由）
          </div>
        )}
      </div>

      <div className="space-y-3">
        {cfg.providers
          .slice()
          .sort((a, b) => a.priority - b.priority)
          .map((pv) => {
            const t = tests[pv.id]
            return (
              <div key={pv.id} className="rounded border border-[#232c35] bg-[#151b21] px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-medium">{pv.name}</span>
                  <span className="mono text-xs text-[#6d8294]">{pv.id}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      pv.hasKey ? 'bg-[#143524] text-[#7fd39a]' : 'bg-[#1a2129] text-[#8b9aa7]'
                    }`}
                  >
                    {pv.hasKey ? '已填 Key' : '未填 Key'}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      pv.protocol === 'openai'
                        ? 'bg-[#3a2c14] text-[#e0a34c]'
                        : 'bg-[#1a2129] text-[#9fb3bf]'
                    }`}
                    title={PROTOCOL_SPECS[pv.protocol].hint}
                  >
                    {PROTOCOL_SPECS[pv.protocol].label}
                  </span>
                  <span className="mono text-xs text-[#6d8294]">优先级 {pv.priority}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      className="text-xs px-2 py-1 rounded bg-[#173038] text-[#7ddceb] border border-[#2f6f7a]/50 hover:bg-[#1d3d47]"
                      onClick={() => void setPrimary(pv)}
                      disabled={pv.priority === 0}
                    >
                      {pv.priority === 0 ? '主用中' : '设为主用'}
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() => void setPriority(pv, Math.max(1, pv.priority - 1))}
                    >
                      提权
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() => void toggle(pv, !pv.enabled)}
                    >
                      {pv.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() => void autoFill(pv.id)}
                    >
                      自动获取模型
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() => setEditing(editing === pv.id ? null : pv.id)}
                    >
                      编辑
                    </button>
                  </div>
                </div>

                <div className="mono mt-2 text-xs text-[#6d8294] break-all">{pv.baseUrl}</div>
                <div className="mt-0.5 text-xs text-[#8b9aa7]">
                  实际请求 <span className="mono text-[#9fb3bf]">POST {pv.messagesEndpoint}</span>
                  {pv.protocol === 'openai' && (
                    <span className="ml-2 text-[#e0a34c]">（路由站做 Anthropic↔OpenAI 转换，含工具调用）</span>
                  )}
                </div>
                {pv.baseUrlWarning && <div className="mt-0.5 text-xs text-[#e0a34c]">{pv.baseUrlWarning}</div>}
                <div className="mt-1 text-xs text-[#6d8294]">
                  sonnet <span className="mono text-[#9fb3bf]">{pv.models.sonnet || '—'}</span> · opus{' '}
                  <span className="mono text-[#9fb3bf]">{pv.models.opus || '—'}</span> · haiku{' '}
                  <span className="mono text-[#9fb3bf]">{pv.models.haiku || '—'}</span>
                </div>

                {editing === pv.id && (
                  <EditForm pv={pv} onSave={(p) => void saveEdit(pv, p)} onCancel={() => setEditing(null)} />
                )}

                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="password"
                    className="flex-1 bg-[#12181e] border border-[#232c35] rounded px-3 py-1.5 text-sm placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
                    placeholder={pv.hasKey ? '已保存，留空不修改；输入则覆盖' : '粘贴 API Key'}
                    value={keys[pv.id] ?? ''}
                    onChange={(e) => setKeys((p) => ({ ...p, [pv.id]: e.target.value }))}
                  />
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
                    disabled={!keys[pv.id] || busyId === pv.id}
                    onClick={() => void saveKey(pv.id)}
                  >
                    保存
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] disabled:opacity-40"
                    disabled={!pv.hasKey || t?.running}
                    onClick={() => void test(pv.id)}
                  >
                    {t?.running ? '测试中…' : '测试连接'}
                  </button>
                </div>

                {t && !t.running && (
                  <div className={`mono mt-2 text-xs ${t.ok ? 'text-[#7fd39a]' : 'text-[#e07a7a]'}`}>
                    {t.message}
                    {t.ok && t.models && t.models.length > 0 && (
                      <div className="text-[#6d8294] mt-1 break-all">前 20 个：{t.models.slice(0, 20).join(', ')}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
      </div>

      <div className="mt-6 rounded border border-[#232c35] bg-[#151b21] px-4 py-3">
        <div className="font-medium mb-2 text-sm">新增供应商（第 6 家及以后）</div>
        <div className="flex gap-2">
          <input
            className="w-32 bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 text-sm placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
            placeholder="id（英文）"
            value={newPv.id}
            onChange={(e) => setNewPv((p) => ({ ...p, id: e.target.value }))}
          />
          <input
            className="w-40 bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 text-sm placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
            placeholder="显示名"
            value={newPv.name}
            onChange={(e) => setNewPv((p) => ({ ...p, name: e.target.value }))}
          />
          <select
            className="w-36 bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#2f6f7a]"
            value={newPv.protocol}
            onChange={(e) => setNewPv((p) => ({ ...p, protocol: e.target.value as ProviderProtocol }))}
            title="上游端点协议类型"
          >
            <option value="anthropic">Anthropic 兼容</option>
            <option value="openai">OpenAI 兼容</option>
          </select>
          <input
            className="flex-1 bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 text-sm placeholder-[#4a5763] focus:outline-none focus:border-[#2f6f7a]"
            placeholder={
              newPv.protocol === 'openai' ? 'https://…/v1（OpenAI 兼容根地址）' : 'https://…（Anthropic 兼容前缀，不带 /v1）'
            }
            value={newPv.baseUrl}
            onChange={(e) => setNewPv((p) => ({ ...p, baseUrl: e.target.value }))}
          />
          <button
            className="px-3 py-1.5 text-sm rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium disabled:opacity-40"
            disabled={!newPv.id || !newPv.baseUrl}
            onClick={async () => {
              const r = await window.workbench.addProvider(newPv)
              if (r.ok) setNewPv({ id: '', name: '', baseUrl: '', protocol: 'anthropic' })
              onChange()
            }}
          >
            新增
          </button>
        </div>
        <div className="mt-1 text-xs text-[#8b9aa7]">{PROTOCOL_SPECS[newPv.protocol].hint}</div>
        {newPv.baseUrl && (
          <div className="mt-1 text-xs text-[#8b9aa7]">
            实际请求 <span className="mono text-[#9fb3bf]">POST {endpointPreview(newPv.baseUrl, newPv.protocol)}</span>
            {normalizeNeeded(newPv.baseUrl, newPv.protocol) && (
              <span className="ml-1 text-[#e0a34c]">（已自动去掉多余后缀）</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 编辑框实时预览：保存后会打到哪个地址 */
function endpointPreview(baseUrl: string, protocol: ProviderProtocol): string {
  return endpointUrl(baseUrl, protocol, 'messages')
}

function normalizeNeeded(baseUrl: string, protocol: ProviderProtocol): boolean {
  return normalizeBaseUrl(baseUrl, protocol) !== baseUrl.trim().replace(/\/+$/, '')
}

interface EditFormProps {
  pv: ProviderView
  onSave: (p: {
    baseUrl?: string
    sonnet?: string
    haiku?: string
    opus?: string
    protocol?: ProviderProtocol
  }) => void
  onCancel: () => void
}

function EditForm({ pv, onSave, onCancel }: EditFormProps): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(pv.baseUrl)
  const [protocol, setProtocol] = useState<ProviderProtocol>(pv.protocol)
  const [sonnet, setSonnet] = useState(pv.models.sonnet ?? '')
  const [opus, setOpus] = useState(pv.models.opus ?? '')
  const [haiku, setHaiku] = useState(pv.models.haiku ?? '')
  const warning = ((): string | null => {
    const u = baseUrl.trim()
    if (!u) return 'base url 不能为空'
    if (!/^https?:\/\//i.test(u)) return '必须以 http:// 或 https:// 开头'
    try {
      new URL(u)
    } catch {
      return 'URL 格式不合法'
    }
    return null
  })()

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
      <div className="col-span-2 flex gap-2">
        <select
          className="w-40 bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 focus:outline-none focus:border-[#2f6f7a]"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}
          title="上游端点协议类型"
        >
          <option value="anthropic">Anthropic 兼容</option>
          <option value="openai">OpenAI 兼容</option>
        </select>
        <div className="flex-1 text-xs text-[#8b9aa7] self-center">{PROTOCOL_SPECS[protocol].hint}</div>
      </div>
      <input
        className="mono col-span-2 bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 focus:outline-none focus:border-[#2f6f7a]"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="base url"
      />
      <div className="col-span-2 text-xs">
        {warning ? (
          <span className="text-[#e07a7a]">{warning}</span>
        ) : (
          <span className="text-[#8b9aa7]">
            保存后实际请求：<span className="mono text-[#9fb3bf]">POST {endpointPreview(baseUrl, protocol)}</span>
            {normalizeNeeded(baseUrl, protocol) && (
              <span className="ml-1 text-[#e0a34c]">（已自动去掉多余后缀）</span>
            )}
          </span>
        )}
      </div>
      <input
        className="mono bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 focus:outline-none focus:border-[#2f6f7a]"
        value={sonnet}
        onChange={(e) => setSonnet(e.target.value)}
        placeholder="sonnet 档模型名（默认档）"
      />
      <input
        className="mono bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 focus:outline-none focus:border-[#2f6f7a]"
        value={opus}
        onChange={(e) => setOpus(e.target.value)}
        placeholder="opus 档模型名"
      />
      <input
        className="mono bg-[#12181e] border border-[#232c35] rounded px-2 py-1.5 focus:outline-none focus:border-[#2f6f7a]"
        value={haiku}
        onChange={(e) => setHaiku(e.target.value)}
        placeholder="haiku 档模型名"
      />
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded bg-[#1e93a3] hover:bg-[#26aebf] text-[#06282c] font-medium"
          onClick={() => onSave({ baseUrl, protocol, sonnet, opus, haiku })}
        >
          保存
        </button>
        <button
          className="px-3 py-1.5 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  )
}
