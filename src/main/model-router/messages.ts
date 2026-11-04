/**
 * 直连本地路由站的「一次请求换一段文本」通道。
 *
 * 背景：任务队列执行器（M2）与速聊条（M6 quickChatAsk）都要「纯文本产出」能力，
 * 且都不能起 claude CLI（冷启动 10s+ 秒开场景不可接受）。两者共用本模块，
 * 保证端点、鉴权、故障转移与熔断行为完全一致——差异只在入参与超时。
 *
 * 依赖策略：fetch 取自 globalThis（Node 18+ / Electron 均内置），
 * 单测通过 options.fetchImpl 注入，不引入任何新依赖。
 */
import { TIER_ALIASES, type ModelTier, type ProviderConfig } from '../../shared/types'

export interface RouterEndpointInput {
  baseUrl: string
  localToken: string
}

export interface RouterTextOptions {
  /** 用户消息正文 */
  prompt: string
  /** 档位，缺省由调用方收敛为 sonnet */
  tier: ModelTier
  maxTokens?: number
  signal?: AbortSignal
  /** 单测注入；缺省 globalThis.fetch */
  fetchImpl?: (url: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
}

/** 路由站 /v1/messages 的响应体形状（Anthropic content[] 为主，OpenAI choices 兜底） */
export interface MessageResponse {
  content?: Array<{ type?: string; text?: string }>
  choices?: Array<{ message?: { content?: string } }>
}

/**
 * 从响应体里取纯文本。
 * 先把 content[] 中 type==='text' 的块拼起来；拼不出东西再兜底 OpenAI 形态的
 * choices[0].message.content（正常情况下路由站已翻译，这里只是防御）。
 */
export function extractText(json: MessageResponse): string {
  const blocks = Array.isArray(json.content) ? json.content : []
  const out = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  if (out.trim()) return out
  const choiceText = json.choices?.[0]?.message?.content
  if (typeof choiceText === 'string' && choiceText.trim()) return choiceText
  return ''
}

/** 把上游非 2xx 响应体翻成人话（取 error.message，取不到就原文截断） */
export function describeHttpError(status: number, body: string): string {
  let detail: string = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    detail = parsed?.error?.message ?? body
  } catch {
    /* 非 JSON 时保留原文 */
  }
  return `上游 ${status}：${String(detail).slice(0, 400)}`
}

/**
 * 由响应里的**真实模型名**反查本次实际承接的供应商显示名。
 *
 * 路由站自己不在响应里带供应商信息（server.ts 不改变 upstream 结构），
 * 这里用「模型名 ∈ 某供应商的三档映射/defaultModel」反推，够 UI 展示"谁答的"用，
 * 且不需要动 router 的任何一行请求处理代码（故障转移/流式/协议转换全不受影响）。
 * 多个供应商同名时按传入顺序取第一个——调用方请传已按优先级排好的列表。
 */
export function findProviderByModel(
  providers: Array<Pick<ProviderConfig, 'name' | 'models' | 'defaultModel'>>,
  model?: string
): string | undefined {
  const target = (model ?? '').trim()
  if (!target) return undefined
  const lower = target.toLowerCase()
  for (const pv of providers) {
    const candidates = [pv.defaultModel, pv.models.opus, pv.models.sonnet, pv.models.haiku]
    for (const c of candidates) {
      if (c && c.trim().toLowerCase() === lower) return pv.name
    }
  }
  return undefined
}

export interface RouterTextResult {
  text: string
  /** 上游返回的真实模型名（路由站把虚拟别名换掉之后的值），用于反查实际供应商 */
  model?: string
}

export async function callRouterTextDetailed(
  router: RouterEndpointInput,
  opts: RouterTextOptions
): Promise<RouterTextResult> {
  const impl =
    opts.fetchImpl ??
    (globalThis.fetch as unknown as NonNullable<RouterTextOptions['fetchImpl']>)
  const token = router.localToken
  const res = await impl(`${router.baseUrl}/v1/messages`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      model: TIER_ALIASES[opts.tier],
      max_tokens: opts.maxTokens ?? 4096,
      stream: false,
      messages: [{ role: 'user', content: opts.prompt }]
    })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(describeHttpError(res.status, text))
  let json: MessageResponse & { model?: unknown }
  try {
    json = JSON.parse(text) as MessageResponse & { model?: unknown }
  } catch {
    throw new Error('上游返回非 JSON 响应')
  }
  const out = extractText(json)
  if (!out.trim()) throw new Error('上游返回空文本（可能不支持纯文本请求）')
  return { text: out, model: typeof json.model === 'string' ? json.model : undefined }
}

/**
 * 向本地路由站发一次 stream:false 的 /v1/messages 请求并返回纯文本。
 *
 * 失败一律 throw（任务执行器据此重试/判失败，速聊据此回 ok:false），
 * 不在本层吞异常——吞异常处理放在调用方，避免两处语义不一致。
 */
export async function callRouterText(
  router: RouterEndpointInput,
  opts: RouterTextOptions
): Promise<string> {
  return (await callRouterTextDetailed(router, opts)).text
}
