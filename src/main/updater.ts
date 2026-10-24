/**
 * 自动更新通道（v0.2.0）。
 *
 * 关键环境约束（实测）：本机代理只放行 api.github.com，github.com 的 git/HTTP
 * 一律超时。electron-updater 默认的 GitHub Releases 通道（走 github.com）不可用，
 * 因此改走已认证且经代理可用的 gh CLI：
 *
 *   gh api repos/<owner>/<repo>/releases/latest
 *   gh api repos/<owner>/<repo>/releases/assets/<id> -H "Accept: application/octet-stream"
 *
 * 二进制 asset 走 spawn + 流式管道落盘，**绝不走 execFile + encoding:'utf8'**：
 * utf8 会把 zip 里的非法字节替换成 U+FFFD（落盘成功、大小差不多、零报错，但解压必失败），
 * 且 maxBuffer 对 263MB 的安装包直接 ENOBUFS。详见 createGhAssetStreamer 注释。
 *
 * 边界：只做「检测 + 下载到磁盘」，不做静默自替换（放后续版本）。
 *
 * 可测性：版本比较 / release 解析 / asset 匹配 / 路径规划 全部为导出的纯函数；
 * 子进程与 fs 通过依赖注入隔离（模式同 core/config.ts 的 readConfigWithRecovery）。
 * 所有对外入口都承诺 **不抛异常到渲染层**，失败统一回 error 字符串。
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const REPO = 'zhangchang00700/claude-workbench'

/** Windows 便携包命名：ClaudeWorkbench-<任意版本>-win.zip */
export const WIN_ZIP_PATTERN = /^ClaudeWorkbench-.+-win\.zip$/i

export interface ReleaseAsset {
  id: number
  name: string
  size: number
}

export interface ParsedRelease {
  tagName: string
  version: string
  notes: string
  asset: ReleaseAsset | null
}

/* ───────────────────────── 纯函数：版本比较 ───────────────────────── */

/** 归一化：去掉前导 v/V、截断 -预发布 与 +构建元数据 */
export function normalizeVersion(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
}

function versionParts(raw: string): number[] {
  return normalizeVersion(raw)
    .split('.')
    .map((seg) => {
      const n = parseInt(seg, 10)
      return Number.isFinite(n) ? n : 0
    })
}

/**
 * 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 非数字段按 0 处理（"0.2.0-beta" → "0.2.0"），缺失位补 0（"1.2" vs "1.2.0" 相等）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/* ───────────────────────── 纯函数：release 解析 ───────────────────────── */

/** 是否是我们能装的那个包（Windows zip 便携版） */
export function isWindowsZipAsset(name: string): boolean {
  return WIN_ZIP_PATTERN.test((name ?? '').trim())
}

/** 只保留 .zip 后缀（后续版本可能上 exe/msi，这里先只认 zip） */
export function isZipFile(name: string): boolean {
  return /\.zip$/i.test((name ?? '').trim())
}

/**
 * 解析 `gh api .../releases/latest` 的响应。
 * assets 里取第一个匹配 ClaudeWorkbench-*-win.zip 的项（多 asset 时按发布时间顺序，
 * GitHub API 返回顺序即上传顺序，取首个命中即可，前后掩码足够窄）。
 */
export function parseRelease(raw: unknown): { release: ParsedRelease | null; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { release: null, error: 'release 响应不是 JSON 对象' }
  }
  const obj = raw as { tag_name?: unknown; body?: unknown; assets?: unknown }
  const tagName = typeof obj.tag_name === 'string' ? obj.tag_name.trim() : ''
  if (!tagName) return { release: null, error: 'release 缺少 tag_name（可能不是正式 release）' }

  let asset: ReleaseAsset | null = null
  const assets = Array.isArray(obj.assets) ? (obj.assets as unknown[]) : []
  for (const raw_ of assets) {
    if (!raw_ || typeof raw_ !== 'object') continue
    const a = raw_ as { id?: unknown; name?: unknown; size?: unknown }
    const name = typeof a.name === 'string' ? a.name : ''
    if (!isWindowsZipAsset(name)) continue
    const id = typeof a.id === 'number' ? a.id : parseInt(String(a.id ?? ''), 10)
    if (!Number.isFinite(id)) continue
    const size = typeof a.size === 'number' ? a.size : parseInt(String(a.size ?? ''), 10)
    asset = { id, name, size: Number.isFinite(size) ? size : 0 }
    break
  }

  return {
    release: {
      tagName,
      version: normalizeVersion(tagName),
      notes: typeof obj.body === 'string' ? obj.body : '',
      asset
    }
  }
}

