// 验证项目分组 UI：新建项目 → 出现在列表 → 归档 → 沉入「已归档」
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PORT = Number(process.env.UI_CHECK_PORT || 9478)
if (!EXE) {
  console.log('usage: node scripts/ui-projects-check.mjs <exe>')
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

try {
  const p = await page()
  if (!p) {
    console.log('PROJ_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(p.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(1500)

  const NAME = '自检项目-' + Date.now().toString().slice(-5)

  // 1) 点「项目」旁的 + 新建，填名并回车
  const opened = await evalJs(
    c,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '+ 新建')
      if (!btn) return 'no_new_btn'
      btn.click()
      return 'ok'
    })()`
  )
  await sleep(400)
  const typed = await evalJs(
    c,
    `(() => {
      const inp = document.querySelector('input[placeholder*="项目名"]')
      if (!inp) return 'no_input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, ${JSON.stringify(NAME)})
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'typed'
    })()`
  )
  await sleep(1500)
  const afterCreate = await evalJs(c, "JSON.stringify({t:document.body.innerText||''})")
  const text1 = JSON.parse(afterCreate || '{}').t || ''
  const created = text1.includes(NAME)
  console.log(`open=${opened} type=${typed} created=${created}`)

  // 2) 归档该项目（hover 菜单 → 归档项目）：按「⋯ 按钮所在行包含项目名」定位
  const archived = await evalJs(
    c,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === '⋯')
      const rowBtn = btns.find((b) => ((b.parentElement && b.parentElement.innerText) || '').includes(${JSON.stringify(
        NAME
      )}))
      if (!rowBtn) return 'no_menu_btn'
      rowBtn.click()
      return 'menu_open'
    })()`
  )
  await sleep(600)
  const clickedArchive = await evalJs(
    c,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '归档项目')
      if (!btn) return 'no_archive_btn'
      btn.click()
      return 'archived'
    })()`
  )
  await sleep(1500)
  const afterArchive = await evalJs(c, "JSON.stringify({t:document.body.innerText||''})")
  const text2 = JSON.parse(afterArchive || '{}').t || ''
  const inArchived = text2.includes('已归档')
  const stillActive = new RegExp(NAME + '[^\\n]*\\n[^已归档]*已归档').test(text2)
  console.log(`archive=${archived}/${clickedArchive} archivedSection=${inArchived}`)
  const pass = created && inArchived && clickedArchive === 'archived'
  console.log(pass ? 'PROJ_PASS' : 'PROJ_FAIL')
  c.close()
  process.exit(pass ? 0 : 1)
} catch (err) {
  console.log('PROJ_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}