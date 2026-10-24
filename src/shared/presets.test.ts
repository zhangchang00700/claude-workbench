import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, endpointUrl, normalizeBaseUrl } from './types'

describe('内置供应商预设完整性', () => {
  it('id 唯一且为非空连字符格式', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  it('priority 唯一', () => {
    const ps = BUILTIN_PRESETS.map((p) => p.priority)
    expect(new Set(ps).size).toBe(ps.length)
  })

  it('baseUrl 均为 https 且能拼出合法端点', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.baseUrl.startsWith('https://')).toBe(true)
      const messages = endpointUrl(p.baseUrl, p.protocol, 'messages')
      const models = p.modelsEndpoint ?? endpointUrl(p.baseUrl, p.protocol, 'models')
      for (const u of [messages, models]) {
        expect(() => new URL(u)).not.toThrow()
        expect(u).toMatch(/^https:\/\//)
      }
      // anthropic 端点必须是 /v1/messages 结尾；openai 必须是 /chat/completions 结尾
      expect(messages.endsWith(p.protocol === 'openai' ? '/chat/completions' : '/v1/messages')).toBe(true)
    }
  })

  it('三档模型名非空且都有官方出处 docUrl', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.models.opus, p.id).toBeTruthy()
      expect(p.models.sonnet, p.id).toBeTruthy()
      expect(p.models.haiku, p.id).toBeTruthy()
      expect(p.docUrl, p.id).toMatch(/^https:\/\//)
    }
  })

  it('normalizeBaseUrl 幂等：规范化两次结果一致（防预设写错后缀）', () => {
    for (const p of BUILTIN_PRESETS) {
      const once = normalizeBaseUrl(p.baseUrl, p.protocol)
      expect(normalizeBaseUrl(once, p.protocol), p.id).toBe(once)
    }
  })
})
