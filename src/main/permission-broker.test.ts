import { describe, expect, it } from 'vitest'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { PermissionBroker } from './permission-broker'
import type { PermissionRequestView } from '../shared/types'

function makeBroker(timeoutMs = 1000): {
  broker: PermissionBroker
  view: () => PermissionRequestView | undefined
} {
  let captured: PermissionRequestView | undefined
  const broker = new PermissionBroker(
    (v) => {
      captured = v
    },
    () => true,
    timeoutMs
  )
  return { broker, view: () => captured }
}

function fakeOptions(extra: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tu_1',
    requestId: 'rq_1',
    ...extra
  } as never
}

describe('权限确认弹窗', () => {
  it('无窗口时一律拒绝（绝不静默放行）', async () => {
    const broker = new PermissionBroker(() => {}, () => false, 1000)
    const res = await broker.handler('Bash', { command: 'rm -rf /' }, fakeOptions())
    expect(res!.behavior).toBe('deny')
  })

  it('Bash 摘要取 command 字段', async () => {
    const { broker, view } = makeBroker()
    const p = broker.handler('Bash', { command: 'npm run build' }, fakeOptions())
    expect(view()?.summary).toContain('npm run build')
    broker.respond(view()!.id, { allow: true, remember: false })
    expect((await p)!.behavior).toBe('allow')
  })

  it('Read 摘要取 file_path', async () => {
    const { broker, view } = makeBroker()
    const p = broker.handler('Read', { file_path: '/etc/passwd' }, fakeOptions())
    expect(view()?.summary).toContain('/etc/passwd')
    broker.respond(view()!.id, { allow: true, remember: false })
    await p
  })

  it('拒绝返回 deny', async () => {
    const { broker, view } = makeBroker()
    const p = broker.handler('Write', { file_path: 'a.txt' }, fakeOptions())
    broker.respond(view()!.id, { allow: false, remember: false })
    expect((await p)!.behavior).toBe('deny')
  })

  it('记住：回传 updatedPermissions', async () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: '*' }], behavior: 'allow', destination: 'session' }
    ] as never
    const { broker, view } = makeBroker()
    const p = broker.handler('Bash', { command: 'ls' }, fakeOptions({ suggestions }))
    broker.respond(view()!.id, { allow: true, remember: true })
    const res = (await p) as PermissionResult
    expect(res.behavior).toBe('allow')
    const allow = res as { updatedPermissions?: unknown[] }
    expect(allow.updatedPermissions).toBeDefined()
    expect(allow.updatedPermissions!.length).toBe(1)
  })

  it('超时自动拒绝', async () => {
    const { broker } = makeBroker(40)
    const res = await broker.handler('Bash', { command: 'x' }, fakeOptions())
    expect(res!.behavior).toBe('deny')
  })

  it('abort 信号立即拒绝并清理', async () => {
    const { broker, view } = makeBroker(5000)
    const ac = new AbortController()
    const p = broker.handler('Bash', { command: 'x' }, fakeOptions({ signal: ac.signal }))
    ac.abort()
    const res = await p
    expect(res!.behavior).toBe('deny')
    // 已清理：再次 respond 无效
    expect(broker.respond(view()!.id, { allow: true, remember: false })).toBe(false)
  })
})
