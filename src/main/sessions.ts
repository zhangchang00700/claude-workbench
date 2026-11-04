/**
 * 会话历史持久化存储层（M1 尾巴）。
 *
 * 每条会话一个 JSON 文件，落在 userData/sessions/<id>.json。
 * 应用层会话 id 与底层 CLI session 解耦：同一个应用会话可跨多次 CLI 子进程，
 * 通过 cliSessionId 续聊（resume）。
 *
 * 写入策略：仅在「用户发言落盘」「助手整段完成落盘」「记录 cliSessionId」时写文件，
 * 流式增量不落盘（避免每 token 一次 fs 写）。原子写入（临时文件 + rename）。
 *
 * **并发安全（P0 修复）**：所有写操作按 session id 串行化（Promise 链队列），
 * 防止同一会话并发 read-modify-write 互相覆盖丢消息。不同会话的写操作并行执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ModelTier, SessionMeta, SessionRecord, StoredMsg } from '../shared/types'

/**
 * 会话目录根：由主进程在启动时通过 initSessionsRoot 注入 userData 目录，
 * 本模块不直接 import electron（避免单测环境拉不起 electron）。
 */
let _root: string | null = null

/** 主进程启动时调用一次，注入 userData 目录 */
export function initSessionsRoot(userDataDir: string): void {
  _root = path.join(userDataDir, 'sessions')
}

function sessionsDir(): string {
  if (!_root) throw new Error('sessions root not initialized; call initSessionsRoot() first')
  return _root
}

function sessionFile(id: string): string {
  // id 由本层生成（crypto.randomUUID 的 hex 子集），天然安全，无需额外转义
  return path.join(sessionsDir(), `${id}.json`)
}

function ensureDir(): void {
  fs.mkdirSync(sessionsDir(), { recursive: true })
}

function safeWrite(id: string, rec: SessionRecord): void {
  ensureDir()
  const target = sessionFile(id)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

function readOne(id: string): SessionRecord | null {
  try {
    const raw = fs.readFileSync(sessionFile(id), 'utf8')
    const rec = JSON.parse(raw) as SessionRecord
    if (!rec || typeof rec.id !== 'string') return null
    return rec
  } catch {
    return null
  }
}

/* ───────────────── 会话级写入串行化（P0 并发竞态修复） ───────────────── */

/**
 * 每个 session id 一条 Promise 链：同一会话的写操作严格排队，
 * 不同会话并行。链尾自动清理，防止 Map 无限增长。
 */
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(id) ?? Promise.resolve()
  const run = prev.then(task)
  // 吞掉链上错误保持队列存活；错误通过 run 暴露给调用方
  const chain: Promise<void> = run.then(
    () => undefined,
    () => undefined
  )
  writeQueues.set(id, chain)
  chain.then(() => {
    if (writeQueues.get(id) === chain) writeQueues.delete(id)
  })
  return run
}

/** 异步读（写队列内部用，保证 read-modify-write 之间有真实让出点） */
async function readOneAsync(id: string): Promise<SessionRecord | null> {
  try {
    const raw = await fs.promises.readFile(sessionFile(id), 'utf8')
    const rec = JSON.parse(raw) as SessionRecord
    if (!rec || typeof rec.id !== 'string') return null
    return rec
  } catch {
    return null
  }
}

