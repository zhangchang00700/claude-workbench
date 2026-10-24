// 一条命令出包：bump 版本 → 构建 → 打包到 release-v<version> → 自动清理旧目录（保留最新 2 个）。
// 用法：npm run ship
//       npm run ship -- --no-bump   跳过版本递增（仅重打包当前版本）
// 产物：release-v<version>/ClaudeWorkbench-<version>-win.zip（便携 exe 同名）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const noBump = args.includes('--no-bump')

function run(cmd, cmdArgs) {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}`)
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
}

if (!noBump) {
  // npm 自身改 package.json，格式安全（不用文本替换）
  run('npm', ['version', 'patch', '--no-git-tag-version'])
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const outDir = `release-v${version}`
console.log(`\n版本 ${version} → 输出目录 ${outDir}`)

run('npm', ['run', 'build'])
run('npx', [
  'electron-builder',
  '--win',
  '-c',
  'electron-builder.ship.yml',
  `-c.directories.output=${outDir}`
])

// 构建成功后自动瘦身（保留最新 2 个 release 目录）
run('node', ['scripts/clean-releases.mjs', '--yes', '--keep=2'])

// 汇报产物
const zip = path.join(ROOT, outDir, `ClaudeWorkbench-${version}-win.zip`)
const exe = path.join(ROOT, outDir, `ClaudeWorkbench-${version}-win.exe`)
for (const f of [zip, exe]) {
  if (fs.existsSync(f)) console.log(`产物 ${path.basename(f)}  ${Math.round(fs.statSync(f).size / 1024 / 1024)} MB`)
  else console.log(`缺失 ${path.basename(f)}`)
}
