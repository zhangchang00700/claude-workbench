import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeLaunchFailure, resolveCwd } from './client'

let tmp: string | null = null

function useTmp(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cwd-'))
  return tmp
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('resolveCwd：spawn 前保证 cwd 存在', () => {
  it('目录不存在则创建并返回绝对路径', () => {
    const root = useTmp()
    const target = path.join(root, 'nested', 'workspace')
    expect(fs.existsSync(target)).toBe(false)
    const got = resolveCwd(target)
    expect(got).toBe(path.resolve(target))
    expect(fs.statSync(got).isDirectory()).toBe(true)
  })

  it('已存在的目录原样返回（幂等）', () => {
    const root = useTmp()
    expect(resolveCwd(root)).toBe(path.resolve(root))
  })

  it('目标不可创建时退到 fallback', () => {
    const root = useTmp()
    // 用一个「文件」占位，让 mkdir 必然失败
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, 'x', 'utf8')
    const fallback = path.join(root, 'fallback')
    const got = resolveCwd(path.join(blocker, 'sub'), [fallback])
    expect(got).toBe(path.resolve(fallback))
    expect(fs.statSync(got).isDirectory()).toBe(true)
  })

  it('空值/全失败时退到进程 cwd，绝不返回不存在的路径', () => {
    const got = resolveCwd(undefined, [])
    expect(got).toBe(process.cwd())
    expect(fs.existsSync(got)).toBe(true)
    const root = useTmp()
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, 'x', 'utf8')
    expect(fs.existsSync(resolveCwd(path.join(blocker, 'sub'), []))).toBe(true)
  })
})

describe('describeLaunchFailure：把真实 spawn 原因补回误导文案', () => {
  it('SDK 的 libc 文案 + ENOENT → 补上 cwd 提示', () => {
    const err = Object.assign(new Error('Claude Code native binary at C:\\x\\claude.exe exists but failed to launch. libc…'), {
      cause: { code: 'ENOENT' }
    })
    const out = describeLaunchFailure(err) as Error
    expect(out.message).toContain('exists but failed to launch')
    expect(out.message).toContain('真实原因：spawn ENOENT')
    expect(out.message).toContain('cwd')
  })

  it('其他错误码原样补上；不带该文案的错误不动', () => {
    const eacces = Object.assign(new Error('exists but failed to launch'), { cause: { code: 'EACCES' } })
    expect((describeLaunchFailure(eacces) as Error).message).toContain('spawn EACCES')
    const other = new Error('rate limit exceeded')
    expect((describeLaunchFailure(other) as Error).message).toBe('rate limit exceeded')
  })

  it('重复包装不重复追加', () => {
    const err = Object.assign(new Error('exists but failed to launch'), { cause: { code: 'ENOENT' } })
    const once = (describeLaunchFailure(err) as Error).message
    const twice = (describeLaunchFailure(err) as Error).message
    expect(twice).toBe(once)
  })

  it('非 Error 输入安全返回', () => {
    expect(describeLaunchFailure(null)).toBeNull()
    expect(describeLaunchFailure('boom')).toBe('boom')
  })
})