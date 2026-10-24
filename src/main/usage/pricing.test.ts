import { describe, expect, it } from 'vitest'
import { estimateCost, isDeepSeekPeak, priceOf } from './pricing'

/** 本地时间构造（本机为 UTC+8，与官方「北京时间」一致） */
function local(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

describe('DeepSeek 峰谷时段', () => {
  it('工作日 9-12 / 14-18 为高峰，其余为空闲；周末全天空闲', () => {
    expect(isDeepSeekPeak(local(2026, 10, 14, 10))).toBe(true) // 周三 10:00
    expect(isDeepSeekPeak(local(2026, 10, 14, 12))).toBe(false) // 12:00 边界（左闭右开）
    expect(isDeepSeekPeak(local(2026, 10, 14, 15))).toBe(true) // 15:00
    expect(isDeepSeekPeak(local(2026, 10, 14, 20))).toBe(false) // 20:00
    expect(isDeepSeekPeak(local(2026, 10, 17, 10))).toBe(false) // 周六 10:00
  })
})

describe('价目表', () => {
  it('deepseek 按峰谷取价；kimi 平价；未收录返回 null', () => {
    const peakTs = local(2026, 10, 14, 10)
    const offTs = local(2026, 10, 14, 22)
    expect(priceOf('deepseek-flash', peakTs)).toEqual({ input: 2, output: 8 })
    expect(priceOf('deepseek-flash', offTs)).toEqual({ input: 1, output: 4 })
    expect(priceOf('deepseek-v4-pro', peakTs)).toEqual({ input: 9, output: 27 })
    expect(priceOf('kimi-k3', peakTs)).toEqual({ input: 20, output: 100 })
    expect(priceOf('glm-5.3', offTs)).toBeNull()
    expect(priceOf(null, offTs)).toBeNull()
    expect(priceOf('  DeepSeek-Flash ', offTs)).toEqual({ input: 1, output: 4 })
  })

  it('估算金额：按每百万 token 计', () => {
    const offTs = local(2026, 10, 14, 22)
    // flash 空闲：1M 输入 + 1M 输出 = 1 + 4 = 5 元
    expect(estimateCost('deepseek-flash', offTs, 1_000_000, 1_000_000)).toBeCloseTo(5, 6)
    // 100k 输入 + 20k 输出 = 0.1*1 + 0.02*4 = 0.18
    expect(estimateCost('deepseek-flash', offTs, 100_000, 20_000)).toBeCloseTo(0.18, 6)
    // 无价目模型 → null（不瞎算）
    expect(estimateCost('glm-5.3', offTs, 1000, 1000)).toBeNull()
    // token 为 0 → 0（有价目时）
    expect(estimateCost('kimi-k3', offTs, 0, 0)).toBe(0)
    // 负数/NaN 容错
    expect(estimateCost('kimi-k3', offTs, -5, Number.NaN)).toBe(0)
  })
})