// GUI 端到端：启动打包版 → 在输入框真实发一条消息 → 等助手回复
// 用法: node scripts/ui-chat-check.mjs <exe> ["prompt"] ["期望包含的文本"]
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PROMPT = process.argv[3] || '只回复四个字：流程已打通'
const EXPECT = process.argv[4] || '流程已打通'
const PORT = Number(process.env.UI_CHECK_PORT || 9444)
if (!EXE) {
  console.log('usage: node scripts/ui-chat-check.mjs <exe>')
  process.exit(3)
}

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
// UI_CHECK_DEV=1：用 electron.exe 加载项目目录（跑 out/ 构建产物，免打包）
const devArgs = process.env.UI_CHECK_DEV === '1' ? ['.'] : []
const child = spawn(EXE, [...devArgs, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: childEnv })

async function waitForPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const ready = new Promise((res) => (ws.onopen = res))
  const send = async (method, params = {}) => {
    await ready
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((res) => pending.set(mid, res))
  }
  return { send, ready, close: () => ws.close() }
}

try {
  const page = await waitForPage()
  if (!page) {
    console.log('CHAT_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(2000)

  // 1) 先确认「可用供应商」数量与主用
  const before = await c.send('Runtime.evaluate', {
    expression: "JSON.stringify({text:(document.body.innerText||'').slice(0,400)})",
    returnByValue: true
  })
  const t0 = JSON.parse(before.result?.result?.value || '{}').text || ''
  const providers = /可用供应商\s*(\d+)\s*家[^\n]*/.exec(t0)?.[0] ?? '(未读到)'
  console.log('providers=' + providers)

  // 2) 填输入框并点发送（React 受控组件需用原生 setter 触发 input 事件）
  const fill = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no_textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(PROMPT)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '发送')
      if (!btn) return 'no_send_button'
      btn.click()
      return 'sent'
    })()`,
    returnByValue: true
  })
  const sent = fill.result?.result?.value
  console.log('send=' + sent)
  if (sent !== 'sent') {
    console.log('CHAT_FAIL ' + sent)
    c.close()
    process.exit(1)
  }

  // 3) 轮询等回复出现
  let ok = false
  let last = ''
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const r = await c.send('Runtime.evaluate', {
      expression: "JSON.stringify({text:(document.body.innerText||'').slice(-1500)})",
      returnByValue: true
    })
    last = JSON.parse(r.result?.result?.value || '{}').text || ''
    if (last.includes(EXPECT)) {
      ok = true
      break
    }
    if (/Error|错误|失败/.test(last) && i > 5) {
      // 有可能是错误提示，继续再等两轮
    }
  }
  c.close()
  console.log('tail=' + last.replace(/\n/g, ' ⏎ ').slice(-400))
  console.log(ok ? 'CHAT_PASS' : 'CHAT_FAIL no_reply')
  process.exit(ok ? 0 : 1)
} catch (err) {
  console.log('CHAT_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}