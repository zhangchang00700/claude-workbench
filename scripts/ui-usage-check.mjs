// 验证用量看板渲染：进「用量看板」页，读金额/token/供应商表
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PORT = Number(process.env.UI_CHECK_PORT || 9466)
const MUST = ['估算费用', '输入 token', '输出 token', '按供应商']
if (!EXE) {
  console.log('usage: node scripts/ui-usage-check.mjs <exe>')
  process.exit(3)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// UI_CHECK_DEV=1：用 electron.exe 加载项目目录（跑 out/ 构建产物）
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
try {
  const p = await page()
  if (!p) {
    console.log('USAGE_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(p.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(1200)
  await c.send('Runtime.evaluate', {
    expression: "Array.from(document.querySelectorAll('button')).find(b=>b.innerText.includes('用量看板'))?.click()",
    returnByValue: true
  })
  await sleep(2000)
  const r = await c.send('Runtime.evaluate', {
    expression: "JSON.stringify({t:(document.body.innerText||'')})",
    returnByValue: true
  })
  const text = JSON.parse(r.result?.result?.value || '{}').t || ''
  c.close()
  // 卡片标签被 CSS uppercase 渲染，比较时统一小写
  const lower = text.toLowerCase()
  const missing = MUST.filter((m) => !lower.includes(m.toLowerCase()))
  const money = /估算费用\s*\n?\s*(¥[\d.]+|—)/.exec(text)?.[1] ?? '(未读到)'
  const tokLine = /输入 token\s*\n?\s*([\d.]+k?|-)/.exec(text)?.[1] ?? '(未读到)'
  console.log('missing=' + JSON.stringify(missing))
  console.log('total_cost=' + money + ' input_tokens=' + tokLine)
  if (missing.length > 0) console.log('excerpt=' + text.slice(0, 500).replace(/\n/g, ' ⏎ '))
  console.log(missing.length === 0 ? 'USAGE_PASS' : 'USAGE_FAIL')
  process.exit(missing.length === 0 ? 0 : 1)
} catch (err) {
  console.log('USAGE_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}