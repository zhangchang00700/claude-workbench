// 清理旧 release 目录：只保留最新的 N 个（默认 2），其余移入回收站（可还原）。
// 用法：node scripts/clean-releases.mjs            → 只打印将删除什么（dry-run）
//       node scripts/clean-releases.mjs --yes      → 真删（进回收站）
//       node scripts/clean-releases.mjs --yes --keep=1
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const apply = args.includes('--yes')
/** 回收站不可用（非交互会话）时，只有显式 --permanent 才永久删除 */
const permanent = args.includes('--permanent')
const keepArg = args.find((a) => a.startsWith('--keep='))
const keep = Math.max(1, Number(keepArg ? keepArg.split('=')[1] : 2) || 2)

/** release / release-vN / release-fresh 一类的构建产物目录 */
function isReleaseDir(name) {
  return name === 'release' || /^release[-_.]/i.test(name)
}

function sizeMB(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else total += fs.statSync(p).size
      } catch {
        /* 跳过被占用的文件 */
      }
    }
  }
  walk(dir)
  return total / 1024 / 1024
}

/**
 * 排序键：只把 release-v<major>.<minor>.<patch> 视为「版本目录」；
 * 旧命名 release-v14（无点号，实为第 14 次打包）视为遗留目录，排在版本目录之后按 mtime 排。
 * 教训（2026-10-19）：曾按 mtime 排序，把正在使用的 release-v14 判为「旧」而误删；
 * 也不能把 v14 当 14.0.0，否则它会压过新版本。
 */
function sortKey(d) {
  const m = /^release-v(\d+)\.(\d+)\.(\d+)$/i.exec(d.name)
  if (m) {
    const weight = Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3])
    return { versioned: true, weight, mtime: d.mtime }
  }
  return { versioned: false, weight: 0, mtime: d.mtime }
}

const dirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && isReleaseDir(e.name))
  .map((e) => {
    const full = path.join(ROOT, e.name)
    return { name: e.name, full, mtime: fs.statSync(full).mtimeMs, mb: sizeMB(full) }
  })
  .sort((a, b) => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    if (ka.versioned !== kb.versioned) return ka.versioned ? -1 : 1 // 版本目录在前
    if (ka.versioned && ka.weight !== kb.weight) return kb.weight - ka.weight // 版本高在前
    return kb.mtime - a.mtime
  })

if (dirs.length <= keep) {
  console.log(`release 目录 ${dirs.length} 个，未超过保留上限 ${keep}，无需清理`)
  process.exit(0)
}

const keepDirs = dirs.slice(0, keep)
const dropDirs = dirs.slice(keep)
const dropMB = dropDirs.reduce((s, d) => s + d.mb, 0)

console.log(`保留 ${keepDirs.length} 个：`)
for (const d of keepDirs) console.log(`  keep  ${d.name}  ${Math.round(d.mb)} MB`)
console.log(`将移入回收站 ${dropDirs.length} 个（合计 ${Math.round(dropMB)} MB）：`)
for (const d of dropDirs) console.log(`  drop  ${d.name}  ${Math.round(d.mb)} MB`)

if (!apply) {
  console.log('\n这是 dry-run。确认无误后加 --yes 执行（进回收站，可还原）')
  process.exit(0)
}

// 用 .NET 回收站接口删除；非交互会话下会失败（"系统调用级别不正确"），
// 此时若显式给了 --permanent 才降级为永久删除（构建产物可由 git + npm install 重建）。
let freed = 0
let kept = 0
let failed = 0
for (const d of dropDirs) {
  const safe = d.full.replace(/'/g, "''")
  const recycleCmd = `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${safe}','OnlyErrorDialogs','SendToRecycleBin')`
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', recycleCmd], {
      stdio: 'pipe'
    })
    console.log(`  已移入回收站：${d.name}`)
    freed += d.mb
    continue
  } catch {
    /* 回收站不可用，走永久删除分支 */
  }
  if (!permanent) {
    console.log(`  跳过（回收站不可用，需 --permanent 才永久删除）：${d.name}`)
    failed++
    continue
  }
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[System.IO.Directory]::Delete('${safe}',$true)`],
      { stdio: 'pipe' }
    )
    console.log(`  已永久删除：${d.name}`)
    freed += d.mb
  } catch (err) {
    console.error(`  失败：${d.name} — ${String(err && err.message).slice(0, 160)}`)
    failed++
  }
}

console.log(
  `\n实际释放约 ${Math.round(freed)} MB` +
    (failed > 0 ? `；${failed} 个未删（回收站不可用时需加 --permanent）` : '')
)
