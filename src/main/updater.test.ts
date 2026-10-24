/**
 * 自动更新通道单测：只覆盖纯逻辑（版本比较 / release 解析 / asset 匹配 / 路径规划），
 * 并把子进程与 fs 通过注入替换掉，保证不联网、不起 gh。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PHASE_DONE,
  PHASE_DOWNLOAD,
  PHASE_ERROR,
  checkUpdate,
  compareVersions,
  type AssetStreamer,
  downloadAsset,
  downloadUpdate,
  friendlyGhError,
  isWindowsZipAsset,
  isZipFile,
  normalizeVersion,
  parseRelease,
  planDownloadPath,
  safeFileName,
  type GhRunner
} from './updater'

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    name: 'v0.2.0',
    body: '## 更新\n- 全局速聊条',
    assets: [
      { id: 111, name: 'latest.yml', size: 300 },
      { id: 222, name: 'ClaudeWorkbench-0.2.0-win.zip', size: 1024 * 1024 },
      { id: 333, name: 'ClaudeWorkbench-0.2.0-mac.zip', size: 2048 }
    ],
    ...over
  }
}

describe('版本号语义化比较', () => {
  it('normalizeVersion 去 v 前缀与预发布后缀', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0')
    expect(normalizeVersion('V1.10.3')).toBe('1.10.3')
    expect(normalizeVersion('0.2.0-beta.1')).toBe('0.2.0')
    expect(normalizeVersion('0.2.0+build.5')).toBe('0.2.0')
  })

  it('新版本 > 旧版本', () => {
    expect(compareVersions('0.2.0', '0.1.1')).toBe(1)
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('旧版本 < 新版本', () => {
    expect(compareVersions('0.1.1', '0.2.0')).toBe(-1)
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1)
  })

  it('相等返回 0（含 v 前缀差异与位数差异）', () => {
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0)
    expect(compareVersions('v0.1.1', '0.1.1')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('非法/空版本按 0 处理，不炸', () => {
    expect(compareVersions('abc', '0.0.1')).toBe(-1)
    expect(compareVersions('', '')).toBe(0)
    expect(compareVersions('0.1.x', '0.1.0')).toBe(0)
  })
})

describe('release 响应解析', () => {
  it('解析出 tag / notes / assets 里的 win zip', () => {
    const { release: r, error } = parseRelease(release())
    expect(error).toBeUndefined()
    expect(r?.tagName).toBe('v0.2.0')
    expect(r?.version).toBe('0.2.0')
    expect(r?.notes).toContain('全局速聊条')
    expect(r?.asset).toEqual({ id: 222, name: 'ClaudeWorkbench-0.2.0-win.zip', size: 1024 * 1024 })
  })

  it('多个 zip 命中时取第一个 win 包', () => {
    const raw = release({
      assets: [
        { id: 1, name: 'ClaudeWorkbench-0.2.0-win.zip', size: 10 },
        { id: 2, name: 'ClaudeWorkbench-0.2.1-win.zip', size: 20 }
      ]
    })
    expect(parseRelease(raw).release?.asset?.id).toBe(1)
  })

  it('asset 名不匹配时 asset 为 null（不报错）', () => {
    const raw = release({ assets: [{ id: 1, name: 'ClaudeWorkbench-0.2.0-mac.zip', size: 1 }] })
    const { release: r, error } = parseRelease(raw)
    expect(error).toBeUndefined()
    expect(r?.asset).toBeNull()
  })

  it('缺 tag_name 视为解析失败', () => {
    const { release: r, error } = parseRelease({ assets: [] })
    expect(r).toBeNull()
    expect(error).toContain('tag_name')
  })

  it('非对象 / 数组 / null 都安全返回', () => {
    expect(parseRelease(null).release).toBeNull()
    expect(parseRelease([]).release).toBeNull()
    expect(parseRelease('release').release).toBeNull()
  })

  it('asset id 为字符串数字时也能解析', () => {
    const raw = release({ assets: [{ id: '456', name: 'ClaudeWorkbench-0.2.0-win.zip', size: '99' }] })
    expect(parseRelease(raw).release?.asset).toEqual({
      id: 456,
      name: 'ClaudeWorkbench-0.2.0-win.zip',
      size: 99
    })
  })

  it('asset id 非法时跳过该 asset', () => {
    const raw = release({ assets: [{ id: 'NaN', name: 'ClaudeWorkbench-0.2.0-win.zip', size: 1 }] })
    expect(parseRelease(raw).release?.asset).toBeNull()
  })
})

describe('asset 匹配规则', () => {
  it('只认 ClaudeWorkbench-*-win.zip', () => {
    expect(isWindowsZipAsset('ClaudeWorkbench-0.2.0-win.zip')).toBe(true)
    expect(isWindowsZipAsset('ClaudeWorkbench-0.2.0-mac.zip')).toBe(false)
    expect(isWindowsZipAsset('ClaudeWorkbench-0.2.0-win.exe')).toBe(false)
    expect(isWindowsZipAsset('latest.yml')).toBe(false)
    expect(isWindowsZipAsset('')).toBe(false)
  })

  it('isZipFile 只判断后缀', () => {
    expect(isZipFile('a.zip')).toBe(true)
    expect(isZipFile('a.exe')).toBe(false)
  })
})

describe('下载路径规划', () => {
  it('非法文件名字符被替换', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j.zip')).toBe('a_b_c_d_e_f_g_h_i_j.zip')
    expect(safeFileName('   ')).toBe('ClaudeWorkbench-update.zip')
  })

  it('planDownloadPath 拼接目录与安全文件名', () => {
    expect(planDownloadPath('/tmp/up', 'ClaudeWorkbench-0.2.0-win.zip')).toBe(
      path.join('/tmp/up', 'ClaudeWorkbench-0.2.0-win.zip')
    )
  })
})

describe('checkUpdate', () => {
  it('仓库还没有 release（404）时给出人话提示', async () => {
    // 真实 gh 报错形态：Command failed with exit code 1 + stderr 里的 GitHub JSON
    const runGh: GhRunner = async () => {
      throw new Error(
        'gh 调用失败：Command failed with exit code 1: gh api repos/x/y/releases/latest｜' +
          '{"message":"Not Found","documentation_url":"https://docs.github.com/","status":"404"}'
      )
    }
    const r = await checkUpdate({ currentVersion: '0.1.1', runGh })
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toContain('release')
  })

  it('发现新版本：hasUpdate=true 且带 notes/asset', async () => {
    const runGh: GhRunner = async (args) => {
      expect(args).toEqual(['api', 'repos/zhangchang00700/claude-workbench/releases/latest'])
      return JSON.stringify(release())
    }
    const r = await checkUpdate({ currentVersion: '0.1.1', runGh })
    expect(r.hasUpdate).toBe(true)
    expect(r.current).toBe('0.1.1')
    expect(r.latest).toBe('v0.2.0')
    expect(r.notes).toContain('全局速聊条')
    expect(r.assetName).toBe('ClaudeWorkbench-0.2.0-win.zip')
    expect(r.assetSize).toBe(1024 * 1024)
    expect(r.error).toBeUndefined()
  })

  it('已是最新：hasUpdate=false', async () => {
    const runGh: GhRunner = async () => JSON.stringify(release({ tag_name: 'v0.1.1' }))
    const r = await checkUpdate({ currentVersion: '0.1.1', runGh })
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('gh 不存在：回 error 且不抛', async () => {
    const runGh: GhRunner = async () => {
      throw new Error('未找到 gh（GitHub CLI）：请先安装 gh 并执行 gh auth login')
    }
    const r = await checkUpdate({ currentVersion: '0.1.1', runGh })
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toContain('gh')
  })

  it('gh 返回非 JSON：回 error 且不抛', async () => {
    const runGh: GhRunner = async () => '<html>代理拦截</html>'
    const r = await checkUpdate({ currentVersion: '0.1.1', runGh })
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toContain('JSON')
  })
})

describe('friendlyGhError', () => {
  it('gh 缺失', () => {
    expect(friendlyGhError(new Error('ENOENT'))).toContain('ENOENT')
    expect(friendlyGhError(new Error('未找到 gh（GitHub CLI）'))).toContain('未找到 gh')
  })

  it('未认证', () => {
    expect(friendlyGhError(new Error('HTTP 401: Bad credentials'))).toContain('gh auth login')
  })

  it('404 → 还没有 release', () => {
    expect(friendlyGhError(new Error('gh: Not Found (HTTP 404)'))).toContain('release')
  })

  it('网络不可达', () => {
    expect(friendlyGhError(new Error('Command failed: ETIMEDOUT'))).toContain('网络')
  })

  it('未知错误截断原文', () => {
    const msg = friendlyGhError(new Error('y'.repeat(500)))
    expect(msg.length).toBe(300)
  })
})

describe('downloadAsset', () => {
  it('正常下载：按已落盘字节数上报进度，回 ok + 路径', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-up-'))
    const dest = path.join(dir, 'out', 'ClaudeWorkbench-0.2.0-win.zip')
    const streamGh: AssetStreamer = async (assetId, destPath) => {
      expect(assetId).toBe(222)
      expect(destPath).toBe(dest)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      // 先落一半再补满：让轮询能真实观察到 percent 变化
      fs.writeFileSync(destPath, Buffer.alloc(500))
      await new Promise((r) => setTimeout(r, 30))
      fs.writeFileSync(destPath, Buffer.alloc(1000, 0xff))
    }
    const seen: Array<{ phase: string; percent?: number }> = []
    const res = await downloadAsset({
      assetId: 222,
      destPath: dest,
      expectedSize: 1000,
      streamGh,
      pollIntervalMs: 2,
      onProgress: (p) => seen.push({ phase: p.phase, percent: p.percent })
    })
    expect(res.ok).toBe(true)
    expect(res.path).toBe(dest)
    const downloading = seen.filter((p) => p.phase === PHASE_DOWNLOAD)
    expect(downloading.length).toBeGreaterThan(0)
    expect(downloading[0]?.percent).toBe(0)
    expect(seen[seen.length - 1]).toEqual({ phase: PHASE_DONE, percent: 100 })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('二进制字节级落盘：高字节不被 utf8 替换成 U+FFFD（0xFF 填充完整保留）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-up-'))
    const dest = path.join(dir, 'x.zip')
    const streamGh: AssetStreamer = async (_assetId, destPath) => {
      fs.writeFileSync(destPath, Buffer.alloc(2048, 0xff))
    }
    const res = await downloadAsset({
      assetId: 1,
      destPath: dest,
      expectedSize: 2048,
      streamGh,
      pollIntervalMs: 2
    })
    expect(res.ok).toBe(true)
    const buf = fs.readFileSync(dest)
    expect(buf.length).toBe(2048)
    // 263MB zip 若走 encoding:'utf8' 通道，高字节会被替换成 EF BF BD 且大小漂移
    expect(buf.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
    expect(buf.equals(Buffer.alloc(2048, 0xff))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('大小与 asset.size 不一致：判下载不完整（宁可不给用户坏包）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-up-'))
    const dest = path.join(dir, 'x.zip')
    const streamGh: AssetStreamer = async (_assetId, destPath) => {
      fs.writeFileSync(destPath, Buffer.alloc(64))
    }
    const res = await downloadAsset({
      assetId: 1,
      destPath: dest,
      expectedSize: 100,
      streamGh,
      pollIntervalMs: 2
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不完整')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('gh 失败：回 ok=false + error，并推 error 阶段', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-up-'))
    const dest = path.join(dir, 'x.zip')
    const streamGh: AssetStreamer = async () => {
      throw new Error('未找到 gh')
    }
    const seen: string[] = []
    const res = await downloadAsset({
      assetId: 1,
      destPath: dest,
      streamGh,
      pollIntervalMs: 2,
      onProgress: (p) => seen.push(p.phase)
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未找到 gh')
    expect(seen).toContain(PHASE_ERROR)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('下载产物为空：判定失败（典型代理拦截症状）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-up-'))
    const dest = path.join(dir, 'x.zip')
    const streamGh: AssetStreamer = async (_assetId, destPath) => {
      fs.writeFileSync(destPath, '')
    }
    const res = await downloadAsset({ assetId: 1, destPath: dest, streamGh, pollIntervalMs: 2 })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('为空')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('downloadUpdate 组合入口', () => {
  it('找不到 win zip asset 时明确报错', async () => {
    const runGh: GhRunner = async () => JSON.stringify(release({ assets: [{ id: 1, name: 'latest.yml' }] }))
    const res = await downloadUpdate({ currentVersion: '0.1.1', runGh })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('asset')
  })

  it('asset 不是 zip 时拒绝下载', async () => {
    const runGh: GhRunner = async () =>
      JSON.stringify(release({ assets: [{ id: 1, name: 'ClaudeWorkbench-0.2.0-win.7z', size: 10 }] }))
    const res = await downloadUpdate({ currentVersion: '0.1.1', runGh })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('zip')
  })

  it('端到端：下载到指定目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-up-'))
    const runGh: GhRunner = async (args) => {
      if (args[1]?.endsWith('/releases/latest')) return JSON.stringify(release())
      return ''
    }
    const streamGh: AssetStreamer = async (_assetId, destPath) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.writeFileSync(destPath, Buffer.alloc(1024 * 1024))
    }
    const res = await downloadUpdate({ currentVersion: '0.1.1', dir, runGh, streamGh })
    expect(res.ok).toBe(true)
    expect(res.path).toBe(path.join(dir, 'ClaudeWorkbench-0.2.0-win.zip'))
    expect(fs.existsSync(res.path as string)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
