// 验证「自动获取模型」：进模型路由站页 → 点 DeepSeek 的自动获取模型 → 读结果
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PROVIDER = process.argv[3] || 'DeepSeek'
const PORT = Number(process.env.UI_CHECK_PORT || 9455)
if (!EXE) {
  console.log('usage: node scripts/ui-models-check.mjs <exe> [providerName]')
  process.exit(3)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })

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
    console.log('MODELS_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(p.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(1500)

  // 进入设置页
  await c.send('Runtime.evaluate', {
    expression: "Array.from(document.querySelectorAll('button')).find(b=>b.innerText.includes('模型路由站'))?.click()",
    returnByValue: true
  })
  await sleep(1200)

  // 在该供应商卡片里点「自动获取模型」
  const clicked = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll('div')).filter((d) => d.innerText && d.innerText.includes(${JSON.stringify(
        PROVIDER
      )}) && d.innerText.includes('自动获取模型'))
      const card = cards.sort((a, b) => a.innerText.length - b.innerText.length)[0]
      if (!card) return 'no_card'
      const btn = Array.from(card.querySelectorAll('button')).find((b) => b.innerText.trim() === '自动获取模型')
      if (!btn) return 'no_btn'
      btn.click()
      return 'clicked'
    })()`,
    returnByValue: true
  })
  console.log('click=' + clicked.result?.result?.value)

  let text = ''
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    const r = await c.send('Runtime.evaluate', {
      expression: "JSON.stringify({t:(document.body.innerText||'')})",
      returnByValue: true
    })
    text = JSON.parse(r.result?.result?.value || '{}').t || ''
    if (/已自动填入|模型列表端点不可用|自动获取失败/.test(text)) break
  }
  const line = /(已自动填入[^\n]*|模型列表端点不可用[^\n]*|自动获取失败[^\n]*)/.exec(text)?.[0] ?? '(未读到结果)'
  console.log('result=' + line)
  // 三档模型名是否落到了卡片上（deepseek-flash 等）
  const hasModels = /deepseek-flash|deepseek-v4-pro/i.test(text)
  console.log('models_visible=' + hasModels)
  console.log(line.includes('已自动填入') || line.includes('模型列表端点不可用') || hasModels ? 'MODELS_PASS' : 'MODELS_FAIL')
  c.close()
  process.exit(line.includes('已自动填入') || line.includes('模型列表端点不可用') || hasModels ? 0 : 1)
} catch (err) {
  console.log('MODELS_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}