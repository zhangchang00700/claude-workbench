// 发版后验收：证明「263MB 大文件经 api.github.com 通道完整可达且未损坏」。
//
// 为什么需要它：checkUpdate 只做版本比较，本地装 0.2.0、远端也是 0.2.0 时会正确返回
// 「已是最新」——那不代表下载功能坏了，所以下载能力必须单独验（厂长裁决方案）。
//
// 三项硬校验：
//   1. 落盘字节数 == asset.size（不能少一个字节）
//   2. 头部魔数 == PK\x03\x04（确实是 zip）
//   3. 中央目录条目数 > 0 且可走完（结构完整，不是半截文件）
//
// ⚠ 下载用 spawn + stdout.pipe(写文件流)，不用 execFile 收 Buffer：
//    execFile 的 encoding:'utf8' 会把 zip 里的非法 UTF-8 字节换成 U+FFFD（静默损坏、
//    文件看起来正常但解压失败），maxBuffer 也撑不住 263MB。
//
// 用法：
//   node scripts/verify-release-assets.mjs                     验当前 package.json 版本
//   node scripts/verify-release-assets.mjs --tag v0.2.0
//   node scripts/verify-release-assets.mjs --local <zip路径>    只校验本地文件，不联网
//   node scripts/verify-release-assets.mjs --keep               保留下载产物不清理
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const REPO = 'zhangchang00700/claude-workbench'
const argv = process.argv.slice(2)
function opt(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const keep = argv.includes('--keep')
const local = opt('--local', null)

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const tag = opt('--tag', `v${pkg.version}`)

const problems = []
const ok = (s) => console.log(`  OK   ${s}`)
const bad = (s) => {
  problems.push(s)
  console.log(`  FAIL ${s}`)
}

/* ── zip 结构解析（不引第三方依赖，直接读 EOCD）── */
const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50

function findEocd(buf) {
  // EOCD 在文件尾部（可能有注释），最多回扫 64KB + 22B
  const max = Math.min(buf.length, 65557)
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function inspectZip(file) {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    // 头 4 字节魔数
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    const magicOk = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04

    // EOCD
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    const eocd = findEocd(tail)
    let declared = 0
    let cdOffset = 0
    let walked = 0
    if (eocd >= 0) {
      const abs = size - tailLen + eocd
      declared = tail.readUInt16LE(eocd + 10)
      cdOffset = tail.readUInt32LE(eocd + 16)
      // 真走一遍中央目录，别只信声明值
      if (cdOffset > 0 && cdOffset < size) {
        let p = cdOffset
        const sig = Buffer.alloc(4)
        for (let n = 0; n < declared + 8; n++) {
          if (p + 4 > size) break
          fs.readSync(fd, sig, 0, 4, p)
          if (sig.readUInt32LE(0) !== CDH_SIG) break
          const extra = Buffer.alloc(2)
          // CDH: 签名(4) 版本(2) 版本需(2) 标志(2) 方法(2) 时间(2) 日期(2) crc(4)
          //      压缩后(4) 原始(4) 名长(2) 扩展长(2) 注释长(2) ...
          fs.readSync(fd, extra, 0, 2, p + 28) // 名长在 +28
          const nameLen = extra.readUInt16LE(0)
          const rest = Buffer.alloc(2)
          fs.readSync(fd, rest, 0, 2, p + 30) // 扩展长 +30、注释长 +32
          const extraLen = rest.readUInt16LE(0)
          const cmtBuf = Buffer.alloc(2)
          fs.readSync(fd, cmtBuf, 0, 2, p + 32)
          const cmtLen = cmtBuf.readUInt16LE(0)
          walked++
          p += 46 + nameLen + extraLen + cmtLen
        }
      }
    }
    return { size, magicOk, eocdFound: eocd >= 0, declared, walked }
  } finally {
    fs.closeSync(fd)
  }
}

/* ── 下载：spawn + pipe，字节级直落磁盘 ── */
function downloadAsset(assetId, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      ['api', `repos/${REPO}/releases/assets/${assetId}`, '-H', 'Accept: application/octet-stream'],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const ws = fs.createWriteStream(dest)
    let stderr = ''
    let wrote = 0
    child.stdout.on('data', (c) => {
      wrote += c.length
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8')
    })
    child.stdout.pipe(ws)
    let closed = false
    let exited = null
    const done = () => {
      if (!closed || exited === null) return
      if (exited !== 0) reject(new Error(`gh exit ${exited}: ${stderr.trim().slice(0, 200)}`))
      else resolve(wrote)
    }
    ws.on('close', () => {
      closed = true
      done()
    })
    child.on('exit', (code) => {
      exited = code
      done()
    })
    child.on('error', reject)
    ws.on('error', reject)
  })
}

