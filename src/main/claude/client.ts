import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeExecutable } from './executable'
import type { EnvMap } from '../core/host-config'
import {
  DEFAULT_FALLBACK_CHAIN,
  TIER_ALIASES,
  type ModelTier
} from '../../shared/types'

export type { PermissionMode }

export interface RouterEndpoint {
  baseUrl: string
  localToken: string
}

export interface ClaudeRunOptions {
  /** env 覆盖项（调用方只放覆盖值；process.env 由 mergeEnv 合并） */
  env?: EnvMap
  cwd?: string
  maxTurns?: number
  /** 起始档位（默认 sonnet）；CLI 侧表现为虚拟别名 */
  tier?: ModelTier
  /** CLI 原生降级链（逗号分隔），默认 wb-sonnet,wb-haiku */
  fallbackChain?: string
  resume?: string
  forkSession?: boolean
  permissionMode?: PermissionMode
  abortController?: AbortController
  canUseTool?: CanUseTool
  additionalDirectories?: string[]
}

export interface ClaudeRunResult {
  text: string
  sessionId: string | null
  numTurns: number | null
  costUsd: number | null
  durationMs: number | null
  isError: boolean
  errorSubtype: string | null
  rawMessages: SDKMessage[]
}

/**
 * 合并 process.env 与覆盖项。
 * SDK Options.env 为整体替换语义（见 sdk.d.ts），漏 spread process.env 会导致
 * 子进程缺 PATH/SystemRoot 等直接崩——这是本项目的实现第一坑。
 */
export function mergeEnv(overrides?: EnvMap): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  if (overrides) Object.assign(env, overrides)
  return env
}

/**
 * spawn 前把 cwd 变成「一定存在」的目录。
 *
 * 2026-10-17 实测根因：cwd 不存在时 Node 的 spawn 直接抛 ENOENT，
 * 而 SDK 捕获 spawn 错误后只判断 existsSync(claude.exe) 为真，
 * 于是抛出「二进制与本机 libc 不匹配」的误导文案（本机 libc 根本没问题）。
 * 工作区目录（Documents\ClaudeWorkbench\workspace）此前从未被创建，
 * 导致每次对话都启动失败。
 *
 * 策略：优先用调用方给的目录（顺手创建），失败则依次退到用户目录 → 临时目录 → 进程 cwd。
 */
export function resolveCwd(raw?: string, fallbacks: string[] = []): string {
  const candidates = [raw?.trim(), ...fallbacks].filter((x): x is string => !!x)
  for (const c of candidates) {
    try {
      const abs = path.resolve(c)
      fs.mkdirSync(abs, { recursive: true })
      if (fs.statSync(abs).isDirectory()) return abs
    } catch {
      /* 试下一个候选 */
    }
  }
  return process.cwd()
}

/**
 * SDK 会把 spawn 失败包装成「exists but failed to launch …libc」这种
 * 与真实原因无关的文案。这里把底层错误码补回消息，避免下次再被误导。
 */
export function describeLaunchFailure(err: unknown): unknown {
  const e = err as { message?: string; code?: string; cause?: { code?: string } } | null
  if (typeof e?.message !== 'string') return err
  if (!/exists but failed to launch/i.test(e.message)) return err
  const code = e.cause?.code ?? e.code
  const hint =
    code === 'ENOENT'
      ? '真实原因：spawn ENOENT——通常是工作目录(cwd)不存在或路径不可用'
      : code
        ? `真实原因：spawn ${code}`
        : '真实原因：spawn 失败（无底层错误码）'
  if (!e.message.includes('真实原因')) e.message = `${e.message}｜${hint}`
  return err
}

/** 迭代 SDK 消息流；spawn 失败时把真实原因补进错误消息（见 describeLaunchFailure） */
async function* iterate(q: AsyncIterable<SDKMessage>): AsyncGenerator<SDKMessage> {
  try {
    for await (const msg of q) yield msg
  } catch (err) {
    throw describeLaunchFailure(err)
  }
}

