import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PRESETS,
  PROTOCOL_SPECS,
  endpointUrl,
  normalizeBaseUrl,
  validateBaseUrl,
  type ProviderConfig
} from '../../shared/types'
import { buildUpstreamRequest, translateResponse, OpenAiStreamTranslator, protocolOf } from './protocol'

function pv(partial: Partial<ProviderConfig> & { id: string; baseUrl: string }): ProviderConfig {
  return {
    name: partial.id,
    apiKeyEnc: 'x',
    models: {},
    priority: 1,
    enabled: true,
    builtin: true,
    ...partial
  } as ProviderConfig
}

describe('baseUrl 规范化', () => {
  it('剥掉 anthropic 端点常见的多余后缀', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/anthropic/v1')).toBe('https://api.deepseek.com/anthropic')
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/anthropic/v1/messages')).toBe(
      'https://open.bigmodel.cn/api/anthropic'
    )
    expect(normalizeBaseUrl('https://x.com/anthropic/')).toBe('https://x.com/anthropic')
  })

  it('openai 协议保留 /v1 前缀但剥掉具体端点', () => {
    expect(normalizeBaseUrl('https://apihub.agnes-ai.com/v1/chat/completions', 'openai')).toBe(
      'https://apihub.agnes-ai.com/v1'
    )
    expect(normalizeBaseUrl('https://apihub.agnes-ai.com/v1', 'openai')).toBe('https://apihub.agnes-ai.com/v1')
  })

  it('拼出实际请求地址', () => {
    expect(endpointUrl('https://api.deepseek.com/anthropic', 'anthropic', 'messages')).toBe(
      'https://api.deepseek.com/anthropic/v1/messages'
    )
    expect(endpointUrl('https://apihub.agnes-ai.com/v1', 'openai', 'messages')).toBe(
      'https://apihub.agnes-ai.com/v1/chat/completions'
    )
  })

  it('校验给出可读提示', () => {
    expect(validateBaseUrl('')).toContain('不能为空')
    expect(validateBaseUrl('api.deepseek.com')).toContain('http')
    expect(validateBaseUrl('https://api.deepseek.com/anthropic')).toBeNull()
    expect(validateBaseUrl('https://api.deepseek.com/anthropic/v1')).toContain('实际请求')
  })
})

