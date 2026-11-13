// 真实链路烟测（v0.3.0 agent 通道）：
// 建一条智能体任务（plan 模式，不实际执行工具）→ 开始 → 等它跑完 → 断言拿到模型回复 → 清理。
// 与 ui-taskmode-check 的区别：那个只验 UI 与入队，这个真的走 claude CLI + 路由站。
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PORT = Number(process.env.UI_CHECK_PORT || 9483)
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 180000)
if (!EXE) {
  console.log('usage: node scripts/ui-taskagent-live.mjs <exe>')
  process.exit(3)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const devArgs = process.env.UI_CHECK_DEV === '1' ? ['.'] : []
const child = spawn(EXE, [...devArgs, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })

async function page() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && /index\.html/.test(t.url ?? ''))
      if (p) return p
    } catch {
      /* wait */
    }
    await sleep(1000)
  }
  return null
}
function cdp(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const ready = new Promise((r) => (ws.onopen = r))
  return {
    ready,
    send: async (method, params = {}) => {
      await ready
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method, params }))
      return new Promise((r) => pending.set(mid, r))
    },
    close: () => ws.close()
  }
}
const evalJs = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

// 断言不能看「输出含某词」——prompt 本身就含该词会假阳性。
// 改用模型必须计算得出的答案：prompt 里没有 81，只有模型算对才出现。
const PROMPT = '计算 9 的平方，只回复阿拉伯数字，不要任何解释。'
const EXPECT_RE = /(^|[^\d])81([^\d]|$)/

let pass = false
try {
  const p = await page()
  if (!p) {
    console.log('LIVE_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(p.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(1500)

  // 进入任务队列
  await evalJs(
    c,
    `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '任务队列'); if (b) b.click(); return 'ok' })()`
  )
  await sleep(900)

  // 选智能体通道
  await evalJs(
    c,
    `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '智能体'); if (b) b.click(); return 'ok' })()`
  )
  await sleep(500)

  // 权限设为「只做计划不执行」：最安全，不会真改文件
  const perm = await evalJs(
    c,
    `(() => {
      const sels = Array.from(document.querySelectorAll('select'))
      const sel = sels.find((s) => Array.from(s.options).some((o) => o.value === 'plan'))
      if (!sel) return 'no_plan_select'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(sel, 'plan')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return 'plan_set'
    })()`
  )
  await sleep(300)

  // 填 prompt
  await evalJs(
    c,
    `(() => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no_textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(PROMPT)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 'filled'
    })()`
  )
  await sleep(300)

  // 加入队列
  const added = await evalJs(
    c,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '加入队列')
      if (!b) return 'no_add'
      if (b.disabled) return 'disabled'
      b.click()
      return 'added'
    })()`
  )
  await sleep(1200)

  // 开始执行
  const started = await evalJs(
    c,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '开始')
      if (!b) return 'no_start'
      if (b.disabled) return 'start_disabled'
      b.click()
      return 'started'
    })()`
  )
  console.log(`perm=${perm} add=${added} start=${started} （真实执行中，最多等 ${Math.round(TIMEOUT_MS / 1000)}s）`)

  // 轮询任务状态：等到不再有 running / queued
  let state = ''
  const t0 = Date.now()
  let sawRunning = false
  while (Date.now() - t0 < TIMEOUT_MS) {
    const snap = await evalJs(
      c,
      `(() => {
        const body = document.body.innerText || ''
        return JSON.stringify({
          running: body.includes('执行中'),
          queued: body.includes('排队中'),
          done: body.includes('完成'),
          failed: body.includes('失败')
        })
      })()`
    )
    const st = JSON.parse(snap || '{}')
    if (st.running) sawRunning = true
    if (!st.running && !st.queued) {
      state = st.failed && !st.done ? 'failed' : st.done ? 'done' : 'unknown'
      break
    }
    await sleep(2500)
  }
  const elapsed = Math.round((Date.now() - t0) / 1000)
  console.log(`等结果 ${elapsed}s → state=${state || 'timeout'} 出现过执行中=${sawRunning}`)

  // 展开输出读取正文（优先读 <pre> 里的真实输出，而不是整页文本，避免 prompt 混入）
  const opened = await evalJs(
    c,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.trim() === '查看输出')
      if (!b) return 'no_detail_btn'
      b.click()
      return 'opened'
    })()`
  )
  await sleep(900)
  const outText = await evalJs(
    c,
    `(() => {
      const pres = Array.from(document.querySelectorAll('pre')).map((p) => p.innerText || '')
      return JSON.stringify({ pre: pres.join('\\n---\\n'), body: (document.body.innerText || '') })
    })()`
  )
  const parsed = JSON.parse(outText || '{}')
  const pre = parsed.pre || ''
  const body = parsed.body || ''
  const hasReply = EXPECT_RE.test(pre)

  // 读取失败原因（若有）
  const errLine = (body.split('\n').find((l) => l.includes('错误：')) || '').trim()
  if (!hasReply && pre) console.log('输出片段：' + pre.slice(0, 300).replace(/\n/g, ' ⏎ '))

  // 清理：删掉自检任务（按任务标题里的「9 的平方」定位，不依赖输出内容）
  await evalJs(
    c,
    `(() => {
      const rows = Array.from(document.querySelectorAll('div')).filter((d) =>
        (d.innerText || '').includes('9 的平方') && (d.innerText || '').includes('删除')
      )
      const row = rows[rows.length - 1]
      if (!row) return 'no_row'
      const b = Array.from(row.querySelectorAll('button')).find((x) => x.innerText.trim() === '删除')
      if (b) b.click()
      return 'deleted'
    })()`
  )
  await sleep(1000)

  pass = state === 'done' && hasReply
  console.log(`展开=${opened} 输出含计算结果 81=${hasReply}`)
  if (errLine) console.log('失败原因：' + errLine.slice(0, 200))
  console.log(pass ? 'AGENT_LIVE_OK' : 'AGENT_LIVE_FAIL')
  c.close()
  process.exit(pass ? 0 : 1)
} catch (err) {
  console.log('AGENT_LIVE_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}
