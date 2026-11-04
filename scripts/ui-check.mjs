// UI smoke: launch the packaged app with a remote debugging port, attach over CDP,
// and assert the renderer actually rendered (not a blank screen).
// Node 22+ has a global WebSocket. ASCII-only output.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PORT = Number(process.env.UI_CHECK_PORT || 9333)
if (!EXE) {
  console.log('usage: node scripts/ui-check.mjs <exe>')
  process.exit(3)
}

// Strip ELECTRON_RUN_AS_NODE: a polluted host shell makes the packaged exe run as
// plain Node, so no window and no CDP target ever appear.
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: false, env: childEnv })

async function waitForTargets() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      // 主窗口 = 加载 index.html 的 page（应用还有宠物等副窗口，不能抓错）
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url ?? ''))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  return null
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(String(msg.params?.exceptionDetails?.text ?? 'exception'))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push(String(msg.params.args?.[0]?.value ?? 'console.error'))
    }
  }
  const ready = new Promise((res) => (ws.onopen = res))
  const send = async (method, params = {}) => {
    await ready
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((res) => pending.set(mid, res))
  }
  return { send, errors, close: () => ws.close(), ready }
}

try {
  const page = await waitForTargets()
  if (!page) {
    console.log('UI_CHECK_FAIL no_cdp_target')
    process.exit(1)
  }
  console.log('target url=' + page.url + ' title=' + page.title)

  const c = cdp(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(1500)

  const evalRes = await c.send('Runtime.evaluate', {
    expression:
      "JSON.stringify({ text: (document.body.innerText||'').slice(0,300), btns: Array.from(document.querySelectorAll('button')).map(b=>b.innerText).slice(0,10), hasApi: typeof window.workbench })",
    returnByValue: true
  })
  const val = evalRes.result?.result?.value
  console.log('dom=' + val)
  const parsed = JSON.parse(val || '{}')
  let ok =
    parsed.hasApi === 'object' &&
    typeof parsed.text === 'string' &&
    parsed.text.includes('ClaudeWorkbench') &&
    parsed.btns.includes('模型路由站')
  if (c.errors.length) console.log('page_errors=' + JSON.stringify(c.errors.slice(0, 5)))

  // 可选第二检：ui-check.mjs <exe> templates —— 点进「模板流水线」面板验证渲染
  if (ok && process.argv[3] === 'templates') {
    const before = c.errors.length
    await c.send('Runtime.evaluate', {
      expression:
        "Array.from(document.querySelectorAll('button')).find(b=>b.innerText.includes('模板流水线'))?.click()",
      returnByValue: true
    })
    await sleep(1000)
    const tplRes = await c.send('Runtime.evaluate', {
      expression:
        "JSON.stringify({ text: (document.body.innerText||'').slice(0,200), editors: document.querySelectorAll('textarea').length })",
      returnByValue: true
    })
    const tpl = JSON.parse(tplRes.result?.result?.value || '{}')
    const newErrors = c.errors.length - before
    ok = typeof tpl.text === 'string' && tpl.text.includes('模板') && newErrors === 0
    console.log('templates_page=' + JSON.stringify({ ...tpl, newErrors }))
  }

  c.close()
  console.log(ok ? 'UI_CHECK_PASS' : 'UI_CHECK_FAIL')
  process.exit(ok ? 0 : 1)
} catch (err) {
  console.log('UI_CHECK_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}