describe('内置预设与官方端点一致（2026-10 核对）', () => {
  it('五家供应商的端点与协议', () => {
    const byId = Object.fromEntries(BUILTIN_PRESETS.map((p) => [p.id, p]))
    expect(byId.glm.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(byId.deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(byId.kimi.baseUrl).toBe('https://api.moonshot.cn/anthropic')
    expect(byId.ark.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/compatible')
    expect(byId.agnes.baseUrl).toBe('https://apihub.agnes-ai.com/v1')
    expect(byId.agnes.protocol).toBe('openai')
    expect(byId.ark.protocol).toBe('anthropic')
  })

  it('默认档为 GLM-5.3-Flash 且优先级最高', () => {
    const glm = BUILTIN_PRESETS.find((p) => p.id === 'glm')!
    expect(glm.defaultModel).toBe('GLM-5.3-Flash')
    expect(glm.priority).toBe(1)
  })

  it('各家端点拼出来的 messages 地址不含重复 /v1', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(endpointUrl(p.baseUrl, p.protocol, 'messages')).not.toContain('/v1/v1')
    }
  })
})

describe('协议适配', () => {
  it('anthropic 上游：只改 model，路径不变', () => {
    const p = pv({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'anthropic' })
    const req = buildUpstreamRequest(p, 'deepseek-v4-flash', Buffer.from(JSON.stringify({ model: 'wb-sonnet', max_tokens: 8 })))
    expect(req.path).toBe('/v1/messages')
    expect(JSON.parse(req.body.toString()).model).toBe('deepseek-v4-flash')
    expect(req.unsupported).toBeUndefined()
  })

  it('openai 上游：转 chat/completions 并合并 system', () => {
    const p = pv({ id: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', protocol: 'openai' })
    const raw = Buffer.from(
      JSON.stringify({
        model: 'wb-sonnet',
        system: [{ type: 'text', text: '你是助手' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        max_tokens: 16
      })
    )
    const req = buildUpstreamRequest(p, 'agnes-2.0-flash', raw)
    expect(req.path).toBe('/chat/completions')
    const body = JSON.parse(req.body.toString())
    expect(body.model).toBe('agnes-2.0-flash')
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('openai 上游：工具定义与 tool_choice 映射（CLI 每次都带工具，缺了这层端点不可用）', () => {
    const p = pv({ id: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', protocol: 'openai' })
    const req = buildUpstreamRequest(
      p,
      'agnes-2.0-flash',
      Buffer.from(
        JSON.stringify({
          tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }],
          tool_choice: { type: 'tool', name: 'Read' }
        })
      )
    )
    const body = JSON.parse(req.body.toString())
    expect(body.tools[0].type).toBe('function')
    expect(body.tools[0].function.name).toBe('Read')
    expect(body.tools[0].function.parameters.properties.p).toBeDefined()
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } })
    expect(req.unsupported).toBeUndefined()
  })

  it('openai 上游：assistant tool_use 与 user tool_result 映射', () => {
    const p = pv({ id: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', protocol: 'openai' })
    const req = buildUpstreamRequest(
      p,
      'agnes-2.0-flash',
      Buffer.from(
        JSON.stringify({
          messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { p: 'a.txt' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] }
          ]
        })
      )
    )
    const body = JSON.parse(req.body.toString())
    expect(body.messages[0].tool_calls[0]).toMatchObject({ id: 'tu_1', function: { name: 'Read' } })
    expect(JSON.parse(body.messages[0].tool_calls[0].function.arguments)).toEqual({ p: 'a.txt' })
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: 'file body' })
  })

  it('openai 响应带 tool_calls 转成 Anthropic tool_use 块', () => {
    const p = pv({ id: 'agnes', baseUrl: 'https://x/v1', protocol: 'openai' })
    const out = translateResponse(p, 'agnes-2.0-flash', {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }]
          },
          finish_reason: 'tool_calls'
        }
      ]
    }) as { content: { type: string; name?: string; input?: unknown }[]; stop_reason: string }
    expect(out.content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Bash' })
    expect(out.content[0].input).toEqual({ cmd: 'ls' })
    expect(out.stop_reason).toBe('tool_use')
  })

  it('openai 非流式响应转成 Anthropic 信封', () => {
    const p = pv({ id: 'agnes', baseUrl: 'https://x/v1', protocol: 'openai' })
    const out = translateResponse(p, 'agnes-2.0-flash', {
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 }
    }) as { content: { type: string; text: string }[]; stop_reason: string }
    expect(out.content[0].text).toBe('OK')
    expect(out.stop_reason).toBe('end_turn')
  })

  it('openai 流式 SSE 翻译成 Anthropic 事件流', () => {
    const t = new OpenAiStreamTranslator('agnes-2.0-flash')
    const out: string[] = []
    out.push(t.push(Buffer.from('data: {"choices":[{"delta":{"content":"SMOKE"}}]}\n\n')).toString())
    out.push(t.push(Buffer.from('data: {"choices":[{"delta":{"content":"-OK"}}]}\n\n')).toString())
    out.push(t.push(Buffer.from('data: {"choices":[{"finish_reason":"stop"}]}\n\n')).toString())
    out.push(t.end().toString())
    const all = out.join('')
    expect(all).toContain('event: message_start')
    expect(all).toContain('"type":"text_delta","text":"SMOKE"')
    expect(all).toContain('"text":"-OK"')
    expect(all).toContain('event: message_stop')
  })

  it('openai 流式工具调用翻译成 input_json_delta 序列', () => {
    const t = new OpenAiStreamTranslator('agnes-2.0-flash')
    const all =
      t.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"Bash","arguments":"{\\"cm"}}]}}]}\n\n')).toString() +
      t.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"d\\":\\"ls\\"}"}}]}}]}\n\n')).toString() +
      t.push(Buffer.from('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n')).toString() +
      t.end().toString()
    expect(all).toContain('"content_block":{"type":"tool_use","id":"call_9","name":"Bash"')
    expect(all).toContain('"partial_json":"{\\"cm"')
    expect(all).toContain('"partial_json":"d\\":\\"ls\\"}"')
    expect(all).toContain('"stop_reason":"tool_use"')
    expect(all).toContain('event: message_stop')
  })

  it('缺省 protocol 按 anthropic 处理（v2 旧配置兼容）', () => {
    expect(protocolOf(pv({ id: 'legacy', baseUrl: 'https://x' }))).toBe('anthropic')
    expect(PROTOCOL_SPECS.anthropic.supportsTools).toBe(true)
    expect(PROTOCOL_SPECS.openai.supportsTools).toBe(true)
  })
})
