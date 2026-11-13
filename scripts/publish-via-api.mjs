// 通过 GitHub REST API（api.github.com，gh 认证）把当前工作树发布到远端 main。
// 背景：本机代理只放行 api.github.com，github.com 的 CONNECT 被拒（git push 永远 502），
// 因此 git 协议推不动；改走 Git Data API：blob → tree → commit → ref。
// 注意：① 空仓库需先用 Contents API 引导首个提交（Git Data API 在无提交仓库上 409）；
//      ② API 产生的远端提交与本地历史不同源（相当于发布当前快照）。
// 用法：node scripts/publish-via-api.mjs [owner/repo] [branch]
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = process.argv[2] ?? 'zhangchang00700/claude-workbench'
const BRANCH = process.argv[3] ?? 'main'
const API = `repos/${TARGET}`
const GIT_API = `${API}/git`

function gitTracked() {
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024
  }).toString('utf8')
  return stdout.split('\0').filter(Boolean)
}

/** gh api 调用：payload 走临时文件（Windows 下 stdin 偶发被弄坏成 400） */
let tmpSeq = 0
async function gh(endpoint, body, method = 'POST') {
  const args = ['api', endpoint, '-X', method]
  let tmp
  if (body !== undefined) {
    tmp = path.join(os.tmpdir(), `cw-gh-${process.pid}-${++tmpSeq}.json`)
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

/** 提交说明按 package.json 版本动态生成，避免远端历史永远停在「v0.1.1 初始发布」。 */
function releaseMessage(fileCount) {
  let version = 'unknown'
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    /* 读不到就留 unknown，不阻断同步 */
  }
  let title = ''
  try {
    const notes = fs.readFileSync(
      path.join(ROOT, 'docs', 'release-notes', `v${version}.md`),
      'utf8'
    )
    title = (notes.split(/\r?\n/).find((line) => /^#\s+/.test(line)) ?? '').replace(/^#\s+/, '').trim()
  } catch {
    /* 没有该版本的说明文件就不带标题 */
  }
  const summary = `通过 GitHub Git Data API 同步当前工作树快照（${fileCount} 个受控文件）。`
  return `chore(release): ClaudeWorkbench v${version} 快照同步\n\n${title ? `${title}\n\n` : ''}${summary}`
}

async function main() {
  const files = gitTracked()
  console.log(`tracked files: ${files.length}`)

  // 空仓库引导：Git Data API 在无提交的仓库上会 409，先用 Contents API 建首个提交
  let ref = null
  try {
    ref = await gh(`${GIT_API}/ref/heads/${BRANCH}`, undefined, 'GET')
  } catch {
    ref = null
  }
  if (!ref || !ref.object) {
    console.log('repo empty → bootstrap first commit via Contents API')
    const seed = files.includes('README.md') ? 'README.md' : files[0]
    const b64 = fs.readFileSync(path.join(ROOT, seed)).toString('base64')
    await gh(`${API}/contents/${seed}`, { message: 'bootstrap', content: b64 }, 'PUT')
    ref = await gh(`${GIT_API}/ref/heads/${BRANCH}`, undefined, 'GET')
    console.log(`bootstrap done, ${BRANCH} @ ${ref.object.sha.slice(0, 8)}`)
  }

  const entries = []
  const cacheFile = path.join(os.tmpdir(), `cw-publish-cache-${TARGET.replaceAll('/', '_')}.json`)
  let cache = {}
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch {
    /* 无缓存 */
  }
  let done = 0
  let retried = 0
  const CONC = 2
  const queue = [...files]
  const fails = []
  async function worker() {
    for (;;) {
      const f = queue.shift()
      if (!f) return
      const abs = path.join(ROOT, f)
      const st = fs.statSync(abs)
      const key = `${f}:${st.size}:${Math.floor(st.mtimeMs / 60000)}`
      let sha = cache[key]
      if (!sha) {
        const b64 = fs.readFileSync(abs).toString('base64')
        let lastErr = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const blob = await gh(`${GIT_API}/blobs`, { content: b64, encoding: 'base64' })
            sha = blob.sha
            break
          } catch (err) {
            lastErr = err
            retried++
            await new Promise((r) => setTimeout(r, attempt * 3000))
          }
        }
        if (!sha) {
          fails.push(`${f} (${(st.size / 1024) | 0}KB): ${String(lastErr && lastErr.message).slice(0, 160)}`)
          done++
          continue
        }
        cache[key] = sha
        fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8')
      }
      entries.push({ path: f, mode: '100644', type: 'blob', sha })
      done++
      if (done % 20 === 0) console.log(`  blobs ${done}/${files.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  if (fails.length > 0) {
    console.error('FAILED_BLOBS:')
    fails.forEach((f) => console.error('  ' + f))
    console.error(`PUBLISH_FAIL ${fails.length} 个文件上传失败（重试 ${retried} 次后）`)
    process.exit(1)
  }
  console.log(`blobs all uploaded (cache hits excluded, retries=${retried})`)

  const tree = await gh(`${GIT_API}/trees`, { tree: entries })
  const parentSha = ref && ref.object ? ref.object.sha : undefined

  // 内容没变就不要制造一条空提交（重复同步是常态）
  if (parentSha) {
    try {
      const parent = await gh(`${GIT_API}/commits/${parentSha}`, undefined, 'GET')
      if (parent.tree && parent.tree.sha === tree.sha) {
        console.log(`NO_CHANGES tree=${tree.sha.slice(0, 8)}; ${BRANCH} already up to date`)
        console.log(`PUBLISHED ${TARGET}@${BRANCH} commit=${parentSha} files=${entries.length} (unchanged)`)
        return
      }
    } catch {
      /* 读不到父提交就照常提交 */
    }
  }

  // 挂上 parent，让公开仓库保留连续的迭代历史（原来是每次一条孤立提交）
  const body = { message: releaseMessage(entries.length), tree: tree.sha }
  if (parentSha) body.parents = [parentSha]
  const commit = await gh(`${GIT_API}/commits`, body)
  if (ref && ref.object) {
    await gh(`${GIT_API}/refs/heads/${BRANCH}`, { sha: commit.sha, force: true }, 'PATCH')
    console.log('updated existing ref')
  } else {
    await gh(`${GIT_API}/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
    console.log('created new ref')
  }
  console.log(`PUBLISHED ${TARGET}@${BRANCH} commit=${commit.sha} files=${entries.length}`)
}

main().catch((err) => {
  console.error('PUBLISH_FAIL', String(err && err.message).slice(0, 400))
  process.exit(1)
})
