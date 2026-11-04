/**
 * 上游失败判定：决定「换下一家」还是「把错误原样透传给 CLI」。
 *
 * 供应商的失败信号有四类，只看状态码会漏掉一半：
 * 1. 状态码 —— 429/5xx 换；400/404 说明请求本身有问题，换了也白换
 * 2. 厂商业务错误码 —— 错误体里的 code/type 字段（智谱 GLM 用数字码，阶跃用标识串，
 *    方舟用类型串），200 + SSE error 帧里没有状态码，业务码是唯一精确信号；
 *    且不少厂商文案带 ${field} 模板变量，纯文本匹配不可靠
 * 3. 错误体文本 —— 额度/配额类多数厂商回 402 或 400（智谱/DeepSeek/Kimi/火山都这样），
 *    光看码会把「欠费」误判成「请求错误」，于是永远卡在第一家
 * 4. 流式首帧 —— HTTP 200 之后 SSE 第一个事件就是 error（overloaded / rate_limit / 欠费），
 *    这是国产厂商最常见的过载表现，不探测就永远不会转移
 */

/** 状态码级可重试：限流 + 服务端错误 */
export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 522, 524, 529])

/**
 * 厂商业务错误码表（按 providerId 精确生效，别家的码/串一律不猜，走文本模式）。
 *
 * 收录原则（与文本策略一致）：
 * - 额度/欠费/套餐/限额/限流过载/服务端 → 换下一家
 * - 身份/Key/参数/模型名/内容安全 → 不换，透传原文让用户改配置
 *
 * 出处（2026-10-17 逐家核对官方文档）：
 * - glm：https://docs.bigmodel.cn/cn/api/api-code.md
 * - stepfun：https://platform.stepfun.com/docs/zh/api-reference/error-codes
 * - ark：https://www.volcengine.com/docs/82379/1848593（突发流量错误码）
 */
