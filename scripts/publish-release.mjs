// 发版到 GitHub Releases：建 release（tag + 更新说明）→ 上传产物（zip/exe/latest.yml）。
//
// 背景（本机实测，别拍脑袋改）：
//   代理只放行部分 GitHub 域。实测结论：
//     api.github.com               → 200           可用（gh CLI 走这个）
//     uploads.github.com           → 401/302 真身   可用 ← Release asset 上传走这里
//     github.com                   → HTML 偶发 200，但 /raw/ 与 codeload 下载 502/断流 → 不可靠
//     raw.githubusercontent.com     → TLS 握手失败   不可用
//   所以：建 release 与改 tag 走 gh api（api.github.com）；
//         上传 asset 走 curl → uploads.github.com（流式读盘，276MB 也不会把内存打爆）。
//
// 用法：
//   node scripts/publish-release.mjs --dry                 只打印计划，不写远端
//   node scripts/publish-release.mjs                        正常发版
//   node scripts/publish-release.mjs --tag v0.2.0           指定 tag（默认取 package.json version）
//   node scripts/publish-release.mjs --assets-dir release-v0.2.0
//   node scripts/publish-release.mjs --notes docs/release-notes/v0.2.0.md
//   node scripts/publish-release.mjs --no-assets            只建 release，不传产物
//
// 退出码：0 = 成功 / 已存在（不覆盖）/ 上传通道不可用但 release 已建好；1 = 硬失败。
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = 'zhangchang00700/claude-workbench'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const noAssets = argv.includes('--no-assets')

function opt(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}

const PROXY =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ''

const line = (s = '') => console.log(s)
const hr = (t) => line(`\n──── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`)

/* ────────────────────────── 基础信息 ────────────────────────── */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const tag = opt('--tag', `v${version}`)

// productName 从打包配置里读，避免硬编码后改名就对不上
function productName() {
  for (const f of ['electron-builder.ship.yml', 'electron-builder.yml']) {
    const p = path.join(ROOT, f)
    if (!fs.existsSync(p)) continue
    const m = fs.readFileSync(p, 'utf8').match(/^productName:\s*(.+)$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return 'ClaudeWorkbench'
}
const PRODUCT = productName()

/* ────────────────────────── gh / curl 封装 ────────────────────────── */

// payload 走临时文件 + --input：Windows 下 stdin 会被弄坏成 400
let seq = 0
async function ghApi(endpoint, { method = 'GET', body } = {}) {
  const args = ['api', endpoint, '-X', method]
  let tmp
  if (body !== undefined) {
    tmp = path.join(os.tmpdir(), `cw-rel-${process.pid}-${++seq}.json`)
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8')
    args.push('--input', tmp)
  }
  try {
    const { stdout } = await pExecFile('gh', args, {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    })
    return stdout ? JSON.parse(stdout) : {}
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true })
  }
}

function ghToken() {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true })
  const t = (r.stdout || '').trim()
  if (!t) throw new Error('gh auth token 取不到，先执行 gh auth login')
  return t
}

function curl(args) {
  return spawnSync('curl.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CURL_CA_BUNDLE: '' }
  })
}

// 从 curl -w 输出尾部取 HTTP 码；连不上时 code=000
function parseCode(stdout) {
  const m = String(stdout || '').match(/__HTTP__(\d{3})\s*$/)
  return m ? Number(m[1]) : 0
}

/* ────────────────────────── 更新说明 ────────────────────────── */

