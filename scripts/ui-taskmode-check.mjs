// 验证任务队列「双通道」UI（v0.3.0）：
// 通道切换控件存在 → 切到智能体后出现权限/轮次选项 → 创建任务 → 卡片出现「智能体」徽标 → 清理
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const PORT = Number(process.env.UI_CHECK_PORT || 9482)
if (!EXE) {
  console.log('usage: node scripts/ui-taskmode-check.mjs <exe>')
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

let pass = false
try {
  const p = await page()
  if (!p) {
    console.log('TASKMODE_FAIL no_page')
    process.exit(1)
  }
  const c = cdp(p.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await sleep(1500)

  // 1) 进入任务队列页
  const nav = await evalJs(
    c,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '任务队列')
      if (!btn) return 'no_nav'
      btn.click()
      return 'ok'
    })()`
  )
  await sleep(900)

  // 2) 默认应为文本通道：通道控件存在且提示文案为文本通道说明
  const initial = await evalJs(
    c,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim())
      const hasText = btns.includes('文本')
      const hasAgent = btns.includes('智能体')
      const body = document.body.innerText || ''
      const textHint = body.includes('直连路由站单次问答')
      const form = !!document.querySelector('textarea')
      return JSON.stringify({ hasText, hasAgent, textHint, form })
    })()`
  )
  const st1 = JSON.parse(initial || '{}')
  console.log(`nav=${nav} 通道按钮 text=${st1.hasText} agent=${st1.hasAgent} 文本提示=${st1.textHint} 表单=${st1.form}`)

  // 3) 切到智能体：出现权限选择与轮次
  const switched = await evalJs(
    c,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '智能体')
      if (!btn) return 'no_agent_btn'
      btn.click()
      return 'clicked'
    })()`
  )
  await sleep(500)
  const agentUi = await evalJs(
    c,
    `(() => {
      const body = document.body.innerText || ''
      const hasPerm = body.includes('每次确认') || body.includes('权限')
      const hasTurns = body.includes('最多轮次')
      const hasHint = body.includes('工具调用会弹窗')
      const opts = Array.from(document.querySelectorAll('option')).map((o) => o.innerText)
      const hasBypass = opts.some((o) => o.includes('全部放行'))
      return JSON.stringify({ hasPerm, hasTurns, hasHint, hasBypass })
    })()`
  )
  const st2 = JSON.parse(agentUi || '{}')
  console.log(`switch=${switched} 权限=${st2.hasPerm} 轮次=${st2.hasTurns} 安全提示=${st2.hasHint} 全放行选项=${st2.hasBypass}`)

  // 4) 填 prompt 并加入队列
  const TITLE = '自检智能体任务-' + Date.now().toString().slice(-5)
  const filled = await evalJs(
    c,
    `(() => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no_textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '自检用：这是一个智能体通道任务（不会真的执行）')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 'filled'
    })()`
  )
  await sleep(300)
  const added = await evalJs(
    c,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '加入队列')
      if (!btn) return 'no_add_btn'
      if (btn.disabled) return 'disabled'
      btn.click()
      return 'clicked'
    })()`
  )
  await sleep(1600)

  // 5) 断言：卡片出现「智能体」徽标，且该任务在列表里
  const afterAdd = await evalJs(
    c,
    `(() => {
      const body = document.body.innerText || ''
      const hasAgentBadge = body.includes('智能体')
      const hasQueued = body.includes('排队中')
      const hasPrompt = body.includes('这是一个智能体通道任务')
      return JSON.stringify({ hasAgentBadge, hasQueued, hasPrompt })
    })()`
  )
  const st3 = JSON.parse(afterAdd || '{}')
  console.log(`fill=${filled} add=${added} 智能体徽标=${st3.hasAgentBadge} 排队中=${st3.hasQueued} 任务已入列=${st3.hasPrompt}`)

  // 6) 清理：删掉刚建的任务，避免污染用户数据
  const cleaned = await evalJs(
    c,
    `(() => {
      const rows = Array.from(document.querySelectorAll('div')).filter((d) =>
        (d.innerText || '').includes('这是一个智能体通道任务') && (d.innerText || '').includes('删除')
      )
      const row = rows[rows.length - 1]
      if (!row) return 'no_row'
      const btn = Array.from(row.querySelectorAll('button')).find((b) => b.innerText.trim() === '删除')
      if (!btn) return 'no_del_btn'
      btn.click()
      return 'deleted'
    })()`
  )
  await sleep(1200)
  const afterClean = await evalJs(c, "JSON.stringify({t:document.body.innerText||''})")
  const stillThere = (JSON.parse(afterClean || '{}').t || '').includes('这是一个智能体通道任务')
  console.log(`cleanup=${cleaned} 任务已移除=${!stillThere}`)

  pass =
    nav === 'ok' &&
    st1.hasText === true &&
    st1.hasAgent === true &&
    st1.form === true &&
    switched === 'clicked' &&
    st2.hasPerm === true &&
    st2.hasTurns === true &&
    st2.hasBypass === true &&
    filled === 'filled' &&
    added === 'clicked' &&
    st3.hasAgentBadge === true &&
    st3.hasQueued === true &&
    stillThere === false

  console.log(pass ? 'TASKMODE_UI_OK' : 'TASKMODE_UI_FAIL')
  c.close()
  process.exit(pass ? 0 : 1)
} catch (err) {
  console.log('TASKMODE_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  child.kill()
}