/* ───────────────────────── 纯函数：下载路径规划 ───────────────────────── */

/** asset 名落盘前过一遍 Windows 非法字符 */
export function safeFileName(name: string): string {
  const cleaned = (name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_')
  return cleaned || 'ClaudeWorkbench-update.zip'
}

export function planDownloadPath(dir: string, name: string): string {
  return path.join(dir, safeFileName(name))
}

/* ───────────────────────── gh 子进程封装 ───────────────────────── */

/** gh 调用器：返回 stdout；失败 reject。可注入以便单测。 */
export type GhRunner = (args: string[]) => Promise<string>

export function createGhRunner(timeoutMs = 60_000): GhRunner {
  return (args) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'gh',
        args,
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true, shell: false },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException
            if (e.code === 'ENOENT') {
              reject(new Error('未找到 gh（GitHub CLI）：请先安装 gh 并执行 gh auth login'))
              return
            }
            const tail = String(stderr ?? '').trim().slice(0, 300)
            reject(new Error(`gh 调用失败：${e.message}${tail ? `｜${tail}` : ''}`))
            return
          }
          resolve(String(stdout ?? ''))
        }
      )
    })
}

/* ───────────────────────── 二进制 asset 流式下载 ───────────────────────── */

/** 二进制 asset 下载器：把 gh 的 stdout 字节流原样写进目标文件。可注入以便单测。 */
export type AssetStreamer = (assetId: number, destPath: string) => Promise<void>

/**
 * 默认实现：spawn gh + stdout.pipe(createWriteStream)，字节级直落磁盘。
 *
 * 为什么不能复用 createGhRunner（execFile + encoding:'utf8' + maxBuffer）：
 * ① `encoding:'utf8'` 会把 zip 里的非法 UTF-8 字节替换成 U+FFFD —— 文件落盘成功、
 *    大小差不多、没有任何报错，但解压必失败（用户拿到 263MB 打不开的包，日志干干净净）；
 * ② `maxBuffer:16MB` 对 263.6MB 的安装包直接抛 ENOBUFS。
 * 这里不设 encoding、不设 maxBuffer，让 gh 的二进制输出原样进文件。
 *
 * 退出码非 0 / 流出错时清理半成品并 reject，避免留下看似完整的坏包。
 */
export function createGhAssetStreamer(): AssetStreamer {
  return (assetId, destPath) =>
    new Promise<void>((resolve, reject) => {
      let settled = false
      const ok = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        try {
          fs.unlinkSync(destPath)
        } catch {
          /* 半成品清理失败不影响错误上报 */
        }
        reject(err)
      }
      const child = spawn(
        'gh',
        ['api', `repos/${REPO}/releases/assets/${assetId}`, '-H', 'Accept: application/octet-stream'],
        { windowsHide: true, shell: false }
      )
      const out = createWriteStream(destPath)
      let stderr = ''
      child.stderr?.on('data', (c: Buffer) => {
        stderr = (stderr + String(c)).slice(-2000)
      })
      // pipe 会在 source end 时自动 end 目标流；不要手动再 end（会报 write after end）
      child.stdout?.on('error', fail)
      child.stdout?.pipe(out)
      out.on('error', fail)
      out.on('finish', ok)
      child.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code
        fail(
          code === 'ENOENT'
            ? new Error('未找到 gh（GitHub CLI）：请先安装 gh 并执行 gh auth login')
            : (err as Error)
        )
      })
      child.on('close', (code) => {
        if (code !== 0) {
          fail(new Error(`gh 下载失败（exit ${code}）：${stderr.trim().slice(0, 300) || '无输出'}`))
        }
      })
    })
}

