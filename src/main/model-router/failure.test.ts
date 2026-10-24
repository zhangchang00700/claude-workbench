import { describe, expect, it } from 'vitest'
import { classifyUpstream, describeFailure, detectSuccessBodyFailure } from './failure'

describe('上游失败判定（是否换下一家）', () => {
  it('429 / 5xx 一律转移', () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      expect(classifyUpstream(status, '').retry).toBe(true)
    }
  })

  it('429 可配置为不转移（retryOn429=false）', () => {
    expect(classifyUpstream(429, '', { retryOn429: false }).retry).toBe(false)
    expect(classifyUpstream(429, '', { retryOn429: true }).retry).toBe(true)
  })

  it('额度不足藏在 400 正文里也要转移（国产厂商常见）', () => {
    expect(classifyUpstream(400, '{"error":{"message":"账户余额不足，请充值"}}').reason).toBe(
      'quota_exhausted'
    )
    expect(classifyUpstream(400, 'insufficient_quota').retry).toBe(true)
    expect(classifyUpstream(400, 'Insufficient balance').retry).toBe(true)
    expect(classifyUpstream(403, 'The account is in arrears').retry).toBe(true)
  })

  it('402 欠费直接转移', () => {
    expect(classifyUpstream(402, '').retry).toBe(true)
    expect(classifyUpstream(402, '').reason).toBe('payment_required')
  })

  it('过载文本即使 200/4xx 也转移', () => {
    expect(classifyUpstream(200, 'engine overloaded, try again later').reason).toBe('overloaded')
    expect(classifyUpstream(503, '服务器繁忙').retry).toBe(true)
  })

  it('请求本身有问题（Key/模型名错）不转移，保留原文给 CLI', () => {
    expect(classifyUpstream(401, 'invalid api key').retry).toBe(false)
    expect(classifyUpstream(400, 'model not found: xxx').retry).toBe(false)
    expect(classifyUpstream(404, 'not found').retry).toBe(false)
  })

  it('未知 5xx 仍然转移，未知 4xx 不转移', () => {
    expect(classifyUpstream(509, '').retry).toBe(true)
    expect(classifyUpstream(418, 'teapot').retry).toBe(false)
  })
})

describe('HTTP 200 但体里带错误（流式首帧探测）', () => {
  it('Anthropic SSE 首帧 overloaded → 转移', () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true)?.reason).toBe('overloaded')
  })

  it('SSE 首帧额度不足 → 转移', () => {
    const sse =
      'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"insufficient balance, please recharge"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true)?.reason).toBe('quota_exhausted')
  })

  it('OpenAI 风格 data: {"error":…} 也能识别', () => {
    const sse = 'data: {"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true)?.retry).toBe(true)
  })

  it('正常首帧（content_block_delta）不误判', () => {
    const sse =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true)).toBeNull()
  })

  it('只有心跳/注释的开头不误判', () => {
    expect(detectSuccessBodyFailure(': ping\n\n', true)).toBeNull()
    expect(detectSuccessBodyFailure('', true)).toBeNull()
  })

  it('非流式 200 带 error 字段 → 转移', () => {
    const body = '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'
    expect(detectSuccessBodyFailure(body, false)?.retry).toBe(true)
  })

  it('非流式正常 message 不误判', () => {
    const body = '{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}'
    expect(detectSuccessBodyFailure(body, false)).toBeNull()
  })
})

describe('智谱 GLM 官方业务错误码（https://docs.bigmodel.cn/cn/api/api-code.md）', () => {
  const glmBody = (code: string) => `{"error":{"code":"${code}","message":"x"}}`

  it('额度/欠费/套餐/限额类 → 转移（GLM 多编成 429，码给出精确原因）', () => {
    for (const code of ['1113', '1308', '1310', '1316', '1317', '1321']) {
      expect(classifyUpstream(429, glmBody(code), { providerId: 'glm' }).retry).toBe(true)
    }
    expect(classifyUpstream(429, glmBody('1113'), { providerId: 'glm' }).reason).toBe(
      'quota_exhausted'
    )
    expect(classifyUpstream(429, glmBody('1309'), { providerId: 'glm' }).reason).toBe(
      'payment_required'
    )
  })

  it('限流/过载/公平使用限制 → 转移', () => {
    for (const code of ['1302', '1305', '1313']) {
      expect(classifyUpstream(429, glmBody(code), { providerId: 'glm' }).retry).toBe(true)
    }
    expect(classifyUpstream(429, glmBody('1302'), { providerId: 'glm' }).reason).toBe('overloaded')
  })

  it('服务端 1200/1230/1234 → 转移', () => {
    for (const code of ['1200', '1230', '1234']) {
      expect(classifyUpstream(500, glmBody(code), { providerId: 'glm' }).retry).toBe(true)
    }
  })

  it('身份/Key/参数/模型名/内容安全 → 不转移', () => {
    expect(classifyUpstream(401, glmBody('1000'), { providerId: 'glm' }).retry).toBe(false)
    expect(classifyUpstream(401, glmBody('1000'), { providerId: 'glm' }).reason).toBe('auth_failed')
    expect(classifyUpstream(400, glmBody('1211'), { providerId: 'glm' }).reason).toBe(
      'model_not_found'
    )
    expect(classifyUpstream(400, glmBody('1301'), { providerId: 'glm' }).retry).toBe(false)
    expect(classifyUpstream(429, glmBody('1315'), { providerId: 'glm' }).retry).toBe(true) // 429 状态码优先
    expect(classifyUpstream(400, glmBody('1315'), { providerId: 'glm' }).retry).toBe(false)
    expect(classifyUpstream(400, glmBody('1261'), { providerId: 'glm' }).reason).toBe(
      'prompt_too_long'
    )
  })

  it('业务码只对 providerId=glm 生效（别家数字码不猜，走文本模式）', () => {
    // 别家出现同样数字码：不应套用 GLM 表
    expect(classifyUpstream(400, glmBody('1113'), { providerId: 'deepseek' }).retry).toBe(false)
    expect(classifyUpstream(400, glmBody('1113')).retry).toBe(false)
    // 但 GLM 的 400 + 欠费码要能转移（码表优先于默认 4xx 不转移）
    expect(classifyUpstream(400, glmBody('1113'), { providerId: 'glm' }).retry).toBe(true)
  })

  it('200 + SSE error 帧里只有业务码和文案（无状态码）→ 按码判定', () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true, 'glm')?.reason).toBe('overloaded')
    const quota = 'event: error\ndata: {"type":"error","error":{"code":"1113","message":"您的账户已欠费，请充值后重试"}}\n\n'
    expect(detectSuccessBodyFailure(quota, true, 'glm')?.reason).toBe('quota_exhausted')
    const auth = 'event: error\ndata: {"type":"error","error":{"code":"1001","message":"Header 中未收到 Authentication 参数"}}\n\n'
    expect(detectSuccessBodyFailure(auth, true, 'glm')?.retry).toBe(false)
    // 非 GLM 供应商的同类帧：走既有文本/事件兜底
    expect(detectSuccessBodyFailure(quota, true, 'deepseek')?.retry).toBe(true)
  })

  it('非流式 200 带 GLM 错误信封 → 按码判定', () => {
    const body = '{"error":{"code":"1309","message":"您的 GLM Coding Plan 套餐已到期"}}'
    expect(detectSuccessBodyFailure(body, false, 'glm')?.reason).toBe('payment_required')
  })

  it('GLM 中文文案（无码）靠文本模式兜底', () => {
    expect(classifyUpstream(429, '{"error":{"message":"您的账户已达到速率限制"}}', { providerId: 'glm' }).retry).toBe(true)
    expect(classifyUpstream(400, '{"error":{"message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}}', { providerId: 'glm' }).retry).toBe(false)
  })
})