function notesFile() {
  const explicit = opt('--notes', null)
  if (explicit) return path.resolve(ROOT, explicit)
  // 优先跟 tag 走，其次跟 package.json version 走
  const candidates = [
    path.join(ROOT, 'docs', 'release-notes', `${tag}.md`),
    path.join(ROOT, 'docs', 'release-notes', `v${version}.md`)
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
}

function readNotes() {
  const p = notesFile()
  if (!fs.existsSync(p)) {
    return {
      path: p,
      body: `## ${tag}\n\n（缺少更新说明模板：${path.relative(ROOT, p)}，发版前请补）`,
      missing: true
    }
  }
  return { path: p, body: fs.readFileSync(p, 'utf8'), missing: false }
}

/* ────────────────────────── 产物发现 ────────────────────────── */

function contentType(name) {
  if (name.endsWith('.zip')) return 'application/zip'
  if (name.endsWith('.exe')) return 'application/octet-stream'
  if (name.endsWith('.7z')) return 'application/x-7z-compressed'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'text/yaml'
  if (name.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

function discoverAssets(dir) {
  if (!fs.existsSync(dir)) return { dir, files: [], missing: true }
  const all = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
  const pick = (n) => (all.includes(n) ? path.join(dir, n) : null)

  const wanted = [
    pick(`${PRODUCT}-${version}-win.zip`),
    pick(`${PRODUCT}-${version}-win.exe`),
    pick('latest.yml')
  ]
  // 精确名没命中就退化为「目录下所有 zip/exe」，避免版本改名后漏传
  let files = wanted.filter(Boolean)
  if (!files.some((f) => f.endsWith('.zip')) || !files.some((f) => f.endsWith('.exe'))) {
    for (const n of all) {
      if (/\.(zip|exe)$/i.test(n) && !files.some((f) => path.basename(f) === n)) {
        files.push(path.join(dir, n))
      }
    }
  }
  return { dir, files: files.filter((f) => fs.existsSync(f)), missing: false }
}

/* ────────────────────────── 上传通道探测 ────────────────────────── */

// 用假 token 打一发：拿到 401/404 说明是 GitHub 真身（通道可用）；
// 000 / 502 = 代理把 CONNECT 掐了（通道不可用）
function probeUploads() {
  const out = path.join(os.tmpdir(), `cw-probe-${process.pid}.txt`)
  const args = [
    '-sS', '-o', out,
    '-X', 'POST',
    '-H', 'Authorization: Bearer invalid_probe_token',
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', 'probe',
    '-w', '\n__HTTP__%{http_code}',
    '--connect-timeout', '15',
    '--max-time', '30'
  ]
  if (PROXY) args.push('-x', PROXY)
  args.push(`https://uploads.github.com/repos/${TARGET}/releases/0/assets?name=__probe__.bin`)

  const r = curl(args)
  const code = parseCode(r.stdout)
  let detail = String(r.stderr || '').trim().split('\n').slice(-1)[0] || ''
  try {
    const body = fs.readFileSync(out, 'utf8')
    if (body && /request_id|Bad credentials|Not Found/.test(body)) {
      detail = 'GitHub 真身响应（含 request_id）'
    }
    fs.rmSync(out, { force: true })
  } catch { /* ignore */ }

  const reachable = [301, 302, 401, 403, 404, 422].includes(code)
  return { reachable, code, detail, proxy: PROXY || '(无代理环境变量)' }
}

/* ────────────────────────── 上传 asset ────────────────────────── */

function uploadAsset(file, uploadBase, token) {
  const name = path.basename(file)
  const url = `${uploadBase}?name=${encodeURIComponent(name)}`
  const args = [
    '-sS',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', `Content-Type: ${contentType(name)}`,
    '--data-binary', `@${file}`, // @ = 流式读盘，不吃内存
    '-w', '\n__HTTP__%{http_code}',
    '--connect-timeout', '20',
    '--max-time', '1800',
    '--retry', '2',
    '--retry-delay', '3'
  ]
  if (PROXY) args.push('-x', PROXY)
  args.push(url)

  const r = curl(args)
  const code = parseCode(r.stdout)
  const body = String(r.stdout || '').replace(/\n__HTTP__\d{3}\s*$/, '')
  const ok = code === 201 || code === 200
  return {
    name,
    ok,
    code,
    error: ok ? null : String(r.stderr || '').trim() || body.slice(0, 300),
    size: fs.statSync(file).size
  }
}

/* ────────────────────────── 主流程 ────────────────────────── */

async function main() {
  hr('发版计划')
  line(`目标仓库   ${TARGET}`)
  line(`package    v${version}`)
  line(`tag        ${tag}`)
  line(`代理       ${PROXY || '(未设置)'}`)
  line(`模式       ${dry ? 'DRY-RUN（只打印，不写远端）' : '实际执行'}`)

  const notes = readNotes()
  line(`更新说明   ${path.relative(ROOT, notes.path)}${notes.missing ? '  ⚠ 缺失，用了占位 body' : ''}`)

  const assetsDirArg = opt('--assets-dir', `release-v${version}`)
  const assets = discoverAssets(path.resolve(ROOT, assetsDirArg))
  line(`产物目录   ${path.relative(ROOT, assets.dir)}${assets.missing ? '  ⚠ 目录不存在' : ''}`)
  if (assets.files.length === 0) {
    line('产物列表   （空）')
  } else {
    for (const f of assets.files) {
      line(`  · ${path.basename(f)}  ${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB`)
    }
  }

  // ① 该 tag 是否已存在（只读，dry 也查，用于判断会不会撞车）
  hr('检查既有 release')
  let existing = null
  try {
    existing = await ghApi(`repos/${TARGET}/releases/tags/${tag}`)
    line(`已存在     tag=${existing.tag_name}  id=${existing.id}  assets=${existing.assets?.length ?? 0}`)
    line(`           ${existing.html_url}`)
  } catch {
    line(`不存在     ${tag}（可新建）`)
  }
  let latest = null
  try {
    latest = await ghApi(`repos/${TARGET}/releases/latest`)
    line(`当前 latest ${latest.tag_name ?? '(无)'}`)
  } catch {
    line('当前 latest （仓库还没有任何 release）')
  }

  // ② 上传通道探测
  hr('上传通道探测 uploads.github.com')
  const probe = probeUploads()
  line(`结果       ${probe.reachable ? '可用' : '不可用'}  (HTTP ${probe.code}) ${probe.detail}`)
  line(`代理       ${probe.proxy}`)

  if (dry) {
    hr('DRY-RUN 汇总')
    line(`将创建     ${tag}  (target_commitish=main, draft=false, prerelease=false)`)
    line(`body 长度  ${notes.body.length} 字符`)
    line(`将上传     ${noAssets ? '（--no-assets，跳过）' : assets.files.map((f) => path.basename(f)).join(', ') || '（无产物）'}`)
    if (!probe.reachable) {
      line('⚠ 上传通道不可用 → 将只建 release，需要手动在网页上传 asset')
    }
    line('\n（--dry 到此为止，未写远端）')
    return 0
  }

  if (existing && existing.id) {
    hr('跳过')
    line(`${tag} 已存在，不覆盖、不删除任何东西。`)
    line(`${existing.html_url}`)
    return 0
  }

  // ③ 建 release
  hr('创建 release')
  const rel = await ghApi(`repos/${TARGET}/releases`, {
    method: 'POST',
    body: {
      tag_name: tag,
      name: `${PRODUCT} ${tag}`,
      body: notes.body,
      draft: false,
      prerelease: false,
      target_commitish: 'main'
    }
  })
  line(`已创建     id=${rel.id}  ${rel.html_url}`)
  const uploadBase = String(rel.upload_url || '').replace(/\{[^}]*\}$/, '')

  // ④ 上传 asset
  if (noAssets) {
    hr('上传产物')
    line('（--no-assets，跳过）')
  } else if (assets.files.length === 0) {
    hr('上传产物')
    line('⚠ 没有找到任何产物，release 只有 tag 和说明。')
  } else if (!probe.reachable) {
    hr('上传产物 —— 通道不可用，降级为手动')
    line(`uploads.github.com 实测 HTTP ${probe.code}（${probe.detail}），asset 无法自动上传。`)
    line('Release 已经建好，请手动补产物：')
    line(`  1. 打开 ${rel.html_url}`)
    line('  2. 点 "Edit" → 下方 Attach binaries 区域')
    for (const f of assets.files) line(`  3. 拖入 ${f}`)
    line('')
    line('████ 注意：asset 上传不可用，需手动在网页上传 ████')
  } else {
    hr('上传产物')
    const token = ghToken()
    const results = []
    for (const f of assets.files) {
      process.stdout.write(`上传中 ${path.basename(f)} ... `)
      const r = uploadAsset(f, uploadBase, token)
      results.push(r)
      line(r.ok ? `OK (${r.size ? (r.size / 1024 / 1024).toFixed(1) + ' MB' : ''})` : `失败 HTTP ${r.code}`)
      if (!r.ok) line(`    ${r.error}`)
    }
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      line('')
      line('████ 部分 asset 上传失败，需手动在网页补传 ████')
      for (const r of failed) line(`  · ${r.name}  HTTP ${r.code}  ${r.error}`)
      line(`  → ${rel.html_url}`)
    }
  }

  // ⑤ 回读最终状态
  hr('结果')
  const final = await ghApi(`repos/${TARGET}/releases/tags/${tag}`)
  line(`release    ${final.html_url}`)
  line(`tag        ${final.tag_name}`)
  if (final.assets && final.assets.length > 0) {
    line('assets:')
    for (const a of final.assets) {
      line(`  · ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB  下载 ${a.browser_download_url}`)
    }
  } else {
    line('assets     （空 —— 需要手动上传）')
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\nPUBLISH_RELEASE_FAIL', String(err && err.message).slice(0, 500))
    process.exit(1)
  })