/** 构造指向内部路由站的 CLI env（模型名一律用虚拟别名，真实模型由路由站解析） */
export function buildCliEnvOverrides(router: RouterEndpoint, opts: { tier?: ModelTier } = {}): EnvMap {
  const tier = opts.tier ?? 'sonnet'
  // 代理环境下必须让 localhost 回环 bypass 代理，否则 CLI→路由站一跳被代理劫持
  const existingNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ''
  const noProxy = existingNoProxy ? `${existingNoProxy},127.0.0.1,localhost` : '127.0.0.1,localhost'
  return {
    ANTHROPIC_BASE_URL: router.baseUrl,
    ANTHROPIC_AUTH_TOKEN: router.localToken,
    ANTHROPIC_MODEL: TIER_ALIASES[tier],
    ANTHROPIC_DEFAULT_OPUS_MODEL: TIER_ALIASES.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: TIER_ALIASES.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: TIER_ALIASES.haiku,
    // 子代理走低档位，控制成本
    CLAUDE_CODE_SUBAGENT_MODEL: TIER_ALIASES.haiku,
    // Windows 工作台：Bash 工具在目标机不可靠
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy
  }
}

/** 流式回调：文本增量 / 工具调用提示 / 结束 */
export interface StreamHandlers {
  onDelta?: (text: string) => void
  onTool?: (name: string) => void
  onSession?: (id: string) => void
}

/**
 * 流式执行：在 runPrompt 基础上把 assistant 文本增量回调出去。
 * 与 runPrompt 共用 options 构造，保证两条路径行为一致。
 */
export async function runPromptStream(
  prompt: string,
  opts: ClaudeRunOptions = {},
  handlers: StreamHandlers = {}
): Promise<ClaudeRunResult> {
  const options = buildOptions(opts)
  const q = query({ prompt, options })

  let text = ''
  let sessionId: string | null = null
  let numTurns: number | null = null
  let costUsd: number | null = null
  let durationMs: number | null = null
  let isError = false
  let errorSubtype: string | null = null
  const rawMessages: SDKMessage[] = []

  for await (const msg of iterate(q)) {
    rawMessages.push(msg)
    if ('session_id' in msg && typeof msg.session_id === 'string' && !sessionId) {
      sessionId = msg.session_id
      handlers.onSession?.(sessionId)
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          text += block.text
          handlers.onDelta?.(block.text)
        } else if (block.type === 'tool_use') {
          handlers.onTool?.(block.name)
        }
      }
    } else if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        numTurns = msg.num_turns
        costUsd = msg.total_cost_usd
        durationMs = msg.duration_ms
        if (typeof msg.result === 'string' && msg.result.trim() && msg.result !== text) {
          const extra = msg.result
          text = extra
          handlers.onDelta?.(`\n${extra}`)
        }
      } else {
        isError = true
        errorSubtype = msg.subtype
        numTurns = msg.num_turns
        costUsd = msg.total_cost_usd
        durationMs = msg.duration_ms
      }
    }
  }

  return { text, sessionId, numTurns, costUsd, durationMs, isError, errorSubtype, rawMessages }
}

function buildOptions(opts: ClaudeRunOptions): Options {
  return {
    pathToClaudeCodeExecutable: resolveClaudeExecutable(),
    // cwd 必须真实存在，否则 spawn 直接 ENOENT（见 resolveCwd 注释）
    cwd: resolveCwd(opts.cwd, [os.homedir(), os.tmpdir()]),
    env: mergeEnv(opts.env),
    maxTurns: opts.maxTurns,
    resume: opts.resume,
    forkSession: opts.forkSession,
    permissionMode: opts.permissionMode,
    abortController: opts.abortController,
    canUseTool: opts.canUseTool,
    additionalDirectories: opts.additionalDirectories,
    fallbackModel: opts.fallbackChain ?? DEFAULT_FALLBACK_CHAIN.join(','),
    settingSources: []
  }
}

export async function runPrompt(prompt: string, opts: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
  const options = buildOptions(opts)
  const q = query({ prompt, options })

  let text = ''
  let sessionId: string | null = null
  let numTurns: number | null = null
  let costUsd: number | null = null
  let durationMs: number | null = null
  let isError = false
  let errorSubtype: string | null = null
  const rawMessages: SDKMessage[] = []

  for await (const msg of iterate(q)) {
    rawMessages.push(msg)
    if ('session_id' in msg && typeof msg.session_id === 'string' && !sessionId) {
      sessionId = msg.session_id
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') text += block.text
      }
    } else if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        numTurns = msg.num_turns
        costUsd = msg.total_cost_usd
        durationMs = msg.duration_ms
        if (typeof msg.result === 'string' && msg.result.trim()) text = msg.result
      } else {
        isError = true
        errorSubtype = msg.subtype
        numTurns = msg.num_turns
        costUsd = msg.total_cost_usd
        durationMs = msg.duration_ms
      }
    }
  }

  return { text, sessionId, numTurns, costUsd, durationMs, isError, errorSubtype, rawMessages }
}
