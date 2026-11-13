/**
 * 任务执行器双通道分派测试（v0.3.0）。
 *
 * 只测分派与边界，不依赖 electron / SDK：agentRunner 与 textRunner 全部注入假实现。
 * 重点覆盖：
 * - 旧任务（mode 缺失）必须走 text，行为与 M2 一致
 * - agent 通道的参数透传（resume / permissionMode / cwd / maxTurns / canUseTool）
 * - sessionId 回写（resume 能力）
 * - isError / abort 必须 reject，让 runner 走重试或取消
 */
import { describe, expect, it, vi } from 'vitest'
import { createTaskExecutor, type AgentRunner, type TextRunner } from './taskExecutor'
import { createTaskRecord, normalizeTask } from './taskStore'
import type { TaskRecord } from '../../shared/types'

const buildTask = (over: Partial<TaskRecord> = {}): TaskRecord => {
  const t = createTaskRecord({ prompt: 'hello', tier: 'sonnet' })
  return { ...t, ...over }
}

const noopCanUseTool = (async () => ({ behavior: 'allow' })) as never

function makeExecutor(over: {
  text?: TextRunner
  agent?: AgentRunner
  onSessionId?: (t: TaskRecord, id: string) => void
} = {}) {
  const textRunner =
    over.text ??
    (vi.fn(async () => 'text-out') as unknown as TextRunner)
  const agentRunner =
    over.agent ??
    (vi.fn(async () => ({
      text: 'agent-out',
      sessionId: 'sess-1',
      isError: false,
      errorSubtype: null,
      numTurns: 3
    })) as unknown as AgentRunner)
  const executor = createTaskExecutor({
    textRunner,
    agentRunner,
    canUseTool: noopCanUseTool as never,
    defaultCwd: () => 'C:/default-ws',
    onSessionId: over.onSessionId
  })
  return { executor, textRunner, agentRunner }
}

const ac = () => new AbortController()

describe('createTaskExecutor · text 通道', () => {
  it('mode 缺失（旧记录）走 text，参数与 M2 一致', async () => {
    const task = buildTask()
    delete task.mode
    const { executor, textRunner, agentRunner } = makeExecutor()

    const out = await executor(task, ac().signal)

    expect(out).toBe('text-out')
    expect(agentRunner).not.toHaveBeenCalled()
    expect(textRunner).toHaveBeenCalledTimes(1)
    expect(vi.mocked(textRunner).mock.calls[0][0]).toMatchObject({
      prompt: 'hello',
      tier: 'sonnet',
      maxTokens: 4096
    })
  })

  it('mode=text 显式走 text', async () => {
    const { executor, agentRunner } = makeExecutor()
    await executor(buildTask({ mode: 'text' }), ac().signal)
    expect(agentRunner).not.toHaveBeenCalled()
  })

  it('text 通道不传 permissionMode / maxTurns（与旧行为一致）', async () => {
    const { executor, textRunner } = makeExecutor()
    await executor(buildTask({ mode: 'text' }), ac().signal)
    const arg = vi.mocked(textRunner).mock.calls[0][0]
    expect(arg).not.toHaveProperty('permissionMode')
    expect(arg).not.toHaveProperty('maxTurns')
  })
})

