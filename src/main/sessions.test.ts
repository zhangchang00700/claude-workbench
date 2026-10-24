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
  it('新建 + 追加消息 + 读取', () => {
    const s = createSession('sonnet', '第一条指令')
    expect(s.id).toMatch(/^[0-9a-f]+$/)
    expect(s.messages.length).toBe(0)
    appendMessage(s.id, { role: 'user', text: '第一条指令', ts: 1000 })
    appendMessage(s.id, { role: 'assistant', text: '回复内容', ts: 2000 })
    const got = getSession(s.id)
    expect(got).not.toBeNull()
    expect(got!.messages.length).toBe(2)
    expect(got!.messages[0].role).toBe('user')
    expect(got!.messages[1].text).toBe('回复内容')
  })

  it('首条用户消息成为标题，助手消息刷新预览', () => {
    const s = createSession('opus', '原始长文本应该被截断到四十字以内否则会太长')
    appendMessage(s.id, { role: 'user', text: '原始长文本应该被截断到四十字以内否则会太长', ts: 1 })
    appendMessage(s.id, { role: 'assistant', text: '这是预览摘要内容', ts: 2 })
    const meta = listSessions()[0]
    expect(meta.title.length).toBeLessThanOrEqual(40)
    expect(meta.preview).toContain('预览摘要')
    expect(meta.messageCount).toBe(2)
  })

  it('列表按 updatedAt 倒序', () => {
    const a = createSession('sonnet', 'A')
    const b = createSession('sonnet', 'B')
    appendMessage(a.id, { role: 'user', text: 'A', ts: 10 })
    appendMessage(b.id, { role: 'user', text: 'B', ts: 20 })
    const ids = listSessions().map((s) => s.id)
    expect(ids[0]).toBe(b.id)
    expect(ids[1]).toBe(a.id)
  })

  it('记录底层 CLI session 用于续聊', () => {
    const s = createSession('sonnet', 'hi')
    setCliSession(s.id, 'cli-session-xyz')
    expect(getSession(s.id)!.cliSessionId).toBe('cli-session-xyz')
  })

  it('删除会话', () => {
    const s = createSession('sonnet', 'x')
    expect(removeSession(s.id)).toBe(true)
    expect(getSession(s.id)).toBeNull()
    expect(listSessions().length).toBe(0)
  })

  it('错误消息也落盘（isError）', () => {
    const s = createSession('sonnet', 'q')
    appendMessage(s.id, { role: 'assistant', text: 'boom', isError: true, ts: 5 })
    expect(getSession(s.id)!.messages[0].isError).toBe(true)
  })
})

describe('会话归档 / 项目分组', () => {
  it('新建时归入项目；移出后为未分组', () => {
    const a = createSession('sonnet', '项目内会话', 'p1')
    expect(a.projectId).toBe('p1')
    expect(listSessions()[0].projectId).toBe('p1')
    expect(setSessionProject(a.id, null)).toBe(true)
    expect(getSession(a.id)!.projectId).toBeNull()
    expect(listSessions()[0].projectId).toBeNull()
  })

  it('归档只影响归属标记，不删数据；可取消归档', () => {
    const s = createSession('sonnet', '待归档')
    appendMessage(s.id, { role: 'user', text: 'hi', ts: 1 })
    expect(archiveSession(s.id, true)).toBe(true)
    expect(listSessions()[0].archived).toBe(true)
    expect(getSession(s.id)!.messages).toHaveLength(1)
    expect(archiveSession(s.id, false)).toBe(true)
    expect(listSessions()[0].archived).toBe(false)
  })

  it('删除项目时其下会话退回未分组（不连坐删除）', () => {
    const a = createSession('sonnet', 'a', 'p1')
    const b = createSession('sonnet', 'b', 'p1')
    const c = createSession('sonnet', 'c', 'p2')
    expect(clearProject('p1')).toBe(2)
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
