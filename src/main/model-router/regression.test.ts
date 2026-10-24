/**
 * 厂商兼容回归测试矩阵（P1）。
 *
 * 用各家官方文档的真实错误响应形状做夹具，守住「换不换下一家」的判定：
 * 智谱 GLM 数字码 / 阶跃 error.type 标识串 / 方舟类型串 / OpenAI 风格 /
 * Anthropic 原生 SSE / 截断与边界。形状来源（2026-10-17 核对）：
 * - https://docs.bigmodel.cn/cn/api/api-code.md
 * - https://platform.stepfun.com/docs/zh/api-reference/error-codes
 * - https://www.volcengine.com/docs/82379/1848593
 */
import { describe, expect, it } from 'vitest'
import { classifyUpstream, detectSuccessBodyFailure } from './failure'

describe('回归：智谱 GLM 数字业务码', () => {
  it('200 非流式体带 1113 欠费码 → 转移（额度类）', () => {
    const body = '{"error":{"code":"1113","message":"您的账户已欠费，请充值后重试"}}'
    expect(detectSuccessBodyFailure(body, false, 'glm')?.reason).toBe('quota_exhausted')
    expect(detectSuccessBodyFailure(body, false, 'glm')?.retry).toBe(true)
  })

  it('429 + 1315（Key 仅限企业编程套餐）→ 429 状态码优先，仍转移', () => {
    const body = '{"error":{"code":"1315","message":"该 API Key 仅限企业编程套餐场景使用"}}'
    const v = classifyUpstream(429, body, { providerId: 'glm' })
    expect(v.retry).toBe(true)
  })

  it('401 + 1000 身份验证失败 → 不转移', () => {
    expect(classifyUpstream(401, '{"error":{"code":"1000","message":"身份验证失败"}}', { providerId: 'glm' }).retry).toBe(false)
  })

  it('1305 访问量过大（429）→ 过载类转移', () => {
    expect(classifyUpstream(429, '{"error":{"code":"1305","message":"该模型当前访问量过大"}}', { providerId: 'glm' }).reason).toBe('overloaded')
  })
})

describe('回归：阶跃 StepFun 错误标识串', () => {
  it('SSE 首帧 project_credit_limit_exceeded → 额度类（与 rate_limited 同 429 不同因）', () => {
    const sse =
      'event: error\ndata: {"type":"error","error":{"type":"project_credit_limit_exceeded","message":"项目达到当期 Credit 上限"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true, 'stepfun')?.reason).toBe('quota_exhausted')
    const rate =
      'event: error\ndata: {"type":"error","error":{"type":"rate_limited","message":"请求速率超限"}}\n\n'
    expect(detectSuccessBodyFailure(rate, true, 'stepfun')?.reason).toBe('overloaded')
  })

  it('402 + insufficient_credit → 转移', () => {
    expect(
      classifyUpstream(402, '{"error":{"type":"insufficient_credit","message":"Credit 余额不足"}}', { providerId: 'stepfun' }).reason
    ).toBe('quota_exhausted')
  })

  it('451 内容未过审 → 不转移（全供应商状态码规则）', () => {
    const v = classifyUpstream(451, '{"error":{"message":"请求内容或者响应内容未审核通过"}}', { providerId: 'stepfun' })
    expect(v.retry).toBe(false)
    expect(v.reason).toBe('content_filtered')
  })
})

describe('回归：火山方舟 Ark 类型串', () => {
  it('ServerOverloaded / RequestBurstTooFast → 过载类转移', () => {
    for (const code of ['ServerOverloaded', 'RequestBurstTooFast']) {
      const body = JSON.stringify({ error: { code, type: 'TooManyRequests', message: 'x' } })
      expect(classifyUpstream(429, body, { providerId: 'ark' }).reason, code).toBe('overloaded')
    }
  })

  it('PermissionDenied（403 模型未开通）→ 不转移', () => {
    const body = '{"error":{"code":"PermissionDenied","message":"模型未开通"}}'
    expect(classifyUpstream(403, body, { providerId: 'ark' }).retry).toBe(false)
  })
})

describe('回归：OpenAI 风格通用错误体', () => {
  it('rate_limit_exceeded / insufficient_balance → 转移；invalid_request_error → 不转移', () => {
    expect(detectSuccessBodyFailure('{"error":{"code":"rate_limit_exceeded","type":"rate_limit_error"}}', false)?.retry).toBe(true)
    expect(detectSuccessBodyFailure('{"error":{"code":"insufficient_balance","message":"余额不足"}}', false)?.reason).toBe('quota_exhausted')
    expect(detectSuccessBodyFailure('{"error":{"code":"invalid_request_error","message":"bad param"}}', false)?.retry).toBe(false)
  })
})

describe('回归：Anthropic 原生 SSE', () => {
  it('overloaded_error → 转移；authentication_error → 不转移', () => {
    const over = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    expect(detectSuccessBodyFailure(over, true)?.retry).toBe(true)
    const auth = 'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\n\n'
    expect(detectSuccessBodyFailure(auth, true)?.retry).toBe(false)
  })
})

describe('回归：截断与边界', () => {
  it('前 8KB 截断的 JSON 不抛异常、不误判为成功', () => {
    const big = '{"error":{"code":"1113","message":"' + 'x'.repeat(20_000) + '"}}'
    const truncated = big.slice(0, 8192)
    expect(() => detectSuccessBodyFailure(truncated, false, 'glm')).not.toThrow()
    // 截断后 JSON.parse 失败 → 不猜，返回 null 由下游处理（绝不误判为可透传的成功）
    expect(detectSuccessBodyFailure(truncated, false, 'glm')).toBeNull()
  })

  it('空前缀与心跳注释帧不误判', () => {
    expect(detectSuccessBodyFailure('', true)).toBeNull()
    expect(detectSuccessBodyFailure(': ping\n\n', true)).toBeNull()
  })

  it('providerId 隔离：GLM 数字码不套到别家', () => {
    const body = '{"error":{"code":"1113","message":"x"}}'
    expect(classifyUpstream(400, body, { providerId: 'glm' }).retry).toBe(true)
    expect(classifyUpstream(400, body, { providerId: 'deepseek' }).retry).toBe(false)
    expect(classifyUpstream(400, body).retry).toBe(false)
  })
})