/* ───────────────────────── 检测更新 ───────────────────────── */

/**
 * 把 gh 子进程的原始失败翻译成能给用户看的话。
 *
 * 实测场景：`releases/latest` 在仓库还没有任何 release 时返回 404，
 * 直接把 "Command failed with exit code 1" 抛到界面上等于没说人话。
 */
export function friendlyGhError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err)
  if (raw.includes('未找到 gh')) return raw
  if (/ENOENT/.test(raw) && /gh/.test(raw)) {
    return '未找到 gh（GitHub CLI）：请先安装 gh 并执行 gh auth login'
  }
  if (/HTTP 401|Bad credentials|authentication/i.test(raw)) {
    return 'gh 未认证或凭据失效：请执行 gh auth login 后重试'
  }
  if (/HTTP 404|"Not Found"|Not Found/.test(raw)) {
    return '仓库还没有已发布的 release（暂无可用更新）'
  }
  if (/HTTP 403|rate limit/i.test(raw)) return 'GitHub API 限流或拒绝访问，请稍后重试'
  if (/ETIMEDOUT|timeout|Could not resolve|ECONNREFUSED/i.test(raw)) {
    return '网络不可达：请检查代理设置后重试'
  }
  return raw.slice(0, 300)
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  current: string
  latest?: string
  notes?: string
  assetName?: string
  assetSize?: number
  error?: string
}

export interface CheckInput {
  currentVersion: string
  runGh?: GhRunner
}

export async function checkUpdate(input: CheckInput): Promise<UpdateCheckResult> {
  const current = input.currentVersion
  const runGh = input.runGh ?? createGhRunner()
  try {
    const stdout = await runGh(['api', `repos/${REPO}/releases/latest`])
    let json: unknown
    try {
      json = JSON.parse(stdout)
    } catch {
      return { hasUpdate: false, current, error: 'release 响应不是合法 JSON（可能被代理拦截）' }
    }
    const { release, error } = parseRelease(json)
    if (!release) return { hasUpdate: false, current, error: error ?? 'release 解析失败' }
    return {
      hasUpdate: compareVersions(release.version, normalizeVersion(current)) > 0,
      current,
      latest: release.tagName,
      notes: release.notes,
      assetName: release.asset?.name,
      assetSize: release.asset?.size
    }
  } catch (err) {
    return { hasUpdate: false, current, error: friendlyGhError(err) }
  }
}

/* ───────────────────────── 下载更新 ───────────────────────── */

export interface UpdateProgress {
  phase: string
  percent?: number
  message?: string
}

export type ProgressSink = (p: UpdateProgress) => void

/**
 * 进度阶段取值与渲染层 UpdatePanel 的 PHASE_LABEL 对齐
 * （check / found / download / write / done / error），避免阶段名漂移导致显示原始英文。
 */
export const PHASE_DOWNLOAD = 'download'
export const PHASE_DONE = 'done'
export const PHASE_ERROR = 'error'

export interface DownloadAssetInput {
  assetId: number
  destPath: string
  /** 期望大小（字节），用于换算百分比；未知传 0/undefined 则只报 phase */
  expectedSize?: number
  /** 二进制下载器，默认 createGhAssetStreamer()；单测注入假实现 */
  streamGh?: AssetStreamer
  onProgress?: ProgressSink
  /** 轮询输出文件大小（字节）；文件不存在返回 null */
  statSize?: (p: string) => number | null
  /** 轮询间隔，默认 400ms；单测可设小 */
  pollIntervalMs?: number
}

