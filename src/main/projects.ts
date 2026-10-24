/**
 * 会话项目存储层（对齐 Claude Desktop Projects 的分组语义）。
 *
 * 每个项目一个 JSON 文件，落 userData/projects/<id>.json，原子写。
 * 只做「分组 + 归档」，不含 project knowledge / 项目级记忆。
 * 与 sessions/tasks 一致：不 import electron，由主进程注入 userData 目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { SessionProject } from '../shared/types'

let _root: string | null = null

export function initProjectsRoot(userDataDir: string): void {
  _root = path.join(userDataDir, 'projects')
}

function projectsDir(): string {
  if (!_root) throw new Error('projects root not initialized; call initProjectsRoot() first')
  return _root
}

function projectFile(id: string): string {
  return path.join(projectsDir(), `${id}.json`)
}

function ensureDir(): void {
  fs.mkdirSync(projectsDir(), { recursive: true })
}

function safeWrite(rec: SessionProject): void {
  ensureDir()
  const target = projectFile(rec.id)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

function readOne(id: string): SessionProject | null {
  try {
    const rec = JSON.parse(fs.readFileSync(projectFile(id), 'utf8')) as SessionProject
    if (!rec || typeof rec.id !== 'string') return null
    return { ...rec, archived: rec.archived === true }
  } catch {
    return null
  }
}

/** 全部项目：未归档在前（按 updatedAt 倒序），已归档沉底 */
export function listProjects(): SessionProject[] {
  try {
    ensureDir()
    const out: SessionProject[] = []
    for (const f of fs.readdirSync(projectsDir())) {
      if (!f.endsWith('.json')) continue
      const rec = readOne(f.replace(/\.json$/, ''))
      if (rec) out.push(rec)
    }
    out.sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1
      return b.updatedAt - a.updatedAt
    })
    return out
  } catch {
    return []
  }
}

export function getProject(id: string): SessionProject | null {
  return readOne(id)
}

/** 新建/更新项目（带 id 且存在则更新，保留 createdAt） */
export function saveProject(input: {
  id?: string
  name: string
  description?: string
  archived?: boolean
}): SessionProject {
  const now = Date.now()
  const existing = input.id ? readOne(input.id) : null
  const rec: SessionProject = {
    id: existing?.id ?? crypto.randomBytes(10).toString('hex'),
    name: (input.name ?? '').trim() || '未命名项目',
    description: (input.description ?? existing?.description ?? '').trim(),
    archived: input.archived ?? existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  safeWrite(rec)
  return rec
}

export function removeProject(id: string): boolean {
  try {
    fs.rmSync(projectFile(id), { force: true })
    return true
  } catch {
    return false
  }
}
