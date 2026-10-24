import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getProject, initProjectsRoot, listProjects, removeProject, saveProject } from './projects'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'))
  initProjectsRoot(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('会话项目存储层', () => {
  it('新建/读取/更新（保留 createdAt）', () => {
    const p = saveProject({ name: '短剧项目', description: '《医道逆袭》' })
    expect(p.id).toMatch(/^[0-9a-f]+$/)
    expect(p.archived).toBe(false)
    const got = getProject(p.id)
    expect(got?.name).toBe('短剧项目')

    const updated = saveProject({ id: p.id, name: '短剧项目 V2' })
    expect(updated.createdAt).toBe(p.createdAt)
    expect(updated.description).toBe('《医道逆袭》') // 未传保留
  })

  it('列表排序：未归档在前，归档沉底；按 updatedAt 倒序', () => {
    const a = saveProject({ name: 'A' })
    const b = saveProject({ name: 'B' })
    const c = saveProject({ name: 'C' })
    saveProject({ id: a.id, name: 'A', archived: true })
    const names = listProjects().map((p) => p.name)
    expect(names[names.length - 1]).toBe('A') // 归档沉底
    expect(names.slice(0, 2).sort()).toEqual(['B', 'C'])
    expect(listProjects()).toHaveLength(3)
    expect([a, b, c].every((x) => getProject(x.id))).toBe(true)
  })

  it('空名回落未命名项目；删除生效', () => {
    const p = saveProject({ name: '   ' })
    expect(p.name).toBe('未命名项目')
    expect(removeProject(p.id)).toBe(true)
    expect(getProject(p.id)).toBeNull()
  })
})