function defaultStatSize(p: string): number | null {
  try {
    return fs.statSync(p).size
  } catch {
    return null
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 下载单个 release asset 到目标文件，期间按已落盘字节数/期望大小上报进度。
 *
 * gh 不吐下载进度事件，所以轮询输出文件大小换算百分比：这是唯一能拿到真实
 * 进度的手段（不许改 gh，也不引入新依赖）。
 */
export async function downloadAsset(
  input: DownloadAssetInput
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const streamGh = input.streamGh ?? createGhAssetStreamer()
  const stat = input.statSize ?? defaultStatSize
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 400)
  let percent = 0
  try {
    fs.mkdirSync(path.dirname(input.destPath), { recursive: true })
    input.onProgress?.({ phase: PHASE_DOWNLOAD, percent: 0, message: '开始下载' })
    const pending = streamGh(input.assetId, input.destPath)
    const tick = (): void => {
      const size = stat(input.destPath)
      if (!input.expectedSize || input.expectedSize <= 0 || size === null) return
      const next = Math.min(99, Math.floor((size / input.expectedSize) * 100))
      if (next > percent) {
        percent = next
        input.onProgress?.({ phase: PHASE_DOWNLOAD, percent, message: '下载中' })
      }
    }
    const timer = setInterval(tick, pollIntervalMs)
    try {
      await pending
    } finally {
      clearInterval(timer)
      tick()
      // 让最后一次 percent=100 之前的时间片不被吞掉（gh 已退出，文件已落盘）
      await defaultSleep(0)
    }
    const size = stat(input.destPath) ?? 0
    if (size <= 0) {
      input.onProgress?.({ phase: PHASE_ERROR, percent, message: '下载产物为空' })
      return { ok: false, error: '下载产物为空（可能被代理拦截）' }
    }
    // 大小必须与 release 登记的 asset.size 一致：不等就是截断/损坏，宁可报错也别给用户一个坏包
    if (input.expectedSize && input.expectedSize > 0 && size !== input.expectedSize) {
      input.onProgress?.({ phase: PHASE_ERROR, percent, message: '下载不完整' })
      return {
        ok: false,
        error: `下载不完整（实际 ${size} / 期望 ${input.expectedSize} 字节），请重试`
      }
    }
    input.onProgress?.({ phase: PHASE_DONE, percent: 100, message: '下载完成' })
    return { ok: true, path: input.destPath }
  } catch (err) {
    const message = friendlyGhError(err)
    input.onProgress?.({ phase: PHASE_ERROR, percent, message })
    return { ok: false, error: message }
  }
}

export interface DownloadUpdateInput {
  currentVersion: string
  /** 落盘目录，默认 os.tmpdir() */
  dir?: string
  runGh?: GhRunner
  /** 二进制下载器，默认 createGhAssetStreamer()；单测注入假实现 */
  streamGh?: AssetStreamer
  onProgress?: ProgressSink
  statSize?: (p: string) => number | null
  pollIntervalMs?: number
}

/**
 * 组合入口：拿 latest（必要时先查一次）→ 校验 asset → 下载到磁盘。
 * 任一环节失败都回 {ok:false, error} 且不抛异常。
 */
export async function downloadUpdate(
  input: DownloadUpdateInput
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const runGh = input.runGh ?? createGhRunner()
  try {
    const stdout = await runGh(['api', `repos/${REPO}/releases/latest`])
    let json: unknown
    try {
      json = JSON.parse(stdout)
    } catch {
      return { ok: false, error: 'release 响应不是合法 JSON（可能被代理拦截）' }
    }
    const { release, error } = parseRelease(json)
    if (!release) return { ok: false, error: error ?? 'release 解析失败' }
    const asset = release.asset
    if (!asset) return { ok: false, error: `未找到 ${assetPatternHint()} 形式的安装包 asset` }
    if (!isZipFile(asset.name)) return { ok: false, error: `安装包不是 zip：${asset.name}` }
    const destPath = planDownloadPath(input.dir ?? os.tmpdir(), asset.name)
    return await downloadAsset({
      assetId: asset.id,
      destPath,
      expectedSize: asset.size,
      streamGh: input.streamGh,
      onProgress: input.onProgress,
      statSize: input.statSize,
      pollIntervalMs: input.pollIntervalMs
    })
  } catch (err) {
    return { ok: false, error: friendlyGhError(err) }
  }
}

/** 给用户的提示文案里复用同一套规则，避免两处漂移 */
export function assetPatternHint(): string {
  return String(WIN_ZIP_PATTERN).replace(/^\/\^i?/, '').replace(/\$\/i?$/, '') || 'ClaudeWorkbench-*-win.zip'
}
