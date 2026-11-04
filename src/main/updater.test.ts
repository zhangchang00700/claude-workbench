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
  generateInstallScript,
  getLastDownloadedZip,
  isWindowsZipAsset,
  isZipFile,
  normalizeVersion,
  parseRelease,
  planDownloadPath,
  safeFileName,
  setLastDownloadedZip,
  updateInstall,
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

describe('generateInstallScript 一键安装脚本生成', () => {
  it('生成纯 ASCII 脚本：包含 PID / 路径 / 校验逻辑关键片段', () => {
    const script = generateInstallScript({
      pid: 12345,
      zipPath: 'C:\\temp\\update.zip',
      appRoot: 'C:\\app',
      exePath: 'C:\\app\\ClaudeWorkbench.exe'
    })
    // 纯 ASCII（无 BOM 乱码风险）
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128)
    }
    // PID 出现在 Wait-Process 中
    expect(script).toContain('Wait-Process')
    expect(script).toContain('12345')
    // 路径内联
    expect(script).toContain('C:\\temp\\update.zip')
    expect(script).toContain('C:\\app\\ClaudeWorkbench.exe')
    // 校验逻辑
    expect(script).toContain('Test-Path')
    expect(script).toContain('Length')
    // 解压 + 重启
    expect(script).toContain('Expand-Archive')
    expect(script).toContain('Start-Process')
  })

  it('非 ASCII 路径走 Base64 编码，脚本仍纯 ASCII', () => {
    const script = generateInstallScript({
      pid: 999,
      zipPath: 'C:\\用户目录\\更新包.zip',
      appRoot: 'C:\\应用目录',
      exePath: 'C:\\应用目录\\ClaudeWorkbench.exe'
    })
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128)
    }
    expect(script).toContain('FromBase64String')
    expect(script).toContain('UTF8.GetString')
    expect(script).toContain('Wait-Process')
    expect(script).toContain('Expand-Archive')
  })

  it('脚本含 zip 校验（存在 + 大小>0）', () => {
    const script = generateInstallScript({
      pid: 1,
      zipPath: 'a.zip',
      appRoot: 'b',
      exePath: 'c.exe'
    })
    expect(script).toContain('Test-Path -LiteralPath $zipPath')
    expect(script).toContain('$zipItem.Length -le 0')
    expect(script).toContain('exit 1')
    expect(script).toContain('exit 2')
  })
})

describe('updateInstall 一键安装入口', () => {
  it('未下载更新包时报错「请先下载更新包」', async () => {
    const res = await updateInstall({ zipPath: null })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请先下载更新包')
  })

  it('有 zip 时生成脚本并启动（注入 write/launch 验证调用，绝不真执行替换）', async () => {
    let writtenScript = ''
    let writtenPath = ''
    let launchedPath = ''
    const res = await updateInstall({
      zipPath: 'C:\\dl\\update.zip',
      pid: 4242,
      appRoot: 'C:\\app',
      exePath: 'C:\\app\\ClaudeWorkbench.exe',
      scriptDir: os.tmpdir(),
      writeScript: (p, content) => {
        writtenPath = p
        writtenScript = content
      },
      launchScript: (p) => {
        launchedPath = p
      }
    })
    expect(res.ok).toBe(true)
    expect(writtenPath).toContain('update-installer.ps1')
    expect(launchedPath).toBe(writtenPath)
    // 写入的脚本就是 generateInstallScript 的输出
    expect(writtenScript).toContain('Wait-Process')
    expect(writtenScript).toContain('4242')
    expect(writtenScript).toContain('Expand-Archive')
    // 纯 ASCII
    for (let i = 0; i < writtenScript.length; i++) {
      expect(writtenScript.charCodeAt(i)).toBeLessThan(128)
    }
  })
})

/* ───────── qa 独立补测：一键安装边界（绝不真执行安装） ───────── */

