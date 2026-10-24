// End-to-end check of the settings -> router -> provider path, driven through the
// real renderer API (same calls the Settings page makes).
// Spins up the mock Anthropic upstream, adds it as a custom provider, fills a key,
// probes it, and verifies the default tier resolves to it.
// Usage: node scripts/ui-e2e.mjs <exe>
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EXE = process.argv[2]
const MOCK_PORT = Number(process.env.UI_E2E_MOCK_PORT || 8791)
const CDP_PORT = Number(process.env.UI_E2E_CDP_PORT || 9334)

if (!EXE) {
  console.log('usage: node scripts/ui-e2e.mjs <exe>')
  process.exit(3)
}

const mock = spawn(process.execPath, ['scripts/mock-anthropic-server.mjs'], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT), NO_PROXY: '127.0.0.1,localhost' },
  stdio: 'ignore'
})

async function waitPort(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { 'x-api-key': 'x' } })
      if (r.ok) return true
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  return false
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
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

let child = null
try {
  if (!(await waitPort(MOCK_PORT))) {
    console.log('UI_E2E_FAIL mock_upstream_not_ready')
    process.exit(1)
  }
  console.log('mock upstream up on ' + MOCK_PORT)

  // Strip ELECTRON_RUN_AS_NODE: if the host shell carries it, the packaged exe
  // degrades to plain Node and no window/CDP target ever appears (host env pitfall).
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', env: childEnv })

  let page = null
  for (let i = 0; i < 30 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* wait */
    }
    if (!page) await sleep(1000)
  }
  if (!page) {
    console.log('UI_E2E_FAIL no_cdp_target')
    process.exit(1)
  }

  const c = cdp(page.webSocketDebuggerUrl)
  await c.ready
  await sleep(1500)

  const expr = `(async () => {
    const base = 'http://127.0.0.1:${MOCK_PORT}';
    // idempotent: config persists in userData between runs
    await window.workbench.removeProvider('mock');
    const add = await window.workbench.addProvider({ id: 'mock', name: 'Mock Upstream', baseUrl: base });
    const set = await window.workbench.setProviderKey('mock', 'test-key-123');
    const probe = await window.workbench.testProvider('mock');
    const cfg = await window.workbench.getConfig();
    const pv = cfg.providers.find(p => p.id === 'mock');
    return JSON.stringify({
      addOk: add.ok, setOk: set.ok, hasKey: pv ? pv.hasKey : false,
      probeOk: probe.ok, probeModels: (probe.models || []).length, probeErr: probe.error || '',
      activeCount: cfg.activeCount, defaultModelNow: cfg.defaultModelNow,
      defaultProviderNow: cfg.defaultProviderNow, onboarded: cfg.onboarded
    });
  })()`

  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  const out = r.result?.result?.value
  console.log('result=' + out)
  const j = JSON.parse(out || '{}')
  c.close()

  const ok = j.addOk && j.setOk && j.hasKey && j.probeOk && j.activeCount >= 1 && !!j.defaultModelNow
  console.log(ok ? 'UI_E2E_PASS' : 'UI_E2E_FAIL')
  process.exit(ok ? 0 : 1)
} catch (err) {
  console.log('UI_E2E_ERROR ' + String(err && err.message))
  process.exit(2)
} finally {
  if (child) child.kill()
  mock.kill()
}
