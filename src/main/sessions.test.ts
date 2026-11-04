import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendMessage,
  archiveSession,
  clearProject,
  createSession,
  getSession,
  initSessionsRoot,
  listSessions,
  removeSession,
  setCliSession,
  setSessionProject
} from './sessions'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sess-'))
  initSessionsRoot(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('会话存储层', () => {
  it('新建 + 追加消息 + 读取', async () => {
    const s = createSession('sonnet', '第一条指令')
    expect(s.id).toMatch(/^[0-9a-f]+$/)
    expect(s.messages.length).toBe(0)
    await appendMessage(s.id, { role: 'user', text: '第一条指令', ts: 1000 })
    await appendMessage(s.id, { role: 'assistant', text: '回复内容', ts: 2000 })
    const got = getSession(s.id)
    expect(got).not.toBeNull()
    expect(got!.messages.length).toBe(2)
    expect(got!.messages[0].role).toBe('user')
    expect(got!.messages[1].text).toBe('回复内容')
  })

  it('首条用户消息成为标题，助手消息刷新预览', async () => {
    const s = createSession('opus', '原始长文本应该被截断到四十字以内否则会太长')
    await appendMessage(s.id, { role: 'user', text: '原始长文本应该被截断到四十字以内否则会太长', ts: 1 })
    await appendMessage(s.id, { role: 'assistant', text: '这是预览摘要内容', ts: 2 })
    const meta = listSessions()[0]
    expect(meta.title.length).toBeLessThanOrEqual(40)
    expect(meta.preview).toContain('预览摘要')
    expect(meta.messageCount).toBe(2)
  })

  it('列表按 updatedAt 倒序', async () => {
    const a = createSession('sonnet', 'A')
    const b = createSession('sonnet', 'B')
    await appendMessage(a.id, { role: 'user', text: 'A', ts: 10 })
    await appendMessage(b.id, { role: 'user', text: 'B', ts: 20 })
    const ids = listSessions().map((s) => s.id)
    expect(ids[0]).toBe(b.id)
    expect(ids[1]).toBe(a.id)
  })

  it('记录底层 CLI session 用于续聊', async () => {
    const s = createSession('sonnet', 'hi')
    await setCliSession(s.id, 'cli-session-xyz')
    expect(getSession(s.id)!.cliSessionId).toBe('cli-session-xyz')
  })

  it('删除会话', async () => {
    const s = createSession('sonnet', 'x')
    expect(await removeSession(s.id)).toBe(true)
    expect(getSession(s.id)).toBeNull()
    expect(listSessions().length).toBe(0)
  })

  it('错误消息也落盘（isError）', async () => {
    const s = createSession('sonnet', 'q')
    await appendMessage(s.id, { role: 'assistant', text: 'boom', isError: true, ts: 5 })
    expect(getSession(s.id)!.messages[0].isError).toBe(true)
  })
})

describe('并发写入串行化（P0 竞态修复）', () => {
  it('同一 session 并发 append 10 条不丢消息且顺序正确', async () => {
    const s = createSession('sonnet', '并发测试')
    const tasks: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      tasks.push(appendMessage(s.id, { role: 'user', text: `msg-${i}`, ts: 1000 + i }))
    }
    await Promise.all(tasks)
    const got = getSession(s.id)
    expect(got).not.toBeNull()
    expect(got!.messages.length).toBe(10)
    const texts = got!.messages.map((m) => m.text)
    expect(texts).toEqual([
      'msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4',
      'msg-5', 'msg-6', 'msg-7', 'msg-8', 'msg-9'
    ])
  })

  it('并发 setCliSession 与 appendMessage 不互相覆盖', async () => {
    const s = createSession('sonnet', '混合并发')
    const tasks: Promise<unknown>[] = []
    for (let i = 0; i < 5; i++) {
      tasks.push(appendMessage(s.id, { role: 'user', text: `m-${i}`, ts: i + 1 }))
      tasks.push(setCliSession(s.id, `cli-${i}`))
    }
    await Promise.all(tasks)
    const got = getSession(s.id)
    expect(got!.messages.length).toBe(5)
    // 最后一次 setCliSession 的结果应被保留
    expect(got!.cliSessionId).toBe('cli-4')
  })
})

