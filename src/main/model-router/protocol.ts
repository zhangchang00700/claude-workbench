/**
 * 协议适配层：CLI 侧恒定 Anthropic Messages，上游可能是 Anthropic 或 OpenAI 兼容。
 *
 * - anthropic：原样透传（路径 /v1/messages、/v1/models）
 * - openai   ：请求 Anthropic→OpenAI 转换，响应 OpenAI→Anthropic 转换（含流式 SSE 翻译）
 *
 * OpenAI 兼容侧做了什么：
 * - tools / tool_choice 双向映射，tool_use ↔ tool_calls（流式按 index 累积 arguments）
 * - 文本、system、tool_result 均做映射
 * - 不支持的：图片/文档块、预填充 assistant 前缀、prompt caching 字段（静默丢弃）
 *
 * 注意：claude CLI 每次请求都带工具定义，所以 OpenAI 兼容供应商若不支持工具调用会直接失败，
 * 失败按可重试处理并由路由站转移到下一家（不会让填了 Key 的供应商静默失效）。
 */
import crypto from 'node:crypto'
import { PROTOCOL_SPECS, type ProviderConfig, type ProviderProtocol } from '../../shared/types'

export function protocolOf(pv: ProviderConfig): ProviderProtocol {
  return pv.protocol === 'openai' ? 'openai' : 'anthropic'
}

export interface UpstreamRequest {
  path: string
  body: Buffer
  /** 该供应商无法服务本次请求（如 OpenAI 端点收到工具调用），调用方应跳到下一家 */
  unsupported?: string
}

interface AnthropicBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface AnthropicBody {
  model?: string
  messages?: { role?: string; content?: unknown }[]
  system?: unknown
  max_tokens?: number
  temperature?: number
  stream?: boolean
  tools?: { name?: string; description?: string; input_schema?: unknown }[]
  tool_choice?: { type?: string; name?: string }
  metadata?: unknown
  stop_sequences?: string[]
  top_p?: number
  thinking?: unknown
}

function flattenText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string }
        if (block?.type === 'text') return block.text ?? ''
        return ''
      })
      .join('')
  }
  return ''
}

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

/** Anthropic messages → OpenAI messages（含 tool_use / tool_result 映射） */
function buildOpenAiMessages(body: AnthropicBody): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  const sys = flattenSystem(body.system)
  if (sys) out.push({ role: 'system', content: sys })

  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (typeof m.content === 'string') {
      out.push({ role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) continue
    const blocks = m.content as AnthropicBlock[]
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '')
    const toolUses = blocks.filter((b) => b.type === 'tool_use')
    const toolResults = blocks.filter((b) => b.type === 'tool_result')

    if (toolUses.length > 0) {
      const text = texts.join('')
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((b) => ({
          id: b.id ?? `call_${crypto.randomBytes(6).toString('hex')}`,
          type: 'function' as const,
          function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) }
        }))
      })
      continue
    }
    if (toolResults.length > 0) {
      for (const b of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id ?? '',
          content: typeof b.content === 'string' ? b.content : flattenText(b.content)
        })
      }
      continue
    }
    out.push({ role, content: texts.join('') })
  }
  return out
}

function flattenSystem(system: unknown): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((b) => ((b as { type?: string; text?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('\n')
  }
  return ''
}

/** 构造上游请求体（按协议） */
export function buildUpstreamRequest(pv: ProviderConfig, model: string, raw: Buffer): UpstreamRequest {
  const protocol = protocolOf(pv)
  const spec = PROTOCOL_SPECS[protocol]
  if (protocol === 'anthropic') {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      parsed = {}
    }
    return { path: spec.messagesPath, body: Buffer.from(JSON.stringify({ ...parsed, model }), 'utf8') }
  }

  // ---- OpenAI 兼容：Anthropic → Chat Completions ----
  let body: AnthropicBody = {}
  try {
    body = JSON.parse(raw.toString('utf8')) as AnthropicBody
  } catch {
    body = {}
  }
  const out: Record<string, unknown> = {
    model,
    messages: buildOpenAiMessages(body),
    stream: body.stream === true,
    max_tokens: body.max_tokens ?? 8192
  }
  // 工具定义映射（CLI 每次都带工具，缺了这层 OpenAI 兼容端点无法正常工作）
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name as string,
          description: t.description ?? '',
          parameters: (t.input_schema as Record<string, unknown>) ?? { type: 'object', properties: {} }
        }
      }))
  }
  if (body.tool_choice) {
    const tc = body.tool_choice.type
    if (tc === 'tool') out.tool_choice = { type: 'function', function: { name: body.tool_choice.name ?? '' } }
    else if (tc === 'any') out.tool_choice = 'required'
    else if (tc === 'none') out.tool_choice = 'none'
    else out.tool_choice = 'auto'
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences
  return { path: spec.messagesPath, body: Buffer.from(JSON.stringify(out), 'utf8') }
}

