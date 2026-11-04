// 打包前置 dry 检查：只读、不构建、不删任何东西。
// 在真正 npm run ship 之前跑一遍，把「配错了 / 版本不对 / 产物缺失」提前暴露出来。
// 用法：node scripts/check-ship.mjs [--expect 0.2.0] [--config electron-builder.ship.yml]
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
function opt(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const CONFIG = opt('--config', 'electron-builder.ship.yml')
const EXPECT = opt('--expect', null)

let yaml
for (const m of ['yaml', 'js-yaml']) {
  try {
    yaml = await import(m)
    break
  } catch { /* 换下一个 */ }
}
if (!yaml) {
  console.error('找不到 yaml 解析器（yaml / js-yaml），无法校验配置')
  process.exit(1)
}
const load = yaml.load ?? yaml.parse

const problems = []
const warns = []
const ok = (s) => console.log(`  OK   ${s}`)
const bad = (s) => {
  problems.push(s)
  console.log(`  FAIL ${s}`)
}
const warn = (s) => {
  warns.push(s)
  console.log(`  WARN ${s}`)
}

console.log(`\n════ 打包前置检查（dry） 配置=${CONFIG} ════`)

/* 1. package.json */
console.log('\n[1] package.json')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
console.log(`  version = ${version}`)
if (!/^\d+\.\d+\.\d+/.test(version)) bad(`version 不是合法 semver: ${version}`)
else ok('version 合法')

if (EXPECT) {
  if (version === EXPECT) ok(`版本已就位 ${EXPECT}`)
  else bad(`期望版本 ${EXPECT}，实际 ${version}`)
}

// npm version patch 只能升第三段；要 0.2.0 必须走 minor
const [maj, min, pat] = version.split('.').map(Number)
console.log(`  参考：npm version patch → ${maj}.${min}.${pat + 1}；npm version minor → ${maj}.${min + 1}.0`)
if (EXPECT) {
  const [eMaj, eMin] = EXPECT.split('.').map(Number)
  if (eMin > min) {
    console.log(`  → 要发 ${EXPECT} 属 minor 升级，ship 默认的 patch 到不了，请先手动执行：`)
    console.log(`     npm version minor --no-git-tag-version`)
    console.log(`     npm run ship -- --no-bump`)
  }
}

/* 2. 打包配置 */
console.log(`\n[2] ${CONFIG}`)
const cfgPath = path.join(ROOT, CONFIG)
if (!fs.existsSync(cfgPath)) {
  bad(`配置文件不存在: ${CONFIG}`)
} else {
  ok('配置文件存在')
  let cfg
  try {
    cfg = load(fs.readFileSync(cfgPath, 'utf8'))
    ok('YAML 可解析')
  } catch (e) {
    bad(`YAML 解析失败: ${e.message}`)
  }
  if (cfg) {
    const productName = cfg.productName ?? pkg.name
    console.log(`  appId=${cfg.appId}  productName=${productName}`)

    if (cfg.directories?.output) ok(`输出目录 ${cfg.directories.output}（ship 时被 -c.directories.output=release-v<ver> 覆盖）`)
    else warn('未配置 directories.output')

    const an = cfg.win?.artifactName ?? cfg.artifactName
    if (!an) bad('未配置 artifactName')
    else if (an.includes('${version}')) ok(`artifactName 含 \${version} → ${an}`)
    else bad(`artifactName 不含 \${version}，多版本产物会同名互相覆盖：${an}`)

    const targets = (cfg.win?.target ?? []).map((t) => (typeof t === 'string' ? t : t.target))
    if (targets.length === 0) bad('win.target 为空')
    else ok(`win.target = ${targets.join(', ')}`)

    if (cfg.publish) ok(`publish 已配置（会生成 latest.yml，electron-updater 依赖它）\n       ${JSON.stringify(cfg.publish)}`)
    else warn('未配置 publish → 不会生成 latest.yml，electron-updater 自动更新将失效')

    if (cfg.electronDist) {
      if (fs.existsSync(path.join(ROOT, cfg.electronDist))) ok(`electronDist 存在：${cfg.electronDist}`)
      else bad(`electronDist 不存在：${cfg.electronDist}`)
    }

    const br = cfg.directories?.buildResources
    if (br) {
      if (fs.existsSync(path.join(ROOT, br))) ok(`buildResources 存在：${br}`)
      else warn(`buildResources 目录不存在：${br}（electron-builder 通常容忍，但会丢自定义图标）`)
    }

    /* 3. 产物 + 更新通道契约（对齐 be 的 checkUpdate/downloadUpdate）*/
    console.log('\n[3] 产物 / 更新通道契约')
    const outDir = path.join(ROOT, `release-v${version}`)
    if (!fs.existsSync(outDir)) {
      warn(`产物目录不存在：release-v${version}（还没构建）`)
    } else {
      const files = fs.readdirSync(outDir).filter((n) => fs.statSync(path.join(outDir, n)).isFile())
      const expectNames = targets
        .map((t) => (t === 'zip' ? `${productName}-${version}-win.zip` : null))
        .filter(Boolean)
      // portable 出的是 exe
      const zip = files.find((n) => n.endsWith('.zip'))
      const exe = files.find((n) => n.endsWith('.exe'))
      const yml = files.find((n) => n === 'latest.yml')
      if (zip) ok(`zip  ${zip}  ${(fs.statSync(path.join(outDir, zip)).size / 1024 / 1024).toFixed(1)} MB`)
      else warn('没有 .zip 产物')
      if (exe) ok(`exe  ${exe}  ${(fs.statSync(path.join(outDir, exe)).size / 1024 / 1024).toFixed(1)} MB`)
      else warn('没有 .exe 产物')
      if (yml) ok(`latest.yml 已生成（自动更新可用）`)
      else warn('没有 latest.yml → 自动更新检测会拿不到版本信息')
      if (expectNames.length) console.log(`  期望名：${expectNames.join(', ')}`)
    }

    // 主进程侧（be）的硬约束：zip 名必须匹配 /^ClaudeWorkbench-.+-win\.zip$/
    // 不匹配 → downloadUpdate 直接回「未找到安装包 asset」，不会猜第二个候选
    const ZIP_RE = /^ClaudeWorkbench-.+-win\.zip$/
    const wantZip = `${productName}-${version}-win.zip`
    if (ZIP_RE.test(wantZip)) ok(`zip 名满足更新通道正则 → ${wantZip}`)
    else bad(`zip 名不满足更新通道正则 /^ClaudeWorkbench-.+-win\\.zip$/ → ${wantZip}`)

    // tag 必须 vX.Y.Z；且 package.json version 必须与 tag 对齐，
    // 否则 app.getVersion() 永远低于远端 tag，用户会反复看到「有新版本」
    const TAG_RE = /^v\d+\.\d+\.\d+$/
    const wantTag = `v${version}`
    if (TAG_RE.test(wantTag)) ok(`tag 格式合法 → ${wantTag}`)
    else bad(`tag 格式不合法（需 vX.Y.Z）→ ${wantTag}`)
    console.log(`  对齐检查：app.getVersion() 将等于 ${version}，远端 tag ${wantTag} → ${
      `v${version}` === wantTag ? '一致' : '不一致，会导致更新提示反复弹出'
    }`)
  }
}

/* 4. 发版脚本 */
console.log('\n[4] 发版链路')
for (const f of ['scripts/ship.mjs', 'scripts/publish-release.mjs', 'scripts/clean-releases.mjs']) {
  if (fs.existsSync(path.join(ROOT, f))) ok(f)
  else bad(`缺少 ${f}`)
}
const notes = path.join(ROOT, 'docs', 'release-notes', `v${EXPECT ?? version}.md`)
if (fs.existsSync(notes)) ok(`更新说明 docs/release-notes/v${EXPECT ?? version}.md`)
else warn(`更新说明缺失：docs/release-notes/v${EXPECT ?? version}.md`)

/* 汇总 */
console.log('\n════ 汇总 ════')
console.log(`  错误 ${problems.length}  警告 ${warns.length}`)
if (problems.length === 0) console.log('  结论：可以打包。')
else console.log('  结论：先修掉上面的 FAIL 再打包。')
process.exit(problems.length === 0 ? 0 : 1)
