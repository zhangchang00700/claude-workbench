/**
 * 模型价格表（成本估算用，单位：元 / 百万 token）。
 *
 * 原则：只收录**已核对官方定价页**的模型；未收录的一律返回 null，
 * 面板显示 token 但金额留空（绝不编价）。出处：
 * - DeepSeek 定价：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   高峰时段为北京时间每日 9:00-12:00、14:00-18:00；空闲时段为高峰的一半。
 *   本表按官方「缓存未命中」档：deepseek-flash 空闲 1/4、高峰 2/8；
 *   deepseek-v4-pro 空闲 4.5/13.5、高峰 9/27。
 * - Kimi 定价：https://platform.moonshot.cn/ （kimi-k3 输入 ¥20/M 缓存未命中、输出 ¥100/M）。
 * - GLM / 阶跃 / 方舟 / Agnes / 硅基流动等：未核对到官方价目 → 不计金额。
 */
export interface TokenPrice {
  /** 输入（缓存未命中）元/百万 token */
  input: number
  /** 输出元/百万 token */
  output: number
}

/** 工作日高峰时段（北京时间，小时区间左闭右开） */
const PEAK_HOURS: Array<[number, number]> = [
  [9, 12],
  [14, 18]
]

/** 是否处于 DeepSeek 高峰时段（仅工作日；按本机时区，国内机器即北京时间） */
export function isDeepSeekPeak(ts: number): boolean {
  const d = new Date(ts)
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  const h = d.getHours()
  return PEAK_HOURS.some(([from, to]) => h >= from && h < to)
}

const DEEPSEEK_PRICES: Record<string, { offPeak: TokenPrice; peak: TokenPrice }> = {
  'deepseek-flash': { offPeak: { input: 1, output: 4 }, peak: { input: 2, output: 8 } },
  'deepseek-v4-pro': { offPeak: { input: 4.5, output: 13.5 }, peak: { input: 9, output: 27 } }
}

const FLAT_PRICES: Record<string, TokenPrice> = {
  'kimi-k3': { input: 20, output: 100 }
}

/** 取某模型在某个时刻的单价；未收录返回 null */
export function priceOf(model: string | null | undefined, ts: number): TokenPrice | null {
  if (!model) return null
  const m = model.trim().toLowerCase()
  const ds = DEEPSEEK_PRICES[m]
  if (ds) return isDeepSeekPeak(ts) ? ds.peak : ds.offPeak
  return FLAT_PRICES[m] ?? null
}

/** 估算单次请求金额（元）；无价目返回 null */
export function estimateCost(
  model: string | null | undefined,
  ts: number,
  inputTokens: number,
  outputTokens: number
): number | null {
  const p = priceOf(model, ts)
  if (!p) return null
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0
  return (inTok / 1_000_000) * p.input + (outTok / 1_000_000) * p.output
}