const PROVIDER_BUSINESS_CODES: Record<string, Record<string, FailureVerdict>> = {
  glm: {
    // —— 身份类：Key/令牌问题，换供应商治不好本家配置，不转移
    '1000': { retry: false, reason: 'auth_failed' },
    '1001': { retry: false, reason: 'auth_failed' },
    '1003': { retry: false, reason: 'auth_expired' },
    '1005': { retry: false, reason: 'auth_2fa' },
    // —— 额度/欠费/套餐/限额：这家给不了服务，换
    '1113': { retry: true, reason: 'quota_exhausted' },
    '1308': { retry: true, reason: 'quota_exhausted' },
    '1309': { retry: true, reason: 'payment_required' },
    '1310': { retry: true, reason: 'quota_exhausted' },
    '1311': { retry: true, reason: 'quota_exhausted' },
    '1314': { retry: true, reason: 'payment_required' },
    '1316': { retry: true, reason: 'quota_exhausted' },
    '1317': { retry: true, reason: 'quota_exhausted' },
    '1318': { retry: true, reason: 'quota_exhausted' },
    '1319': { retry: true, reason: 'quota_exhausted' },
    '1320': { retry: true, reason: 'quota_exhausted' },
    '1321': { retry: true, reason: 'quota_exhausted' },
    // —— 限流/过载/公平使用限制：暂时的，换一家可能就通
    '1302': { retry: true, reason: 'overloaded' },
    '1305': { retry: true, reason: 'overloaded' },
    '1313': { retry: true, reason: 'overloaded' },
    // —— 服务端：换
    '1200': { retry: true, reason: 'http_500' },
    '1230': { retry: true, reason: 'http_500' },
    '1234': { retry: true, reason: 'http_500' },
    // —— Key 类型/权限错（1315：Key 仅限企业编程套餐；1220：无权访问该 API）：配置问题，不换
    '1220': { retry: false, reason: 'client_fault' },
    '1315': { retry: false, reason: 'client_fault' },
    // —— 模型/API 不存在：与既有「400 + model not found 不转移」判定一致
    '1211': { retry: false, reason: 'model_not_found' },
    '1212': { retry: false, reason: 'model_not_found' },
    '1221': { retry: false, reason: 'model_not_found' },
    '1222': { retry: false, reason: 'model_not_found' },
    // —— 参数/内容：请求本身的问题，换一家同样拒
    '1210': { retry: false, reason: 'client_fault' },
    '1213': { retry: false, reason: 'client_fault' },
    '1214': { retry: false, reason: 'client_fault' },
    '1215': { retry: false, reason: 'client_fault' },
    '1261': { retry: false, reason: 'prompt_too_long' },
    '1301': { retry: false, reason: 'content_filtered' }
  },
  stepfun: {
    // 阶跃把「错误标识」放在 error.type：429 与两种额度超限同码，必须按标识区分
    insufficient_credit: { retry: true, reason: 'quota_exhausted' }, // 402 组织 Credit 余额不足
    project_credit_limit_exceeded: { retry: true, reason: 'quota_exhausted' }, // 429 项目 Credit 上限
    member_project_credit_limit_exceeded: { retry: true, reason: 'quota_exhausted' }, // 429 成员 Credit 上限
    rate_limited: { retry: true, reason: 'overloaded' }, // 429 速率/并发超限
    service_unavailable: { retry: true, reason: 'http_503' }, // 503 负载过高
    request_params_invalid: { retry: false, reason: 'client_fault' }, // 400 参数错
    not_allowed: { retry: false, reason: 'auth_failed' }, // 401 鉴权令牌缺失/无效
    model_invalid: { retry: false, reason: 'model_not_found' } // 404 模型 ID 错或无权限
    // 451 内容未过审走状态码规则（见 classifyUpstream），不进码表
  },
  ark: {
    // 方舟错误类型/错误码同为字符串：429 ServerOverloaded（资源紧张）/ RequestBurstTooFast（突增保护）
    ServerOverloaded: { retry: true, reason: 'overloaded' },
    RequestBurstTooFast: { retry: true, reason: 'overloaded' },
    TooManyRequests: { retry: true, reason: 'overloaded' },
    PermissionDenied: { retry: false, reason: 'client_fault' } // 403 模型未开通/无权限
  }
}

/**
 * 额度/配额/欠费关键字。中英双语：国产厂商错误体多为中文。
 * 命中即视为「这家现在给不了服务」，换下一家。
 */
const QUOTA_PATTERN =
  /insufficient[_\s-]?(quota|balance|credit|fund|points)|quota[_\s-]?(exceed|exhausted|exceeded|limit)|exceeded[_\s-]?(your\s+)?(quota|current)|out of (quota|credit|balance|points)|balance[_\s-]?(is\s+)?(insufficient|too low|not enough|exhausted)|no (available|remaining|enough)\s+(quota|balance|credit|points)|(payment|billing)\s+(required|overdue)|arrear|free[_\s-]?tier|额度不足|余额不足|配额不足|剩余额度|账户余额|已欠费|欠费|充值|token.*不足|免费额度|使用上限|已达.{0,8}上限|套餐.{0,8}(到期|失效|暂未开放)/i

/**
 * 过载/限流关键字（用于流式首帧）：命中说明这家扛不住，换一家可能就通了。
 * 注意与 QUOTA 的区别：过载是暂时的，欠费是持久的，但两者都要转移。
 */
const OVERLOAD_PATTERN =
  /overload|over[-_]?loaded|rate[_\s-]?limit|too many requests|high demand|at capacity|capacity exceeded|concurrency limit|try again later|service (unavailable|busy)|temporarily unavailable|系统繁忙|服务器繁忙|并发|限流|请求过多|服务过载|速率限制|访问量过大|稍后再试|频率.{0,4}限制/i

