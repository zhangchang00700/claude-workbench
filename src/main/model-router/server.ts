import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log'
import { activeProviders, getProviderKey, userDataDir, type AppConfig, type ProviderConfig } from '../core/config'
import {
  PROTOCOL_SPECS,
  TIER_ALIASES,
  normalizeBaseUrl,
  type ModelTier,
  type ProviderProtocol
} from '../../shared/types'
import { OpenAiStreamTranslator, buildUpstreamRequest, protocolOf, translateResponse } from './protocol'
import { classifyUpstream, detectSuccessBodyFailure, describeFailure } from './failure'

/**
 * 内部模型路由站。
 *
 * claude CLI 的 ANTHROPIC_BASE_URL 指向本服务（127.0.0.1），由本站：
 * 1. 将 CLI 的虚拟模型别名（wb-opus/wb-sonnet/wb-haiku）解析为各供应商真实模型名
 * 2. 按优先级在多供应商间转发 /v1/messages，失败自动故障转移
 * 3. 聚合 GET /v1/models（填入 key 后自动获取供应商模型列表）
 * 4. 健康熔断：连续失败自动冷却，到期半开恢复
 *
 * 降级两层：
 * - 供应商级（本站，对 CLI 透明）：同档位换供应商
 * - 模型级（CLI 原生）：options.fallbackModel / --fallback-model，别名驱动
 */

const TIER_OF_ALIAS: Record<string, ModelTier> = {
  [TIER_ALIASES.opus]: 'opus',
  [TIER_ALIASES.sonnet]: 'sonnet',
  [TIER_ALIASES.haiku]: 'haiku'
}

/** 档位降级顺序：请求档位无可用供应商时向下退化 */
const TIER_DEGRADE: Record<ModelTier, ModelTier[]> = {
  opus: ['sonnet', 'haiku'],
  sonnet: ['haiku'],
  haiku: []
}

/** 透传给客户端前，先窥探上游响应的窗口（字节上限 / 等待毫秒） */
const PEEK_MAX_BYTES = 8192
const PEEK_SETTLE_MS = 1500

/** 故障转移通知：谁挂了、切到谁、为什么（界面提示条用） */
export interface FailoverNotice {
  from: string
  fromName?: string
  to: string
  toName?: string
  reason: string
  reasonText: string
  attempts: { provider: string; error: string }[]
}

/**
 * 去掉 CLI 可能附加的上下文标记（如 wb-sonnet[1m]）。
 * 标记只影响 CLI 侧的上下文预算，路由站按档位解析，必须剥掉再匹配别名。
 */
function stripContextSuffix(model: string): string {
  return model.replace(/\[\d+[mk]\]$/i, '').trim()
}

interface ProviderHealth {
  consecutiveFailures: number
  openUntil: number
}

export interface ProviderProbeResult {
  ok: boolean
  status: number
  models: string[]
  error?: string
  ms: number
}

interface RouterEvent {
  ts: string
  kind: 'request' | 'route' | 'error' | 'health'
  provider?: string
  model?: string
  requestedModel?: string
  status?: number
  ms?: number
  /** 上游返回的输入 token（Anthropic input_tokens / OpenAI prompt_tokens），抓不到为省略 */
  inputTokens?: number
  /** 上游返回的输出 token（output_tokens / completion_tokens） */
  outputTokens?: number
  error?: string
  detail?: string
}

/**
 * 从响应体或 SSE 文本里提取 token 用量。
 * Claude Code 的对话是流式：Anthropic 在 message_start 给 input_tokens、
 * message_delta 给 output_tokens；OpenAI 在结尾 chunk 给 usage。抓不到就返回 0（不猜）。
 */