function anthropicEnvelope(
  model: string,
  text: string,
  stopReason: string,
  inputTokens: number,
  outputTokens: number,
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]
) {
  return {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: content ?? [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }
}

function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'stop':
    default:
      return 'end_turn'
  }
}

/** 非流式响应转换：OpenAI → Anthropic（含 tool_calls → tool_use） */
export function translateResponse(pv: ProviderConfig, model: string, upstream: unknown): unknown {
  if (protocolOf(pv) === 'anthropic') return upstream
  const body = upstream as {
    choices?: {
      message?: {
        content?: string | null
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
      }
      finish_reason?: string
    }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const msg = body?.choices?.[0]?.message
  const content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] = []
  const text = msg?.content ?? ''
  if (text) content.push({ type: 'text', text })
  for (const call of msg?.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(call?.function?.arguments ?? '{}')
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: call?.id ?? `toolu_${crypto.randomBytes(6).toString('hex')}`, name: call?.function?.name ?? '', input })
  }
  return anthropicEnvelope(
    model,
    text,
    mapFinishReason(body?.choices?.[0]?.finish_reason),
    body?.usage?.prompt_tokens ?? 0,
    body?.usage?.completion_tokens ?? 0,
    content
  )
}

function sse(event: string, data: unknown): Buffer {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, 'utf8')
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string
  }[]
}

/**
 * 流式翻译器：把 OpenAI 的 SSE 逐块翻译成 Anthropic SSE 事件流。
 * 只在 openai 协议下使用；anthropic 协议仍是字节级 pipe。
 *
 * 块管理：Anthropic 要求 index 递增且每个块必须 stop，
 * 因此文本块惰性开启（有 delta 才开），工具块按上游 index 累积 arguments。
 */
export class OpenAiStreamTranslator {
  private buffer = ''
  private started = false
  private stopped = false
  private model: string
  private blockIndex = 0
  private openBlock: 'none' | 'text' | 'tool' = 'none'
  private toolIds = new Map<number, string>()

  constructor(model: string) {
    this.model = model
  }

  /** 喂入上游字节，返回应写给客户端的字节（可能为空 Buffer） */
  push(chunk: Buffer): Buffer {
    if (this.stopped) return Buffer.alloc(0)
    this.buffer += chunk.toString('utf8')
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    const out: Buffer[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        out.push(this.finish('end_turn'))
        continue
      }
      let parsed: OpenAiChunk | null = null
      try {
        parsed = JSON.parse(payload) as OpenAiChunk
      } catch {
        continue
      }
      const choice = parsed?.choices?.[0]
      if (!choice) continue
      if (!this.started) out.push(this.startMessage())

      const deltaText = choice.delta?.content
      if (deltaText) {
        if (this.openBlock !== 'text') {
          out.push(this.closeBlock())
          out.push(this.startTextBlock())
        }
        out.push(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex - 1,
            delta: { type: 'text_delta', text: deltaText }
          })
        )
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        const idx = call.index ?? 0
        if (!this.toolIds.has(idx)) {
          out.push(this.closeBlock())
          const id = call.id ?? `toolu_${crypto.randomBytes(6).toString('hex')}`
          this.toolIds.set(idx, id)
          out.push(
            sse('content_block_start', {
              type: 'content_block_start',
              index: this.blockIndex,
              content_block: { type: 'tool_use', id, name: call.function?.name ?? '', input: {} }
            })
          )
          this.blockIndex++
          this.openBlock = 'tool'
        }
        const args = call.function?.arguments
        if (args) {
          out.push(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: this.blockIndex - 1,
              delta: { type: 'input_json_delta', partial_json: args }
            })
          )
        }
      }

      const finish = choice.finish_reason
      if (finish) out.push(this.finish(mapFinishReason(finish)))
    }
    return out.length > 0 ? Buffer.concat(out) : Buffer.alloc(0)
  }

  /** 上游结束时调用：补发收尾事件（若尚未发过） */
  end(): Buffer {
    if (this.stopped) return Buffer.alloc(0)
    return this.finish('end_turn')
  }

  private startMessage(): Buffer {
    this.started = true
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
  }

  private startTextBlock(): Buffer {
    const buf = sse('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'text', text: '' }
    })
    this.blockIndex++
    this.openBlock = 'text'
    return buf
  }

  private closeBlock(): Buffer {
    if (this.openBlock === 'none') return Buffer.alloc(0)
    const buf = sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex - 1 })
    this.openBlock = 'none'
    return buf
  }

  private finish(reason: string): Buffer {
    if (this.stopped) return Buffer.alloc(0)
    this.stopped = true
    const parts: Buffer[] = []
    if (!this.started) parts.push(this.startMessage())
    parts.push(this.closeBlock())
    parts.push(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: 0 }
      })
    )
    parts.push(sse('message_stop', { type: 'message_stop' }))
    return Buffer.concat(parts)
  }
}