describe('generateInstallScript 边界路径（qa）', () => {
  it('含空格路径走单引号内联，不触发 Base64', () => {
    const script = generateInstallScript({
      pid: 7,
      zipPath: 'C:\\Program Files\\My App\\update pack.zip',
      appRoot: 'C:\\Program Files\\My App',
      exePath: 'C:\\Program Files\\My App\\ClaudeWorkbench.exe'
    })
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128)
    }
    // 空格是可打印 ASCII 且无单引号 → 三个路径都内联单引号字面量
    expect(script).toContain("'C:\\Program Files\\My App\\update pack.zip'")
    expect(script).toContain("'C:\\Program Files\\My App'")
    expect(script).toContain("'C:\\Program Files\\My App\\ClaudeWorkbench.exe'")
    expect(script).not.toContain('FromBase64String')
  })

  it('含单引号的路径强制走 Base64（单引号会截断 PS 字面量），且解码回原文', () => {
    const zip = "C:\\it's\\update.zip"
    const script = generateInstallScript({
      pid: 7,
      zipPath: zip,
      appRoot: 'C:\\app',
      exePath: 'C:\\app\\e.exe'
    })
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128)
    }
    expect(script).toContain('FromBase64String')
    expect(script).toContain('UTF8.GetString')
    // 提取 Base64 段并解码校验：编码内容必须精确等于原路径
    const m = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)
    expect(m).not.toBeNull()
    expect(Buffer.from(m![1], 'base64').toString('utf8')).toBe(zip)
    // 单引号原文绝不能内联出现（否则截断）
    expect(script).not.toContain("it's")
  })

  it('中文路径 Base64 可解码回原文，且中文绝不出现在脚本文本里', () => {
    const zip = 'C:\\用户目录\\更新包.zip'
    const root = 'C:\\应用目录'
    const exe = 'C:\\应用目录\\ClaudeWorkbench.exe'
    const script = generateInstallScript({ pid: 999, zipPath: zip, appRoot: root, exePath: exe })
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128)
    }
    // 三个 Base64 段逐一解码，必须精确还原
    const decoded = [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g)].map(
      (m) => Buffer.from(m[1], 'base64').toString('utf8')
    )
    expect(decoded).toContain(zip)
    expect(decoded).toContain(root)
    expect(decoded).toContain(exe)
    // 中文绝不能直接落在脚本里（无 BOM ps1 在中文 Windows 上乱码的根因）
    expect(script).not.toContain('用户目录')
    expect(script).not.toContain('应用目录')
  })

  it('混合：zip 含中文（Base64）+ appRoot/exe 含空格（内联）共存', () => {
    const script = generateInstallScript({
      pid: 5,
      zipPath: 'D:\\下载\\更新.zip',
      appRoot: 'C:\\Program Files\\ClaudeWorkbench',
      exePath: 'C:\\Program Files\\ClaudeWorkbench\\ClaudeWorkbench.exe'
    })
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128)
    }
    expect(script).toContain("'C:\\Program Files\\ClaudeWorkbench'")
    expect(script).toContain("'C:\\Program Files\\ClaudeWorkbench\\ClaudeWorkbench.exe'")
    expect(script).toContain('FromBase64String')
  })
})

describe('updateInstall 错误路径与缓存语义（qa）', () => {
  it('既不传 zipPath 也无 lastDownloadedZip：报「请先下载更新包」', async () => {
    setLastDownloadedZip(null)
    const res = await updateInstall({})
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请先下载更新包')
  })

  it('显式 zipPath:null 优先于 lastDownloadedZip（undefined 与 null 语义区分）', async () => {
    setLastDownloadedZip('C:\\dl\\cached.zip')
    const res = await updateInstall({ zipPath: null })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请先下载更新包')
    setLastDownloadedZip(null)
  })

  it('不传 zipPath 时回退采用 lastDownloadedZip', async () => {
    setLastDownloadedZip('C:\\dl\\cached.zip')
    let written = ''
    const res = await updateInstall({
      pid: 1,
      appRoot: 'C:\\app',
      exePath: 'C:\\app\\e.exe',
      writeScript: (_p, content) => {
        written = content
      },
      launchScript: () => {}
    })
    expect(res.ok).toBe(true)
    expect(written).toContain('C:\\dl\\cached.zip')
    setLastDownloadedZip(null)
  })

  it('writeScript 抛错：回「写入安装脚本失败」且绝不启动脚本', async () => {
    let launched = false
    const res = await updateInstall({
      zipPath: 'C:\\dl\\u.zip',
      pid: 1,
      appRoot: 'C:\\app',
      exePath: 'C:\\app\\e.exe',
      writeScript: () => {
        throw new Error('磁盘只读')
      },
      launchScript: () => {
        launched = true
      }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('写入安装脚本失败')
    expect(res.error).toContain('磁盘只读')
    expect(launched).toBe(false)
  })

  it('launchScript 抛错：回「启动安装脚本失败」', async () => {
    const res = await updateInstall({
      zipPath: 'C:\\dl\\u.zip',
      pid: 1,
      appRoot: 'C:\\app',
      exePath: 'C:\\app\\e.exe',
      writeScript: () => {},
      launchScript: () => {
        throw new Error('powershell 被禁用')
      }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('启动安装脚本失败')
    expect(res.error).toContain('powershell 被禁用')
  })

  it('getLastDownloadedZip 返回与 set 一致（状态存取契约）', () => {
    setLastDownloadedZip('C:\\dl\\x.zip')
    expect(getLastDownloadedZip()).toBe('C:\\dl\\x.zip')
    setLastDownloadedZip(null)
    expect(getLastDownloadedZip()).toBeNull()
  })
})
