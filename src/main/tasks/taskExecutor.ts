/**
 * 任务执行器（M2 → v0.3.0 双通道）。
 *
 * M2 只有一条通道：直连本地路由站 /v1/messages 做单次问答（快、省、无人值守）。
 * v0.3.0 增加 agent 通道：走 claude CLI，可调工具、有可视化权限闸门、支持 resume，
 * 从而支持「派活式」任务（让 agent 实际去读文件 / 跑命令 / 改代码）。
 *
 * 设计取舍（为什么保留两条通道而不是全切 agent）：
 * - text 通道无 CLI 冷启动（实测 3–10s），批量生成类任务成本低一个数量级；
 * - agent 通道每任务起一个 CLI 子进程，但换来工具能力与多轮循环；
 * - 旧任务/旧配置无需迁移：mode 缺失一律按 'text' 读，行为与 M2 完全一致。
 *
 * 安全边界：
 * - agent 通道的工具调用一律经 canUseTool（生产注入 PermissionBroker）；
 *   无渲染窗口时 Broker 自动拒绝，绝不静默放行；
 * - permissionMode 由用户显式选择，默认 'default'（每次问）。
 */
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { ModelTier, PermissionMode, TaskRecord } from '../../shared/types'
import type { TaskExecutor } from './taskRunner'

/** text 通道执行器：返回最终文本，失败必须 reject */
export type TextRunner = (opts: {
  prompt: string
  tier: ModelTier
  maxTokens?: number
  signal: AbortSignal
}) => Promise<string>

/** agent 通道执行器（生产环境为 runPrompt，单测注入假实现，不依赖 SDK）。
 *  env 由生产实现自行构建（需先起路由站拿到 baseUrl），本层不关心。 */
export type AgentRunner = (
  prompt: string,
  opts: {
    cwd?: string
    maxTurns?: number
    tier?: ModelTier
    resume?: string
    permissionMode?: PermissionMode
    abortController?: AbortController
    canUseTool?: CanUseTool
  }
) => Promise<{
  text: string
  sessionId: string | null
  isError: boolean
  errorSubtype: string | null
  numTurns: number | null
}>

export interface TaskExecutorDeps {
  textRunner: TextRunner
  agentRunner: AgentRunner
  /** agent 通道的工具权限闸门（生产：PermissionBroker.handler） */
  canUseTool: CanUseTool
  /** agent 通道默认工作目录（缺省用 workspace.defaultDir） */
  defaultCwd: () => string
  /** 拿到 CLI sessionId 时回调（用于把 resume 能力持久化到任务记录） */
  onSessionId?: (task: TaskRecord, sessionId: string) => void
}

/** 把 AbortSignal 桥接到 AbortController（SDK 只认 controller） */
function bridgeAbort(signal: AbortSignal): AbortController {
  const ac = new AbortController()
  if (signal.aborted) {
    ac.abort()
    return ac
  }
  signal.addEventListener('abort', () => ac.abort(), { once: true })
  return ac
}

export function createTaskExecutor(deps: TaskExecutorDeps): TaskExecutor {
  const { textRunner, agentRunner, canUseTool, defaultCwd, onSessionId } = deps

  return async (task, signal) => {
    // ── agent 通道：CLI 多轮工具循环 ──
    if (task.mode === 'agent') {
      if (signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })

      const cwd = (task.cwd && task.cwd.trim()) || defaultCwd()
      const ac = bridgeAbort(signal)

      const r = await agentRunner(task.prompt, {
        cwd,
        maxTurns: task.maxTurns && task.maxTurns > 0 ? task.maxTurns : 20,
        tier: task.tier,
        resume: task.cliSessionId ?? undefined,
        permissionMode: task.permissionMode ?? 'default',
        abortController: ac,
        canUseTool
      })

      // 会话 id 落回任务记录：下次 retry / 后续任务可 resume 同一 CLI 会话
      if (r.sessionId && onSessionId) onSessionId(task, r.sessionId)
      else if (r.sessionId) task.cliSessionId = r.sessionId

      if (signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })

      if (r.isError) {
        const detail = r.errorSubtype ? `（${r.errorSubtype}）` : ''
        throw new Error(`agent 执行失败${detail}：${(r.text || '无输出').slice(0, 300)}`)
      }
      return r.text
    }

    // ── text 通道：直连路由站单次问答（M2 原行为，保持不变） ──
    return textRunner({
      prompt: task.prompt,
      tier: task.tier,
      maxTokens: task.maxTokens,
      signal
    })
  }
}