/** 异步原子写（临时文件 + rename） */
async function safeWriteAsync(id: string, rec: SessionRecord): Promise<void> {
  ensureDir()
  const target = sessionFile(id)
  const tmp = `${target}.${process.pid}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8')
  await fs.promises.rename(tmp, target)
}

/* ───────────────────────── 读操作（同步，不排队） ───────────────────────── */

/** 列表（不含消息体），按 updatedAt 倒序 */
export function listSessions(): SessionMeta[] {
  try {
    ensureDir()
    const files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'))
    const metas: SessionMeta[] = []
    for (const f of files) {
      const rec = readOne(f.replace(/\.json$/, ''))
      if (!rec) continue
      metas.push({
        id: rec.id,
        title: rec.title,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tier: rec.tier,
        cliSessionId: rec.cliSessionId,
        messageCount: rec.messages.length,
        preview: rec.preview,
        // 旧记录没有这两个字段，读时兜底默认值（升级兼容）
        projectId: rec.projectId ?? null,
        archived: rec.archived === true
      })
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  } catch {
    return []
  }
}

export function getSession(id: string): SessionRecord | null {
  return readOne(id)
}

/* ───────────────────────── 写操作（按 session id 串行化） ───────────────────────── */

/** 新建会话（返回完整记录，但消息为空）——新 id 无竞争，同步写 */
export function createSession(tier: ModelTier, firstUserText: string, projectId: string | null = null): SessionRecord {
  const id = crypto.randomBytes(10).toString('hex')
  const now = Date.now()
  const title = firstUserText.replace(/\s+/g, ' ').slice(0, 40) || '新会话'
  const rec: SessionRecord = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    tier,
    cliSessionId: null,
    messageCount: 0,
    preview: firstUserText.slice(0, 80),
    projectId,
    archived: false,
    messages: []
  }
  safeWrite(id, rec)
  return rec
}

/** 追加一条消息（user 或 assistant）并刷新元信息——排队执行，防并发覆盖 */
export function appendMessage(id: string, msg: StoredMsg): Promise<void> {
  return enqueueWrite(id, async () => {
    const rec = await readOneAsync(id)
    if (!rec) return
    rec.messages.push(msg)
    rec.updatedAt = msg.ts
    rec.messageCount = rec.messages.length
    if (msg.role === 'user' && rec.messages.filter((m) => m.role === 'user').length === 1) {
      rec.title = msg.text.replace(/\s+/g, ' ').slice(0, 40) || rec.title
    }
    if (msg.role === 'assistant' && !msg.isError) {
      rec.preview = msg.text.replace(/\s+/g, ' ').slice(0, 80)
    }
    await safeWriteAsync(id, rec)
  })
}

/** 记录底层 CLI session id（用于续聊）——排队执行 */
export function setCliSession(id: string, cliSessionId: string): Promise<void> {
  return enqueueWrite(id, async () => {
    const rec = await readOneAsync(id)
    if (!rec) return
    rec.cliSessionId = cliSessionId
    await safeWriteAsync(id, rec)
  })
}

/** 删除会话——排队执行，防止在途写入把文件复活 */
export function removeSession(id: string): Promise<boolean> {
  return enqueueWrite(id, async () => {
    try {
      await fs.promises.rm(sessionFile(id), { force: true })
      return true
    } catch {
      return false
    }
  })
}

/** 把会话移入/移出项目（projectId=null 表示移出到未分组）——排队执行 */
export function setSessionProject(id: string, projectId: string | null): Promise<boolean> {
  return enqueueWrite(id, async () => {
    const rec = await readOneAsync(id)
    if (!rec) return false
    rec.projectId = projectId
    rec.updatedAt = Date.now()
    await safeWriteAsync(id, rec)
    return true
  })
}

/** 归档/取消归档会话（归档只影响列表归属，不删数据）——排队执行 */
export function archiveSession(id: string, archived: boolean): Promise<boolean> {
  return enqueueWrite(id, async () => {
    const rec = await readOneAsync(id)
    if (!rec) return false
    rec.archived = archived
    rec.updatedAt = Date.now()
    await safeWriteAsync(id, rec)
    return true
  })
}

/** 项目删除时把其下会话退回未分组（不连坐删数据，比 Claude Desktop 更保守） */
export async function clearProject(projectId: string): Promise<number> {
  let n = 0
  for (const meta of listSessions()) {
    if (meta.projectId === projectId) {
      if (await setSessionProject(meta.id, null)) n++
    }
  }
  return n
}