describe('createTaskExecutor · agent 通道', () => {
  it('走 agentRunner 并透传默认参数', async () => {
    const { executor, agentRunner, textRunner } = makeExecutor()
    const task = buildTask({ mode: 'agent', permissionMode: 'default', maxTurns: 20 })

    const out = await executor(task, ac().signal)

    expect(out).toBe('agent-out')
    expect(textRunner).not.toHaveBeenCalled()
    const [prompt, opts] = vi.mocked(agentRunner).mock.calls[0]
    expect(prompt).toBe('hello')
    expect(opts).toMatchObject({
      cwd: 'C:/default-ws',
      maxTurns: 20,
      tier: 'sonnet',
      resume: undefined,
      permissionMode: 'default'
    })
    expect(opts.canUseTool).toBe(noopCanUseTool)
    expect(opts.abortController).toBeInstanceOf(AbortController)
  })

  it('cwd 优先取任务自带值', async () => {
    const { executor, agentRunner } = makeExecutor()
    await executor(buildTask({ mode: 'agent', cwd: 'D:/proj' }), ac().signal)
    expect(vi.mocked(agentRunner).mock.calls[0][1].cwd).toBe('D:/proj')
  })

  it('已有 cliSessionId 时作为 resume 传入（续接同一 CLI 会话）', async () => {
    const { executor, agentRunner } = makeExecutor()
    await executor(buildTask({ mode: 'agent', cliSessionId: 'cli-abc' }), ac().signal)
    expect(vi.mocked(agentRunner).mock.calls[0][1].resume).toBe('cli-abc')
  })

  it('maxTurns 非法值兜底为 20', async () => {
    const { executor, agentRunner } = makeExecutor()
    await executor(buildTask({ mode: 'agent', maxTurns: 0 }), ac().signal)
    expect(vi.mocked(agentRunner).mock.calls[0][1].maxTurns).toBe(20)
  })

  it('返回的 sessionId 回写任务记录并可回调持久化', async () => {
    const seen: Array<[string, string]> = []
    const { executor } = makeExecutor({
      onSessionId: (t, id) => seen.push([t.id, id])
    })
    const task = buildTask({ mode: 'agent' })

    await executor(task, ac().signal)

    expect(seen).toEqual([[task.id, 'sess-1']])
  })

  it('无 onSessionId 时直接写 task.cliSessionId', async () => {
    const { executor } = makeExecutor()
    const task = buildTask({ mode: 'agent' })
    await executor(task, ac().signal)
    expect(task.cliSessionId).toBe('sess-1')
  })

  it('isError 必须 reject（让 runner 走重试/失败）', async () => {
    const { executor } = makeExecutor({
      agent: async () => ({
        text: 'boom',
        sessionId: 's',
        isError: true,
        errorSubtype: 'error_max_turns',
        numTurns: 20
      })
    })
    await expect(executor(buildTask({ mode: 'agent' }), ac().signal)).rejects.toThrow(
      /agent 执行失败（error_max_turns）/
    )
  })

  it('signal 已 abort 时立即抛 AbortError，不启动 CLI', async () => {
    const { executor, agentRunner } = makeExecutor()
    const c = ac()
    c.abort()
    await expect(executor(buildTask({ mode: 'agent' }), c.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(agentRunner).not.toHaveBeenCalled()
  })

  it('执行中途 abort 时抛 AbortError（而非把半截输出当成功）', async () => {
    const c = ac()
    const { executor } = makeExecutor({
      agent: async () => {
        c.abort() // 执行期间用户点了取消
        return { text: 'partial', sessionId: 's', isError: false, errorSubtype: null, numTurns: 1 }
      }
    })
    await expect(executor(buildTask({ mode: 'agent' }), c.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

describe('normalizeTask · 旧记录兼容', () => {
  it('mode 缺失读作 text，并补齐 cliSessionId', () => {
    const t = buildTask()
    delete t.mode
    delete t.cliSessionId
    normalizeTask(t)
    expect(t.mode).toBe('text')
    expect(t.cliSessionId).toBeNull()
  })

  it('agent 记录补齐 permissionMode / maxTurns / cwd', () => {
    const t = buildTask({ mode: 'agent' })
    delete t.permissionMode
    delete t.maxTurns
    delete t.cwd
    normalizeTask(t)
    expect(t.permissionMode).toBe('default')
    expect(t.maxTurns).toBe(20)
    expect(t.cwd).toBeNull()
  })

  it('非法 mode 值归一为 text', () => {
    const t = buildTask()
    t.mode = 'weird' as never
    normalizeTask(t)
    expect(t.mode).toBe('text')
  })
})

describe('createTaskRecord · 通道缺省值', () => {
  it('不传 mode 时为 text，且不带 agent 专属字段', () => {
    const t = createTaskRecord({ prompt: 'p' })
    expect(t.mode).toBe('text')
    expect(t.cliSessionId).toBeNull()
    expect(t.permissionMode).toBeUndefined()
    expect(t.maxTurns).toBeUndefined()
    expect(t.cwd).toBeNull()
  })

  it('mode=agent 时带默认 permissionMode/maxTurns', () => {
    const t = createTaskRecord({ prompt: 'p', mode: 'agent' })
    expect(t.mode).toBe('agent')
    expect(t.permissionMode).toBe('default')
    expect(t.maxTurns).toBe(20)
    expect(t.cwd).toBeNull()
  })

  it('agent 显式权限模式与轮次被保留', () => {
    const t = createTaskRecord({ prompt: 'p', mode: 'agent', permissionMode: 'acceptEdits', maxTurns: 5, cwd: 'D:/x' })
    expect(t.permissionMode).toBe('acceptEdits')
    expect(t.maxTurns).toBe(5)
    expect(t.cwd).toBe('D:/x')
  })
})