function extractUsage(text: string): { input: number; output: number } {
  const pick = (re: RegExp): number => {
    let last = 0
    for (const m of text.matchAll(re)) last = Number(m[1]) || last
    return last
  }
  const input = pick(/"input_tokens"\s*:\s*(\d+)/g) || pick(/"prompt_tokens"\s*:\s*(\d+)/g)
  const output = pick(/"output_tokens"\s*:\s*(\d+)/g) || pick(/"completion_tokens"\s*:\s*(\d+)/g)
  return { input, output }
}

export class ModelRouter {
  private server: http.Server | null = null
  private listenPort = 0
  private health = new Map<string, ProviderHealth>()
  private modelsCache: { at: number; data: unknown } | null = null
  private logStream: fs.WriteStream | null = null
  private logDate = ''

  private onFailover: ((n: FailoverNotice) => void) | null = null

  /** getConfig 每次请求实时求值：普通模式读盘（设置页改动即生效），冒烟模式传内存补丁配置 */
  constructor(private getConfig: () => AppConfig) {}

  /**
   * @param preferredPort 期望复用的端口（0 = 按配置/随机）。
   *   复用端口是硬要求：CLI 进程启动时把 baseUrl 写进 env，端口一变，
   *   正在跑的长会话后续请求就会打到死端口上（ECONNREFUSED）。
   */
  async start(preferredPort = 0): Promise<number> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        log.error('[router] unhandled', err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'router_internal_error', message: String(err) } }))
      })
    })
    const cfgPort = this.getConfig().router.port
    const desired = preferredPort || cfgPort
    try {
      await this.listen(desired)
    } catch (err) {
      // 端口被占（如 TIME_WAIT）：退到随机端口，绝不让启动失败
      if (desired === 0) throw err
      log.warn('[router] port %d unavailable (%s), falling back to %d', desired, String(err), cfgPort)
      await this.listen(cfgPort)
    }
    log.info('[router] listening on %s (port=%d)', this.baseUrl(), this.listenPort)
    return this.listenPort
  }

  private listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.removeListener('error', reject)
        const addr = this.server!.address()
        this.listenPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.logStream?.end()
    this.logStream = null
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.listenPort}`
  }

  port(): number {
    return this.listenPort
  }

  /** 配置变更后调用：配置是每次请求实时读的，只需让模型列表缓存失效 */
  invalidateModelsCache(): void {
    this.modelsCache = null
  }

  /** 注册故障转移回调（界面提示「X 挂了 → 已切 Y」） */
  setFailoverHandler(fn: (n: FailoverNotice) => void): void {
    this.onFailover = fn
  }

  // ---------- 健康状态 ----------

  private isHealthy(id: string): boolean {
    const h = this.health.get(id)
    if (!h) return true
    if (h.openUntil === 0) return true
    return Date.now() >= h.openUntil // 半开：冷却到期放行一次试探
  }

  private recordSuccess(id: string): void {
    this.health.set(id, { consecutiveFailures: 0, openUntil: 0 })
  }

  private recordFailure(id: string, reason: string): void {
    const cb = this.getConfig().router.circuitBreaker
    const prev = this.health.get(id) ?? { consecutiveFailures: 0, openUntil: 0 }
    const failures = prev.consecutiveFailures + 1
    const openUntil = failures >= cb.failureThreshold ? Date.now() + cb.cooldownMs : 0
    this.health.set(id, { consecutiveFailures: failures, openUntil })
    this.event({ kind: 'health', provider: id, error: reason, detail: `failures=${failures} openUntil=${openUntil}` })
  }

  // ---------- 模型解析 ----------

  /** 将请求的模型名（别名或具体名）解析为某供应商可用的真实模型名 */
  private resolveModel(pv: ProviderConfig, requested: string): string | null {
    const tier = TIER_OF_ALIAS[requested]
    if (tier) {
      return pv.models[tier] ?? pv.defaultModel ?? pv.models.sonnet ?? null
    }
    // 非别名：具体模型名原样透传（用户/CLI 直接指定）
    return requested
  }

  /** 候选供应商：enabled + 有 key + 健康，按优先级；请求档位无人服务时降级 */
  private candidates(cfg: AppConfig, requested: string): { pv: ProviderConfig; model: string }[] {
    const tier = TIER_OF_ALIAS[requested]
    const tiersToTry: (ModelTier | null)[] = tier ? [tier, ...TIER_DEGRADE[tier]] : [null]
    for (const t of tiersToTry) {
      const list: { pv: ProviderConfig; model: string }[] = []
      for (const pv of activeProviders(cfg)) {
        if (!this.isHealthy(pv.id)) continue
        const model = t ? (pv.models[t] ?? pv.defaultModel ?? null) : this.resolveModel(pv, requested)
        if (model) list.push({ pv, model })
      }
      if (list.length > 0) return list
    }
    return []
  }

  // ---------- HTTP 处理 ----------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/healthz') return this.handleHealthz(res)
    if (req.method === 'GET' && url.pathname === '/v1/models') return this.handleModels(res)
    if (req.method === 'POST' && url.pathname === '/v1/messages') return this.handleMessages(req, res)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'not_found', message: `${req.method} ${url.pathname}` } }))
  }

  private handleHealthz(res: ServerResponse): void {
    const providers = activeProviders(this.getConfig()).map((pv) => {
      const h = this.health.get(pv.id) ?? { consecutiveFailures: 0, openUntil: 0 }
      return {
        id: pv.id,
        healthy: this.isHealthy(pv.id),
        failures: h.consecutiveFailures,
        cooldownRemainingMs: Math.max(0, h.openUntil - Date.now())
      }
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, port: this.listenPort, providers }))
  }

  private async handleModels(res: ServerResponse): Promise<void> {
    const now = Date.now()
    if (this.modelsCache && now - this.modelsCache.at < 60000) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(this.modelsCache.data))
      return
    }
    const cfg = this.getConfig()
    const data: Record<string, unknown>[] = []
    await Promise.all(
      activeProviders(cfg).map(async (pv) => {
        try {
          const key = getProviderKey(pv)
          const r = await this.fetchUpstream(pv, key, 10000)
          if (r.status !== 200) return
          const body = r.body as { data?: { id?: string }[] }
          for (const m of body.data ?? []) {
            if (m?.id) data.push({ id: m.id, name: m.id, provider: pv.id, providerName: pv.name })
          }
        } catch (err) {
          this.event({ kind: 'error', provider: pv.id, error: 'models_fetch_failed', detail: String(err) })
        }
      })
    )
    const payload = { object: 'list', data }
    this.modelsCache = { at: now, data: payload }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  private async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = this.getConfig()
    const t0 = Date.now()

    // 1. 本地 token 校验（防同机其他进程盗用路由站）
    const auth = req.headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '')
    if (cfg.router.localToken && token !== cfg.router.localToken) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid local router token' } }))
      return
    }

    // 2. 读取并解析请求体（需改写 model 字段）
    const bodyBuf = await readBody(req)
    let body: { model?: string; stream?: boolean }
    try {
      body = JSON.parse(bodyBuf.toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'body is not valid JSON' } }))
      return
    }
    const requested = stripContextSuffix(body.model ?? TIER_ALIASES.sonnet)
    const isStream = body.stream === true

    // 3. 候选列表（含档位降级）
    const candidates = this.candidates(cfg, requested)
    if (candidates.length === 0) {
      this.event({
        kind: 'error',
        requestedModel: requested,
        error: 'no_available_provider',
        detail: 'all providers disabled, keyless, or circuit-open'
      })
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            type: 'router_no_provider',
            message:
              '没有可用供应商：请确认至少一家供应商 enabled 且已填写 API Key（设置页或 CW_PROVIDER_<ID>_API_KEY 环境变量）'
          }
        })
      )
      return
    }

    // 4. 逐个故障转移
    const attempts: { provider: string; model: string; error: string }[] = []
    for (const { pv, model } of candidates) {
      const outBody = Buffer.from(JSON.stringify({ ...body, model }), 'utf8')
      const outcome = await this.forwardOnce(pv, model, outBody, isStream, res, requested, t0)
      if (outcome === 'ok') {
        this.recordSuccess(pv.id)
        if (attempts.length > 0 && this.onFailover) {
          const first = attempts[0]
          const reason = first.error.replace(/^retry:/, '')
          this.onFailover({
            from: first.provider,
            fromName: cfg.providers.find((p) => p.id === first.provider)?.name,
            to: pv.id,
            toName: pv.name,
            reason,
            reasonText: describeFailure(reason),
            attempts: attempts.map((a) => ({ provider: a.provider, error: a.error }))
          })
        }
        return
      }
      attempts.push({ provider: pv.id, model, error: outcome })
      this.recordFailure(pv.id, outcome)
      if (outcome.startsWith('passthrough:')) return // 不可重试：响应已透传
    }

    // 5. 全部失败
    this.event({ kind: 'error', requestedModel: requested, error: 'all_providers_failed', detail: JSON.stringify(attempts) })
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'router_all_failed', message: '所有候选供应商均失败', attempts } }))
  }

  /**
   * 单次转发。返回值：
   * - 'ok'                  已开始向客户端写出（流式/非流式均接管 res）
   * - 'retry:<原因>'         可重试，未向客户端写任何字节
   * - 'passthrough:<状态码>' 不可重试，响应已透传给客户端
   */
  private forwardOnce(
    pv: ProviderConfig,
    model: string,
    body: Buffer,
    isStream: boolean,
    res: ServerResponse,
    requested: string,
    t0: number
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const cfg = this.getConfig()
      const key = getProviderKey(pv)
      let settled = false
      const done = (v: string): void => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }

      try {
        const protocol = protocolOf(pv)
        const built = buildUpstreamRequest(pv, model, body)
        if (built.unsupported) {
          // 该供应商无法服务本次请求（如 OpenAI 兼容端点收到工具调用）：跳下一家，不写入任何字节
          this.event({
            kind: 'route',
            provider: pv.id,
            model,
            requestedModel: requested,
            error: `skip:${built.unsupported}`
          })
          done(`retry:${built.unsupported}`)
          return
        }
        const base = normalizeBaseUrl(pv.baseUrl, protocol)
        const target = new URL(base + built.path)
        const transport = target.protocol === 'https:' ? https : http
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'content-length': String(built.body.length)
        }
        if (protocol === 'openai') {
          headers.authorization = `Bearer ${key}`
        } else {
          // 双协议头：Anthropic 官方用 x-api-key，国产兼容端点多认 Bearer
          headers['x-api-key'] = key
          headers.authorization = `Bearer ${key}`
        }
        if (isStream) headers.accept = 'text/event-stream'

        const upstreamReq = transport.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: 'POST',
            headers
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 0
            if (status !== 200) {
              // 非 200：读出错误体再判定——欠费/额度类常藏在 400/402 的正文里
              void readUpstreamBody(upstreamRes, 8192).then((raw) => {
                const verdict = classifyUpstream(status, raw, {
                  retryOn429: cfg.router.retryOn429,
                  providerId: pv.id
                })
                if (verdict.retry) {
                  this.event({
                    kind: 'route',
                    provider: pv.id,
                    model,
                    requestedModel: requested,
                    status,
                    ms: Date.now() - t0,
                    error: `retryable:${verdict.reason}`
                  })
                  done(`retry:${verdict.reason}`)
                  return
                }
                // 不可重试：把上游错误体读出来（openai 协议需转成 Anthropic 错误信封，否则 CLI 解析不了）
                const payload =
                  protocol === 'openai'
                    ? {
                        type: 'error',
                        error: {
                          type: 'api_error',
                          message: `upstream ${pv.id} HTTP ${status}: ${raw.slice(0, 500)}`
                        }
                      }
                    : raw
                const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
                res.writeHead(status, { 'content-type': 'application/json' })
                res.end(body)
                this.event({
                  kind: 'route',
                  provider: pv.id,
                  model,
                  requestedModel: requested,
                  status,
                  ms: Date.now() - t0,
                  error: `passthrough:${verdict.reason}`
                })
                done(`passthrough:${status}`)
              })
              return
            }

            // 200：先窥探首帧（上游常在 200 后才吐 error），确认没问题再透传
            void this.deliverSuccess(pv, model, upstreamRes, res, {
              isStream,
              protocol,
              requested,
              t0
            }).then(done)
          }
        )

        upstreamReq.setTimeout(cfg.router.timeoutMs, () => {
          upstreamReq.destroy(new Error(`upstream timeout after ${cfg.router.timeoutMs}ms`))
        })
        upstreamReq.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException).code ?? ''
          // 网络错误一律可重试（换供应商）；透传类在头阶段已处理
          this.event({
            kind: 'route',
            provider: pv.id,
            model,
            requestedModel: requested,
            ms: Date.now() - t0,
            error: `retryable_net:${code || err.message}`
          })
          done(`retry:net ${code || err.message}`)
        })

        res.on('close', () => {
          if (!res.writableEnded) upstreamReq.destroy(new Error('client disconnected'))
        })

        upstreamReq.write(built.body)
        upstreamReq.end()
      } catch (err) {
        // 同步异常（如 URL 非法）按可重试处理，绝不上抛炸掉 handler
        this.event({ kind: 'error', provider: pv.id, model, requestedModel: requested, error: `spawn:${String(err)}` })
        done(`retry:spawn ${String(err)}`)
      }
    })
  }

  /**
   * 200 响应的投递。
   *
   * 关键：先把响应头之后的第一批字节窥探下来再决定。上游（尤其国产厂商）常在
   * HTTP 200 之后立刻吐 error 事件（overloaded / rate_limit / 余额不足），
   * 一旦无脑 pipe，本次请求就永远钉死在这家，故障转移形同虚设。
   * 只要在窥探窗口内判定失败，此刻尚未向客户端写过任何字节，可以干净地换下一家。
   *
   * @returns 'ok' 已接管 res；'retry:<原因>' 未写任何字节，可换供应商
   */
  private async deliverSuccess(
    pv: ProviderConfig,
    model: string,
    upstream: IncomingMessage,
    res: ServerResponse,
    ctx: { isStream: boolean; protocol: ProviderProtocol; requested: string; t0: number }
  ): Promise<string> {
    const { isStream, protocol, requested, t0 } = ctx
    const peek = await peekUpstream(upstream, PEEK_MAX_BYTES, PEEK_SETTLE_MS)
    const prefix = Buffer.concat(peek.chunks)

    const failure = detectSuccessBodyFailure(prefix.toString('utf8'), isStream, pv.id)
    if (failure?.retry) {
      upstream.destroy()
      this.event({
        kind: 'route',
        provider: pv.id,
        model,
        requestedModel: requested,
        status: 200,
        ms: Date.now() - t0,
        error: `stream_failure:${failure.reason}`
      })
      return `retry:${failure.reason}`
    }
    if (failure) {
      // 客户端错误（如模型名不对）：换供应商没意义，原样透传让 CLI 拿到真实原因
      this.event({
        kind: 'route',
        provider: pv.id,
        model,
        requestedModel: requested,
        status: 200,
        ms: Date.now() - t0,
        error: `stream_client_fault:${failure.reason}`
      })
    }

    // 流式响应尾部累积（最多 20KB），结束时提取 usage；非流式直接解析整体
    let tail = ''
    const capture = (chunk: Buffer): void => {
      if (chunk.length === 0) return
      tail = (tail + chunk.toString('utf8')).slice(-20_000)
    }
    let captured = { input: 0, output: 0 }
    const usageFields = (): { inputTokens?: number; outputTokens?: number } =>
      captured.input > 0 || captured.output > 0
        ? { inputTokens: captured.input, outputTokens: captured.output }
        : {}

    const finishEvent = (): void => {
      this.event({
        kind: 'route',
        provider: pv.id,
        model,
        requestedModel: requested,
        status: 200,
        ms: Date.now() - t0,
        ...usageFields()
      })
    }

    if (protocol === 'openai') {
      res.writeHead(200, { 'content-type': isStream ? 'text/event-stream' : 'application/json' })
      if (isStream) {
        const translator = new OpenAiStreamTranslator(model)
        if (prefix.length > 0) {
          capture(prefix)
          const out = translator.push(prefix)
          if (out.length > 0) res.write(out)
        }
        if (peek.ended) {
          const tailOut = translator.end()
          if (tailOut.length > 0) res.write(tailOut)
          captured = extractUsage(tail)
          res.end()
          finishEvent()
          return 'ok'
        }
        upstream.on('data', (c: Buffer) => {
          capture(c)
          const out = translator.push(c)
          if (out.length > 0) res.write(out)
        })
        upstream.on('end', () => {
          const tailOut = translator.end()
          if (tailOut.length > 0) res.write(tailOut)
          captured = extractUsage(tail)
          res.end()
          finishEvent()
        })
        upstream.resume()
        return 'ok'
      }
      let raw = prefix.toString('utf8')
      if (!peek.ended) raw += await readUpstreamBody(upstream, 8 * 1024 * 1024)
      let upstreamJson: unknown = raw
      try {
        upstreamJson = JSON.parse(raw)
      } catch {
        /* 非 JSON：原样透传 */
      }
      captured = extractUsage(raw)
      res.end(JSON.stringify(translateResponse(pv, model, upstreamJson)))
      finishEvent()
      return 'ok'
    }

    const outHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k)) continue
      if (typeof v === 'string') outHeaders[k] = v
    }
    res.writeHead(200, outHeaders)
    if (prefix.length > 0) {
      capture(prefix)
      res.write(prefix)
    }
    if (peek.ended) {
      captured = extractUsage(tail)
      res.end()
      finishEvent()
      return 'ok'
    }
    upstream.on('data', capture)
    upstream.pipe(res)
    upstream.on('end', () => {
      captured = extractUsage(tail)
      finishEvent()
    })
    upstream.resume()
    return 'ok'
  }

  /**
   * 探测单个供应商：拉 /v1/models 验证 Key 与端点是否可用。
   * 设置页「测试连接」用；结果不写缓存（避免污染路由站的 models 缓存）。
   */
  async probeProvider(providerId: string): Promise<ProviderProbeResult> {
    const cfg = this.getConfig()
    const pv = cfg.providers.find((p) => p.id === providerId)
    if (!pv) return { ok: false, status: 0, models: [], error: '供应商不存在', ms: 0 }
    const key = getProviderKey(pv)
    if (!key) return { ok: false, status: 0, models: [], error: '未填写 API Key', ms: 0 }
    const t0 = Date.now()
    try {
      const r = await this.fetchUpstream(pv, key, 15000)
      const ms = Date.now() - t0
      if (r.status !== 200) {
        const detail = typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)
        const probeUrl =
          pv.modelsEndpoint?.trim() ??
          normalizeBaseUrl(pv.baseUrl, protocolOf(pv)) + PROTOCOL_SPECS[protocolOf(pv)].modelsPath
        return {
          ok: false,
          status: r.status,
          models: [],
          error: `HTTP ${r.status} ${detail}（请求地址 ${probeUrl}）`,
          ms
        }
      }
      const body = r.body as { data?: { id?: string }[] }
      const models = (body.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === 'string')
      return { ok: true, status: 200, models, ms }
    } catch (err) {
      return { ok: false, status: 0, models: [], error: String((err as Error)?.message ?? err), ms: Date.now() - t0 }
    }
  }

  /**
   * 拉取供应商模型列表。
   * pv.modelsEndpoint 有值时用绝对 URL + Bearer 鉴权（智谱/DeepSeek/Kimi 的
   * Anthropic 垫片不实现 /v1/models，模型列表只在原生 OpenAI 风格端点）；
   * 否则按协议默认路径（anthropic=/v1/models，openai=/models）。
   */
  private fetchUpstream(pv: ProviderConfig, key: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const protocol: ProviderProtocol = protocolOf(pv)
      const custom = pv.modelsEndpoint?.trim()
      const url = custom ?? normalizeBaseUrl(pv.baseUrl, protocol) + PROTOCOL_SPECS[protocol].modelsPath
      const target = new URL(url)
      const transport = target.protocol === 'https:' ? https : http
      // 自定义端点均为 OpenAI 风格 REST，只认 Bearer；协议默认端点沿用双头（国产兼容端点多认 Bearer）
      const headers: Record<string, string> = custom
        ? { authorization: `Bearer ${key}` }
        : protocol === 'openai'
          ? { authorization: `Bearer ${key}` }
          : { 'x-api-key': key, authorization: `Bearer ${key}` }
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method: 'GET',
          headers
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c as Buffer))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = text
            try {
              parsed = JSON.parse(text)
            } catch {
              /* 保留原文 */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        }
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      req.end()
    })
  }

  // ---------- 日志 ----------

  private event(e: Omit<RouterEvent, 'ts'>): void {
    const entry: RouterEvent = { ts: new Date().toISOString(), ...e }
    log.info('[router] %s %s %s', e.kind, e.provider ?? '', e.error ?? e.status ?? '')
    try {
      const date = entry.ts.slice(0, 10)
      if (date !== this.logDate) {
        this.logStream?.end()
        this.logDate = date
        const dir = path.join(userDataDir(), 'logs')
        fs.mkdirSync(dir, { recursive: true })
        this.logStream = fs.createWriteStream(path.join(dir, `router-${date}.jsonl`), { flags: 'a' })
      }
      this.logStream?.write(JSON.stringify(entry) + '\n')
    } catch {
      // 日志失败不影响路由
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 窥探上游响应的开头若干字节，随后暂停流，把已读内容交还调用方。
 *
 * 时序：
 * - 首字节未到 → 最多等 settleMs（正常请求的「思考时间」可能几秒，不能干等）
 * - 首字节到达 → 再给 TAIL_MS 的短窗口凑齐第一个 SSE 事件，之后立刻放行
 * 所以正常情况下首 token 只多等 ≤ TAIL_MS，异常情况下能在 1.5s 内抓到 error。
 */
function peekUpstream(
  res: IncomingMessage,
  maxBytes: number,
  settleMs: number
): Promise<{ chunks: Buffer[]; ended: boolean }> {
  const TAIL_MS = 250
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (ended: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      res.pause()
      res.removeListener('data', onData)
      res.removeListener('end', onEnd)
      res.removeListener('error', onErr)
      resolve({ chunks, ended })
    }
    const arm = (ms: number): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => finish(false), ms)
    }
    const onData = (c: Buffer): void => {
      chunks.push(c)
      size += c.length
      if (size >= maxBytes) {
        finish(false)
        return
      }
      arm(TAIL_MS)
    }
    const onEnd = (): void => finish(true)
    const onErr = (): void => finish(true)

    arm(settleMs)
    res.on('data', onData)
    res.on('end', onEnd)
    res.on('error', onErr)
  })
}

/** 读上游响应体（带上限，防止上游异常大响应拖死路由站） */
function readUpstreamBody(res: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    res.on('data', (c: Buffer) => {
      if (size + c.length > limitBytes) return
      chunks.push(c)
      size += c.length
    })
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}
