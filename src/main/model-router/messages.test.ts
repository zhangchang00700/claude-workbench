/**
 * 速聊 / 任务队列共用的「直连路由站取文本」通道单测。
 *
 * 不依赖 electron、不发真实网络请求：fetch 通过 options.fetchImpl 注入。
 */
import { describe, expect, it } from 'vitest'
import type { ModelTier } from '../../shared/types'
import { callRouterText, callRouterTextDetailed, describeHttpError, extractText, findProviderByModel } from './messages'

const router = { baseUrl: 'http://127.0.0.1:1234', localToken: 'tok-abc' }

interface Recorded {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 录制每次请求的假 fetch：既能控制响应，也能回查请求体 */
function fakeFetch(respond: () => { ok: boolean; status: number; text: string }): {
  impl: NonNullable<Parameters<typeof callRouterText>[1]['fetchImpl']>
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const impl = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      body = {}
    }
    calls.push({ url, headers, body })
    const r = respond()
    return { ok: r.ok, status: r.status, text: async () => r.text }
  }
  return { impl, calls }
}

const json = (payload: unknown): { ok: boolean; status: number; text: string } => ({
  ok: true,
  status: 200,
  text: JSON.stringify(payload)
})

describe('extractText', () => {
  it('取 content[] 里的 text 块并拼接', () => {
    expect(extractText({ content: [{ type: 'text', text: '你好' }, { type: 'text', text: '世界' }] })).toBe(
      '你好世界'
    )
  })

  it('跳过非 text 块', () => {
    expect(extractText({ content: [{ type: 'thinking', text: '忽略' }, { type: 'text', text: '只要我' }] })).toBe(
      '只要我'
    )
  })

  it('兜底 OpenAI choices 形态', () => {
    expect(extractText({ choices: [{ message: { content: '兜底文本' } }] })).toBe('兜底文本')
  })

  it('空响应返回空串', () => {
    expect(extractText({ content: [] })).toBe('')
    expect(extractText({})).toBe('')
  })
})

describe('describeHttpError', () => {
  it('优先取 error.message', () => {
    expect(describeHttpError(429, '{"error":{"message":"额度不足"}}')).toBe('上游 429：额度不足')
  })

  it('非 JSON 时截断原文', () => {
    const msg = describeHttpError(500, 'x'.repeat(500))
    expect(msg.startsWith('上游 500：')).toBe(true)
    expect(msg.length).toBeLessThan(420)
  })
})

describe('findProviderByModel（反查实际承接的供应商）', () => {
  const providers = [
    { name: 'DeepSeek', defaultModel: 'deepseek-chat', models: { sonnet: 'deepseek-chat' } },
    { name: '智谱', defaultModel: 'glm-4.6', models: { sonnet: 'glm-4.6', opus: 'glm-4.5' } }
  ] as unknown as Parameters<typeof findProviderByModel>[0]

  it('按 defaultModel 命中', () => {
    expect(findProviderByModel(providers, 'glm-4.6')).toBe('智谱')
  })

  it('按三档模型名命中', () => {
    expect(findProviderByModel(providers, 'glm-4.5')).toBe('智谱')
    expect(findProviderByModel(providers, 'deepseek-chat')).toBe('DeepSeek')
  })

  it('大小写不敏感', () => {
    expect(findProviderByModel(providers, 'GLM-4.6')).toBe('智谱')
  })

  it('查不到返回 undefined（渲染层据此降级显示）', () => {
    expect(findProviderByModel(providers, '未知模型')).toBeUndefined()
    expect(findProviderByModel(providers, undefined)).toBeUndefined()
    expect(findProviderByModel(providers, '')).toBeUndefined()
  })

  it('同名时取列表靠前者（调用方按优先级传入）', () => {
    const same = [
      { name: 'A', models: { sonnet: 'x' } },
      { name: 'B', models: { sonnet: 'x' } }
    ] as unknown as Parameters<typeof findProviderByModel>[0]
    expect(findProviderByModel(same, 'x')).toBe('A')
  })
})

describe('callRouterTextDetailed', () => {
  it('连 model 一起返回，供上层反查供应商', async () => {
    const { impl } = fakeFetch(() =>
      json({ id: 'msg_1', model: 'glm-4.6', content: [{ type: 'text', text: '答案' }] })
    )
    const r = await callRouterTextDetailed(router, { prompt: 'p', tier: 'sonnet', fetchImpl: impl })
    expect(r.text).toBe('答案')
    expect(r.model).toBe('glm-4.6')
  })

  it('没有 model 字段时 model 为 undefined', async () => {
    const { impl } = fakeFetch(() => json({ content: [{ type: 'text', text: '答案' }] }))
    const r = await callRouterTextDetailed(router, { prompt: 'p', tier: 'sonnet', fetchImpl: impl })
    expect(r.model).toBeUndefined()
  })
})

describe('callRouterText', () => {
  it('正常返回拼接后的纯文本，且请求与任务队列原本实现同构', async () => {
    const { impl, calls } = fakeFetch(() => json({ content: [{ type: 'text', text: '速聊答案' }] }))
    const out = await callRouterText(router, { prompt: 'hi', tier: 'sonnet', fetchImpl: impl })
    expect(out).toBe('速聊答案')
    const first = calls[0]
    expect(first?.url).toBe('http://127.0.0.1:1234/v1/messages')
    expect(first?.headers['x-api-key']).toBe('tok-abc')
    expect(first?.headers.authorization).toBe('Bearer tok-abc')
    expect(first?.body).toMatchObject({ model: 'wb-sonnet', stream: false, max_tokens: 4096 })
    expect(first?.body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('按 tier 换成路由站虚拟别名', async () => {
    const cases: Array<[ModelTier, string]> = [
      ['opus', 'wb-opus'],
      ['sonnet', 'wb-sonnet'],
      ['haiku', 'wb-haiku']
    ]
    for (const [tier, alias] of cases) {
      const { impl, calls } = fakeFetch(() => json({ content: [{ type: 'text', text: 'x' }] }))
      await callRouterText(router, { prompt: 'p', tier, fetchImpl: impl })
      expect(calls[0]?.body.model).toBe(alias)
    }
  })

  it('自定义 maxTokens 生效（速聊用较短上限）', async () => {
    const { impl, calls } = fakeFetch(() => json({ content: [{ type: 'text', text: 'x' }] }))
    await callRouterText(router, { prompt: 'p', tier: 'sonnet', maxTokens: 2048, fetchImpl: impl })
    expect(calls[0]?.body.max_tokens).toBe(2048)
  })

  it('非 2xx 抛错且带上上游 message', async () => {
    const { impl } = fakeFetch(() => ({
      ok: false,
      status: 403,
      text: '{"error":{"message":"key 无效"}}'
    }))
    await expect(callRouterText(router, { prompt: 'p', tier: 'sonnet', fetchImpl: impl })).rejects.toThrow(
      /key 无效/
    )
  })

  it('非 JSON 响应抛错', async () => {
    const { impl } = fakeFetch(() => ({ ok: true, status: 200, text: '<html>代理劫持</html>' }))
    await expect(callRouterText(router, { prompt: 'p', tier: 'sonnet', fetchImpl: impl })).rejects.toThrow(
      /非 JSON/
    )
  })

  it('空文本抛错（任务执行器据此判失败）', async () => {
    const { impl } = fakeFetch(() => json({ content: [] }))
    await expect(callRouterText(router, { prompt: 'p', tier: 'sonnet', fetchImpl: impl })).rejects.toThrow(
      /空文本/
    )
  })
})