describe('阶跃 StepFun 官方错误标识（https://platform.stepfun.com/docs/zh/api-reference/error-codes）', () => {
  const body = (type: string, code = '') =>
    JSON.stringify({ error: { type, code, message: 'x' } })

  it('402 insufficient_credit / 429 项目·成员 Credit 上限 → 转移（额度类）', () => {
    expect(classifyUpstream(402, body('insufficient_credit'), { providerId: 'stepfun' }).reason).toBe(
      'quota_exhausted'
    )
    expect(classifyUpstream(429, body('project_credit_limit_exceeded'), { providerId: 'stepfun' }).reason).toBe(
      'quota_exhausted'
    )
    expect(
      classifyUpstream(429, body('member_project_credit_limit_exceeded'), { providerId: 'stepfun' }).retry
    ).toBe(true)
  })

  it('429 rate_limited → 转移（过载类，与 Credit 上限同码不同因）', () => {
    expect(classifyUpstream(429, body('rate_limited'), { providerId: 'stepfun' }).reason).toBe(
      'overloaded'
    )
  })

  it('451 内容未过审 → 不转移（状态码规则，全供应商生效）', () => {
    expect(classifyUpstream(451, '', { providerId: 'stepfun' }).retry).toBe(false)
    expect(classifyUpstream(451, '', { providerId: 'stepfun' }).reason).toBe('content_filtered')
  })

  it('参数/鉴权/模型 ID 错 → 不转移', () => {
    expect(classifyUpstream(400, body('request_params_invalid'), { providerId: 'stepfun' }).retry).toBe(false)
    expect(classifyUpstream(401, body('not_allowed'), { providerId: 'stepfun' }).reason).toBe('auth_failed')
    expect(classifyUpstream(404, body('model_invalid'), { providerId: 'stepfun' }).reason).toBe(
      'model_not_found'
    )
  })

  it('200 + SSE error 帧按标识判定', () => {
    const sse =
      'event: error\ndata: {"type":"error","error":{"type":"project_credit_limit_exceeded","message":"项目达到当期 Credit 上限"}}\n\n'
    expect(detectSuccessBodyFailure(sse, true, 'stepfun')?.reason).toBe('quota_exhausted')
  })
})

describe('火山方舟 Ark 错误类型串（https://www.volcengine.com/docs/82379/1848593）', () => {
  it('ServerOverloaded / RequestBurstTooFast / TooManyRequests → 转移', () => {
    for (const t of ['ServerOverloaded', 'RequestBurstTooFast', 'TooManyRequests']) {
      const raw = JSON.stringify({ error: { code: t, type: 'TooManyRequests', message: 'x' } })
      expect(classifyUpstream(429, raw, { providerId: 'ark' }).reason).toBe('overloaded')
    }
  })

  it('PermissionDenied（403 模型未开通）→ 不转移', () => {
    const raw = JSON.stringify({ error: { code: 'PermissionDenied', message: 'x' } })
    expect(classifyUpstream(403, raw, { providerId: 'ark' }).retry).toBe(false)
    expect(classifyUpstream(403, raw, { providerId: 'ark' }).reason).toBe('client_fault')
  })
})

describe('失败原因中文描述', () => {
  it('机器原因能翻成人话', () => {
    expect(describeFailure('quota_exhausted')).toContain('额度')
    expect(describeFailure('http_429')).toContain('429')
    expect(describeFailure('overloaded')).toContain('过载')
  })
})