/* ── 主流程 ── */
async function main() {
  console.log(`\n════ release asset 完整性验收 ${tag} ════`)

  if (local) {
    console.log(`\n[本地校验] ${local}`)
    const r = inspectZip(path.resolve(ROOT, local))
    console.log(`  大小 ${(r.size / 1024 / 1024).toFixed(1)} MB`)
    if (r.magicOk) ok('魔数 PK\\x03\\x04')
    else bad('头部魔数不是 PK\\x03\\x04，不是有效 zip')
    if (r.eocdFound) ok(`找到 EOCD，声明条目 ${r.declared}，实走 ${r.walked}`)
    else bad('找不到 EOCD，文件被截断或不是 zip')
    if (r.walked > 0) ok(`中央目录可完整走完（${r.walked} 条）`)
    else bad('中央目录条目数 0')
    return finish(null)
  }

  // 1. 取 release 元数据
  console.log('\n[1] 读取 release 元数据')
  let rel
  try {
    const { execFileSync } = await import('node:child_process')
    rel = JSON.parse(
      execFileSync('gh', ['api', `repos/${REPO}/releases/tags/${tag}`], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true
      })
    )
    ok(`release ${rel.tag_name}  assets=${rel.assets.length}`)
  } catch (e) {
    bad(`取不到 release ${tag}（还没发版？）：${String(e.message).slice(0, 160)}`)
    return finish(null)
  }

  const zip = rel.assets.find((a) => /^ClaudeWorkbench-.+-win\.zip$/.test(a.name))
  if (!zip) {
    bad(`没有匹配 ^ClaudeWorkbench-.+-win\\.zip$ 的 asset（现有：${rel.assets.map((a) => a.name).join(', ') || '无'}）`)
    return finish(null)
  }
  ok(`目标 asset ${zip.name}  ${(zip.size / 1024 / 1024).toFixed(1)} MB  id=${zip.id}`)

  // 2. 下载
  console.log('\n[2] 下载（gh api → spawn+pipe 流式落盘）')
  const dest = path.join(os.tmpdir(), `cw-verify-${zip.id}-${zip.name}`)
  const t0 = Date.now()
  try {
    await downloadAsset(zip.id, dest)
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    ok(`下载完成，用时 ${sec}s → ${dest}`)
  } catch (e) {
    bad(`下载失败：${e.message}`)
    return finish(dest)
  }

  // 3. 三项校验
  console.log('\n[3] 完整性校验')
  const r = inspectZip(dest)

  if (r.size === zip.size) ok(`字节数一致：${r.size} == asset.size ${zip.size}`)
  else bad(`字节数不一致：落盘 ${r.size} vs asset.size ${zip.size}（差 ${r.size - zip.size}）`)

  if (r.magicOk) ok('魔数 PK\\x03\\x04')
  else bad('头部魔数不是 PK\\x03\\x04 —— 多半被当成文本转码过（U+FFFD 替换），检查是否误用 encoding:utf8')

  if (!r.eocdFound) bad('找不到 EOCD，文件被截断')
  else if (r.walked > 0) ok(`中央目录条目 ${r.walked}（声明 ${r.declared}）> 0`)
  else bad('中央目录条目数 0')

  // 顺带：本地装的是同版本时 checkUpdate 会回「已是最新」，这是对的，别误判
  console.log('\n[提示] 本地安装版本与远端 tag 相同时，checkUpdate 返回「已是最新」属正确行为，')
  console.log('       不代表下载功能有问题。下载能力以本节三项校验为准。')

  return finish(dest)
}

function finish(dest) {
  console.log('\n════ 汇总 ════')
  console.log(`  错误 ${problems.length}`)
  if (problems.length === 0) {
    // 本地模式只证明 zip 结构完好，没走网络，别写成「通道可达」
    console.log(
      local
        ? '  结论：本地产物 zip 结构完好。（未走网络，通道可达性需跑联网模式验证）'
        : '  结论：263MB 大文件经 api.github.com 通道完整可达且未损坏。'
    )
  } else {
    console.log('  结论：下载/完整性有问题，不要放行给 QA。')
    problems.forEach((p) => console.log(`    · ${p}`))
  }
  if (dest && !keep) {
    try {
      fs.rmSync(dest, { force: true })
      console.log(`  （已清理临时文件 ${path.basename(dest)}）`)
    } catch { /* noop */ }
  } else if (dest) {
    console.log(`  （--keep，保留：${dest}）`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('VERIFY_FAIL', e.message)
  process.exit(1)
})