/** 明确的客户端错误：请求本身有问题，换供应商没有意义（保留原文给 CLI 看） */
const CLIENT_FAULT_PATTERN =
  /invalid[_\s-]?(request|api[_-]?key|model)|model[_\s-]?(not[_\s-]?found|does not exist|unsupported)|authentication|unauthor|forbidden|permission[_\s-]?denied|malformed|missing required|身份验证|令牌.{0,6}过期|二次认证|模型不存在|无权访问|参数.{0,6}(有误|非法)|超长|不安全|敏感内容/i

export interface FailureVerdict {
  retry: boolean
  /** 失败原因分类，写日志用 */
  reason: string
}

/**
 * 非 2xx 响应判定。
 * @param raw 上游响应体（截断到前若干 KB 即可，只看关键字）
 * @param opts.providerId 发起本次请求的供应商 id（业务码表按此精确生效）
 */
export function classifyUpstream(
  status: number,
  raw: string,
  opts: { retryOn429?: boolean; providerId?: string } = {}
): FailureVerdict {
  const retryOn429 = opts.retryOn429 !== false
  if (RETRYABLE_STATUS.has(status)) {
    if (status === 429 && !retryOn429) return { retry: false, reason: 'rate_limited_no_retry' }
    // 429/5xx：先用厂商业务码细化原因（GLM 的 429 背后可能是欠费 1113，阶跃的 429 可能是项目 Credit 上限）
    const byCode = classifyBusinessCode(extractBusinessFields(raw), opts.providerId)
    if (byCode?.retry) return byCode
    return { retry: true, reason: `http_${status}` }
  }
  // 451 = 请求/响应内容未过审（阶跃等国产厂商惯用），换一家大概率同样拒
  if (status === 451) return { retry: false, reason: 'content_filtered' }
  // 非重试状态码：厂商业务码优先于文本模式（文案带模板变量，文本匹配不可靠）
  const byCode = classifyBusinessCode(extractBusinessFields(raw), opts.providerId)
  if (byCode) return byCode
  if (QUOTA_PATTERN.test(raw)) return { retry: true, reason: 'quota_exhausted' }
  // 402 各家表述不一（欠费/套餐到期/需充值），一律当作这家不可用
  if (status === 402) return { retry: true, reason: 'payment_required' }
  if (OVERLOAD_PATTERN.test(raw)) return { retry: true, reason: 'overloaded' }
  if (CLIENT_FAULT_PATTERN.test(raw)) return { retry: false, reason: 'client_fault' }
  // 4xx 里既非配额也非过载：未知客户端错误，换一家大概率同样失败，透传原文更有诊断价值
  return { retry: status >= 500, reason: `http_${status}` }
}

/**
 * HTTP 200 但体里带错误：非流式是 JSON 的 error 字段，流式是 SSE 首帧。
 * 返回 null 表示「看起来正常，可以透传」。
 * @param providerId 发起本次请求的供应商 id（业务码表按此精确生效）
 */
export function detectSuccessBodyFailure(
  prefix: string,
  isStream: boolean,
  providerId?: string
): FailureVerdict | null {
  if (!prefix.trim()) return null

  if (!isStream) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(prefix)
    } catch {
      return null // 非流式却不是 JSON：交给下游解析，不在这里猜
    }
    const err = extractErrorField(parsed)
    if (!err) return null
    return matchErrorText(err.type, err.code, err.message, providerId)
  }

  // 流式：只关心前几 KB 里有没有 error 事件（Anthropic: event: error；OpenAI: data: {"error":…}）
  const dataPayloads = [...prefix.matchAll(/^data:\s*(.+)$/gim)].map((m) => m[1].trim())
  let sawErrorEvent = /^event:\s*error/im.test(prefix)
  for (const payload of dataPayloads) {
    if (payload === '[DONE]') continue
    let parsed: unknown = null
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    const err = extractErrorField(parsed)
    if (!err) continue
    sawErrorEvent = true
    const verdict = matchErrorText(err.type, err.code, err.message, providerId)
    if (verdict) return verdict
  }
  if (sawErrorEvent) return { retry: true, reason: 'stream_error_event' }
  return null
}

