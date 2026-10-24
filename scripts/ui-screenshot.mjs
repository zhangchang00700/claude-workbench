// 截图：启动 app → 拍对话台 + 模型路由站 → 存 docs/screenshots/*.png
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'docs', 'screenshots')
const PORT = Number(process.env.UI_CHECK_PORT || 9490)
if (!EXE) {
  console.log('usage: node scripts/ui-screenshot.mjs <exe>')
  process.exit(3)
}
fs.mkdirSync(OUT_DIR, { recursive: true })

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

try {
  const p = await page()
  if (!p) {
    console.log('SHOT_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(p.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(2500)

  async function shot(name) {
    const r = await c.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT_DIR, name)
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
    console.log(`saved ${name} ${Math.round(fs.statSync(file).size / 1024)}KB`)
  }

  await shot('01-对话台.png')

  await c.send('Runtime.evaluate', {
    expression: "Array.from(document.querySelectorAll('button')).find(b=>b.innerText.includes('模型路由站'))?.click()",
    returnByValue: true
  })
  await sleep(1500)
  await shot('02-模型路由站.png')

  await c.send('Runtime.evaluate', {
    expression: "Array.from(document.querySelectorAll('button')).find(b=>b.innerText.includes('用量看板'))?.click()",
    returnByValue: true
  })
  await sleep(1500)
  await shot('03-用量看板.png')

  c.close()
  console.log('SCREENSHOT_OK')
  process.exit(0)
} catch (err) {
  console.log('SHOT_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}