describe('会话归档 / 项目分组', () => {
  it('新建时归入项目；移出后为未分组', async () => {
    const a = createSession('sonnet', '项目内会话', 'p1')
    expect(a.projectId).toBe('p1')
    expect(listSessions()[0].projectId).toBe('p1')
    expect(await setSessionProject(a.id, null)).toBe(true)
    expect(getSession(a.id)!.projectId).toBeNull()
    expect(listSessions()[0].projectId).toBeNull()
  })

  it('归档只影响归属标记，不删数据；可取消归档', async () => {
    const s = createSession('sonnet', '待归档')
    await appendMessage(s.id, { role: 'user', text: 'hi', ts: 1 })
    expect(await archiveSession(s.id, true)).toBe(true)
    expect(listSessions()[0].archived).toBe(true)
    expect(getSession(s.id)!.messages).toHaveLength(1)
    expect(await archiveSession(s.id, false)).toBe(true)
    expect(listSessions()[0].archived).toBe(false)
  })

  it('删除项目时其下会话退回未分组（不连坐删除）', async () => {
    const a = createSession('sonnet', 'a', 'p1')
    const b = createSession('sonnet', 'b', 'p1')
    const c = createSession('sonnet', 'c', 'p2')
    expect(await clearProject('p1')).toBe(2)
    expect(getSession(a.id)!.projectId).toBeNull()
    expect(getSession(b.id)!.projectId).toBeNull()
    expect(getSession(c.id)!.projectId).toBe('p2')
  })

  it('旧记录缺字段时读成 null/false（升级兼容）', () => {
    const s = createSession('sonnet', 'old')
    const file = path.join(dir, 'sessions', `${s.id}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete raw.projectId
    delete raw.archived
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8')
    const meta = listSessions()[0]
    expect(meta.projectId).toBeNull()
    expect(meta.archived).toBe(false)
  })
})

/* ───────── qa 独立补测：并发边界回归（不采信实现方自验，另起视角压边界） ───────── */

describe('并发边界回归（qa）', () => {
  it('并发 20 条 append + 交错 setCliSession：全量保序、cliSessionId 取最后入队一次', async () => {
    const s = createSession('sonnet', '重并发')
    const tasks: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) {
      tasks.push(appendMessage(s.id, { role: 'user', text: `m-${i}`, ts: 1000 + i }))
      if (i % 4 === 0) tasks.push(setCliSession(s.id, `cli-${i}`))
    }
    await Promise.all(tasks)
    const got = getSession(s.id)
    expect(got).not.toBeNull()
    expect(got!.messages.length).toBe(20)
    expect(got!.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `m-${i}`)
    )
    // 最后一次 setCliSession 入队是 i=16（0/4/8/12/16），FIFO 队列应保留它
    expect(got!.cliSessionId).toBe('cli-16')
  })

  it('归档会话的写队列正常：archive 与 append 并发后两者都生效', async () => {
    const s = createSession('sonnet', '归档并发')
    await appendMessage(s.id, { role: 'user', text: 'hi', ts: 1 })
    // 三个写操作在同一次同步段入队（真实并发），再逐个取结果
    const p1 = archiveSession(s.id, true)
    const p2 = appendMessage(s.id, { role: 'assistant', text: 'after-archive', ts: 2 })
    const p3 = archiveSession(s.id, true)
    expect(await p1).toBe(true)
    await p2
    expect(await p3).toBe(true)
    const got = getSession(s.id)
    expect(got).not.toBeNull()
    expect(got!.archived).toBe(true)
    expect(got!.messages.length).toBe(2)
    expect(got!.messages[1].text).toBe('after-archive')
  })

  it('removeSession 与 append 并发：文件最终删除，不再复活', async () => {
    const s = createSession('sonnet', '删除竞态')
    // 同步入队顺序：append → remove → append；队列执行后文件必须消失
    await Promise.all([
      appendMessage(s.id, { role: 'user', text: 'a', ts: 1 }),
      removeSession(s.id),
      appendMessage(s.id, { role: 'user', text: 'b', ts: 2 })
    ])
    expect(getSession(s.id)).toBeNull()
    expect(listSessions().length).toBe(0)
  })

  it('removeSession 与 setCliSession 并发：最终删除', async () => {
    const s = createSession('sonnet', '删除竞态2')
    await Promise.all([
      setCliSession(s.id, 'cli-x'),
      removeSession(s.id),
      setCliSession(s.id, 'cli-y')
    ])
    expect(getSession(s.id)).toBeNull()
    expect(listSessions().length).toBe(0)
  })

  it('多会话并行写互不串扰（队列按 id 隔离）', async () => {
    const sessions = Array.from({ length: 8 }, (_, i) => createSession('sonnet', `s-${i}`))
    await Promise.all(
      sessions.flatMap((s, si) =>
        Array.from({ length: 5 }, (_, mi) =>
          appendMessage(s.id, { role: 'user', text: `s${si}-m${mi}`, ts: si * 100 + mi })
        )
      )
    )
    for (let si = 0; si < 8; si++) {
      const got = getSession(sessions[si].id)
      expect(got).not.toBeNull()
      expect(got!.messages.map((m) => m.text)).toEqual(
        Array.from({ length: 5 }, (_, mi) => `s${si}-m${mi}`)
      )
    }
  })

  it('对不存在的会话写入静默无副作用（不建文件、不入列表）', async () => {
    await expect(appendMessage('deadbeefdeadbeef', { role: 'user', text: 'x', ts: 1 })).resolves.toBeUndefined()
    await expect(setCliSession('deadbeefdeadbeef', 'cli')).resolves.toBeUndefined()
    expect(await archiveSession('deadbeefdeadbeef', true)).toBe(false)
    expect(await setSessionProject('deadbeefdeadbeef', 'p')).toBe(false)
    expect(getSession('deadbeefdeadbeef')).toBeNull()
    expect(listSessions().length).toBe(0)
  })
})