/** 从上游错误体里抠出业务字段（GLM/OpenAI 风格：{"error":{"code":"1113","type":"…"}}） */
function extractBusinessFields(raw: string): { code: string; type: string } {
  if (!raw.trim()) return { code: '', type: '' }
  try {
    const parsed = JSON.parse(raw) as
      | { error?: { code?: unknown; type?: unknown }; code?: unknown; type?: unknown }
      | null
    const err = parsed?.error
    const src = err && typeof err === 'object' ? err : parsed
    const pick = (v: unknown): string =>
      typeof v === 'string' || typeof v === 'number' ? String(v) : ''
    return { code: pick((src as { code?: unknown })?.code), type: pick((src as { type?: unknown })?.type) }
  } catch {
    return { code: '', type: '' }
  }
}

/** 厂商业务码/标识 → 判定。无表或未命中返回 null，交给文本模式 */
function classifyBusinessCode(
  fields: { code: string; type: string },
  providerId?: string
): FailureVerdict | null {
  if (!providerId) return null
  const table = PROVIDER_BUSINESS_CODES[providerId]
  if (!table) return null
  for (const key of [fields.code, fields.type]) {
    const k = key.trim()
    if (k && Object.prototype.hasOwnProperty.call(table, k)) return table[k]
  }
  return null
}

function extractErrorField(node: unknown): { type: string; code: string; message: string } | null {
  const n = node as { error?: unknown; type?: unknown; code?: unknown; message?: unknown } | null
  const err = n?.error
  if (err && typeof err === 'object') {
    const e = err as { type?: unknown; code?: unknown; message?: unknown }
    return {
      type: String(e.type ?? ''),
      code: String(e.code ?? ''),
      message: typeof e.message === 'string' ? e.message : ''
    }
  }
  if (typeof err === 'string') return { type: '', code: '', message: err }
  // 顶层就是错误信封（{ type:'error', error:{…} } 已被上面捕获；这里处理 { code, message }）
  if (n && typeof n === 'object' && typeof n.message === 'string' && typeof n.type === 'string') {
    return { type: n.type, code: '', message: n.message }
  }
  return null
}

/** 按错误内容分类：厂商业务码 → 额度 → 过载 → 客户端错误 → 未知（默认不转移，避免无意义乱切） */
function matchErrorText(
  type: string,
  code: string,
  message: string,
  providerId?: string
): FailureVerdict | null {
  const byCode = classifyBusinessCode({ code, type }, providerId)
  if (byCode) return byCode
  const text = `${type} ${code} ${message}`
  if (QUOTA_PATTERN.test(text)) return { retry: true, reason: 'quota_exhausted' }
  if (OVERLOAD_PATTERN.test(text)) return { retry: true, reason: 'overloaded' }
  if (CLIENT_FAULT_PATTERN.test(text)) return { retry: false, reason: 'client_fault' }
  return null
}

/** 把失败原因翻成界面能看懂的中文（日志与提示条共用） */
export function describeFailure(reason: string): string {
  if (reason.startsWith('http_')) return `上游 HTTP ${reason.slice(5)}`
  switch (reason) {
    case 'quota_exhausted':
      return '额度/余额不足'
    case 'payment_required':
      return '账户欠费或套餐到期'
    case 'overloaded':
      return '上游过载或限流'
    case 'client_fault':
      return '请求被上游拒绝（模型名或 Key 有误）'
    case 'auth_failed':
      return '身份验证失败（API Key 有误）'
    case 'auth_expired':
      return '登录令牌已过期，请重新获取'
    case 'auth_2fa':
      return '账户开启了二次认证，需登录处理'
    case 'model_not_found':
      return '模型不存在（供应商配置的模型名有误）'
    case 'content_filtered':
      return '内容被上游安全策略拦截'
    case 'prompt_too_long':
      return 'Prompt 超出长度上限'
    case 'stream_error_event':
      return '上游流式返回错误'
    case 'rate_limited_no_retry':
      return '限流（未开启 429 转移）'
    default:
      return reason
  }
}
