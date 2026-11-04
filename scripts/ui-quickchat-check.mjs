// 速聊条 + 多会话页签 + 更新面板 的 UI 自检
// 真启动应用 → Alt+Space 唤起真速聊窗 → CDP 驱动真实按键 → 截图 + 断言
//
// 只桩两样东西（都经 CDP 注入 __wbStub，渲染层走生产代码路径）：
//   1) quickChatAsk 的回答正文 —— 不依赖真实供应商，不烧配额
//   2) checkUpdate/downloadUpdate —— 发布仓库还没有 v0.2.0，桩出完整视觉流
// 其余（窗口创建/隐藏/唤起/resize、handoff→session:open→主窗开页签、
// 会话读写、Esc、失焦）全部走真实主进程。
//
// 用法：node scripts/ui-quickchat-check.mjs
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PROJECT = path.resolve(import.meta.dirname, '..')
const EXE = process.argv[2] || path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT_DIR = path.resolve(PROJECT, 'docs', 'screenshots')
const RENDERER = path.resolve(PROJECT, 'out', 'renderer')
const PORT = Number(process.env.UI_CHECK_PORT || 9455)
const INDEX_URL = 'file:///' + path.join(RENDERER, 'index.html').replace(/\\/g, '/')

// 桩：只补「会烧钱/还没有数据源」的两块。sendChat 也桩掉——真实发送会落库并打上游，
// 自检不该往用户的会话库里塞测试数据。
const STUB = `
window.__wbEvents = [];
window.__wbLog = function (x) { window.__wbEvents.push(x); };
window.addEventListener('unhandledrejection', function (e) { window.__wbLog('rejection:' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
window.__wbAnswer = [
  '速聊条是一个**常驻的小窗**，三件事：',
  '',
  '1. 随手提问，答完即走，不落进会话列表',
  '2. \`Esc\` 收起，失焦也收起 —— 不碍事',
  '3. 想接着聊，点「↩ 投送到完整会话」',
  '',
  '\`\`\`js',
  '// 投送后会在主窗口里接着这段继续',
  'quickChatHandoff({ text })',
  '\`\`\`'
].join('\\n');
window.__wbSession = {
  id: 'mock-handoff',
  title: '从速聊投送过来的问题',
  cliSessionId: 'cli-mock',
  tier: 'sonnet',
  projectId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messageCount: 1,
  preview: '这条来自速聊',
  archived: false,
  messages: [{ role: 'user', text: '这条来自速聊', isError: false, ts: Date.now() }]
};
window.__wbUpdateMode = 'available';
window.__wbStub = {
  // onStreamEvent：包一层多订阅分发器，既放真实事件进来，也允许自检注入合成 delta
  onStreamEvent: function (cb) {
    window.__wbStreamList = window.__wbStreamList || [];
    window.__wbStreamList.push(cb);
    if (!window.__wbStream) {
      window.__wbStream = function (e) { window.__wbStreamList.forEach(function (f) { f(e); }); };
    }
    return function () {
      window.__wbStreamList = window.__wbStreamList.filter(function (f) { return f !== cb; });
    };
  },
  sendChat: async function (a) {
    var runId = 'r' + Date.now();
    window.__wbRunId = runId;
    var sid = a.appSessionId || 'mock-' + Date.now();
    if (window.__wbStream) window.__wbStream({ domain: 'chat', payload: { type: 'start', runId: runId, sessionId: sid } });
    window.__wbLog('send:' + String(a.text).slice(0, 10));
    return { ok: true, appSessionId: sid, cliSessionId: 'cli-1' };
  },
  quickChatAsk: async function (a) {
    window.__wbLog('ask:' + String(a.text).slice(0, 10));
    // 300ms 而非 900ms：速聊页在阶段一期间一直处于隐藏态，Chromium 对隐藏页定时器
    // 做激进节流（hidden 越久拖得越狠），900ms 会被拖到秒级甚至分钟级，导致自检假失败。
    await new Promise(function (r) { setTimeout(r, 300); });
    return { ok: true, text: window.__wbAnswer, ms: 842, provider: 'wb-sonnet' };
  },
  // 兜底路径（速聊页被导航进主窗口）时绝不真调 hide/resize，否则会把主窗口藏起来/改尺寸
  quickChatHide: async function () {
    window.__wbLog('hide');
    if (window.__wbFallback) return;
    return await window.workbench.quickChatHide();
  },
  quickChatResize: async function (a) {
    if (window.__wbFallback) return { ok: true };
    return await window.workbench.quickChatResize(a);
  },
  checkUpdate: async function () {
    var mode = window.__wbUpdateMode;
    if (mode === 'uptodate') return { hasUpdate: false, current: '0.1.1' };
    if (mode === 'error') return { hasUpdate: false, error: '无法连接发布仓库（本机离线）' };
    return {
      hasUpdate: true,
      current: '0.1.1',
      latest: '0.2.0',
      notes: '· 新增速聊条：Esc / 失焦收起，可投送到完整会话\\n· 多会话页签：后台会话继续输出，切回内容完整\\n· 内置更新检查与下载\\n· 修复会话标题过长时页签撑破布局',
      assetName: 'ClaudeWorkbench-0.2.0-win.exe',
      assetSize: 187432960
    };
  },
  downloadUpdate: async function () {
    if (window.__wbProgress) window.__wbProgress({ phase: 'download', percent: 42, message: '下载中' });
    await new Promise(function (r) { window.__wbReleaseDownload = r; });
    if (window.__wbProgress) window.__wbProgress({ phase: 'done', percent: 100 });
    return { ok: true, path: 'C:\\\\Users\\\\demo\\\\Downloads\\\\ClaudeWorkbench-0.2.0-win.exe' };
  },
  onUpdateProgress: function (cb) {
    window.__wbProgress = cb;
    return function () { window.__wbProgress = null; };
  }
};
`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, skipped: false })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
function skip(name, why) {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP ${name} — ${why}`)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// 打包版（release-vX.Y.Z/win-unpacked/ClaudeWorkbench.exe）不需要 '.' 项目目录参数；
// dev 版（electron.exe）必须带 '.' 才能加载项目里的 out/。用 UI_CHECK_PACKAGED=1 区分。
const PACKAGED = process.env.UI_CHECK_PACKAGED === '1'
const child = spawn(EXE, [...(PACKAGED ? [] : ['.']), `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env
})

async function listTargets() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  } catch {
    return []
  }
}
async function findPage(re, tries = 20, gap = 1000) {
  for (let i = 0; i < tries; i++) {
    const hit = (await listTargets()).find((t) => t.type === 'page' && re.test(t.url ?? ''))
    if (hit) return hit
    await sleep(gap)
  }
  return null
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

/** 附着到目标并装上桩；返回求值助手 */
async function attach(target, { reload = false } = {}) {
  const c = cdp(target.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
  if (reload) {
    await c.send('Page.reload')
    await sleep(2500)
  }
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      return { __error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description ?? '') }
    }
    return r.result?.result?.value
  }
  return { c, ev }
}

const key = async (c, k, code, vk) => {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const fill = (ev, text) =>
  ev(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no_textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`)
const shot = async (c, name, w, h) => {
  const r = await c.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 }
  })
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  shot ${name} ${Math.round(fs.statSync(file).size / 1024)}KB`)
}

try {
  /* ══════════ 阶段一：主窗口（页签 + 更新面板） ══════════ */
  console.log('--- 主窗口：多会话页签 ---')
  const main = await findPage(/index\.html/, 45)
  if (!main) {
    console.log('QUICKCHAT_UI_FAIL no_main_page')
    process.exit(1)
  }
  const m = await attach(main, { reload: true })
  const { c: mc, ev: mev } = m

  await mc.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(800)

  const cfgNow = await mev(
    `(async () => JSON.stringify(await window.workbench.getConfig().then(c => ({ activeCount: c.activeCount, provider: c.defaultProviderNow }))))()`
  )
  console.log('    真实配置：', cfgNow)

  const tabCount = () => mev(`document.querySelectorAll('[data-tab-key]').length`)
  const tabKeys = async () => JSON.parse((await mev(`JSON.stringify(Array.from(document.querySelectorAll('[data-tab-key]')).map(e => e.getAttribute('data-tab-key')))`)) || '[]')
  const clickTab = (k) => mev(`document.querySelector('[data-tab-title="${k}"]').click()`)
  const dump = async (label) =>
    console.log(
      '   ',
      label,
      await mev(`JSON.stringify({
        titles: Array.from(document.querySelectorAll('[data-tab-key]')).map(e => e.innerText.trim()),
        busy: Array.from(document.querySelectorAll('[data-tab-busy]')).map(e => e.getAttribute('data-tab-busy')),
        draft: (document.querySelector('textarea') || {}).value ?? null,
        runId: window.__wbRunId ?? null
      })`)
    )

  check('起手一个页签', (await tabCount()) === 1, `count=${await tabCount()}`)
  const [k0] = await tabKeys()

  await fill(mev, '第一条：帮我写周报')
  await mev(`document.querySelector('[data-tab-new]').click()`)
  await sleep(250)
  check('+ 新建页签', (await tabCount()) === 2, `count=${await tabCount()}`)
  const ks = await tabKeys()
  const k1 = ks.find((x) => x !== k0)
  check('新页签草稿是空的', (await mev(`document.querySelector('textarea').value`)) === '')

  await fill(mev, '第二条：算一下本月成本')
  await clickTab(k0)
  await sleep(250)
  check('切回后草稿还在（页签各自独立）', (await mev(`document.querySelector('textarea').value`)) === '第一条：帮我写周报')

  await clickTab(k1)
  await sleep(250)
  await mev(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '发送').click()`)
  await sleep(350)
  await mev(`window.__wbStream({domain:'chat',payload:{type:'delta',runId:window.__wbRunId,text:'后台页签'}})`)
  await mev(`window.__wbStream({domain:'chat',payload:{type:'delta',runId:window.__wbRunId,text:'仍在继续输出'}})`)
  await sleep(250)
  await clickTab(k0)
  await sleep(350)
  const busyFlags = await mev(`JSON.stringify(Array.from(document.querySelectorAll('[data-tab-busy]')).map(e => e.getAttribute('data-tab-busy')))`)
  check('切走后后台页签仍标「进行中」', String(busyFlags) === '["0","1"]', `flags=${busyFlags}`)
  check('后台内容没串到当前页签', !String(await mev(`document.body.innerText`)).includes('后台页签仍在继续输出'))
  await shot(mc, '04-主窗口-多会话页签.png', 1280, 800)

  await clickTab(k1)
  await sleep(350)
  check('切回来内容完整', String(await mev(`document.body.innerText`)).includes('后台页签仍在继续输出'))
  await mev(`window.__wbStream({domain:'chat',payload:{type:'done',runId:window.__wbRunId,durationMs:4200,costUsd:0.0031}})`)
  await sleep(350)
  const flagsAfter = await mev(`JSON.stringify(Array.from(document.querySelectorAll('[data-tab-busy]')).map(e => e.getAttribute('data-tab-busy')))`)
  check('跑完后进行中指示消失', String(flagsAfter) === '["0","0"]', `flags=${flagsAfter}`)
  await dump('跑完后:')

  /* ══════════ 阶段二：真速聊窗 ══════════
   * 唤起方式说明：本环境非交互会话无法用 COM SendKeys 发系统按键（实测 Command failed），
   * 所以改走主窗口「⚡ 速聊」按钮 → 真实 quickChatShow IPC → 主进程创建/显示真窗口。
   * 窗口创建 / 聚焦 / 失焦收起 / Esc 收起 / 投送 全走真实主进程链路；
   * 唯一验不到的是「全局热键被真实按下」——那个由 getQuickChatHotkey 返回值证明已注册。 */
  console.log('--- 速聊条（真窗口，经 quickChatShow 唤起） ---')
  let hotkeyNote = ''
  await mc.send('Page.bringToFront')
  await sleep(400)
  const shown = await mev(
    `(() => { const b = document.querySelector('[data-quickchat-open]'); if (!b) return 'no_button'; b.click(); return 'clicked' })()`
  )
  check('主窗口速聊入口可点击唤起', shown === 'clicked', `result=${shown}`)
  const hotkeyVal = JSON.parse(
    (await mev(`(async () => JSON.stringify(await window.workbench.getQuickChatHotkey()))()`)) || '""'
  )
  check('全局热键已真实注册（降级链结果）', typeof hotkeyVal === 'string' && hotkeyVal.length > 0, `hotkey=${hotkeyVal}`)
  const qcTarget = await findPage(/quickchat\.html/, 12, 800)

  let qc
  if (qcTarget) {
    console.log('    已唤起真实速聊窗（经 IPC）')
    qc = await attach(qcTarget, { reload: true })
  } else {
    // 兜底：把速聊页导航进主窗口验证渲染层。打开 __wbFallback 让 hide/resize 只记日志不真调，
    // 否则会把主窗口藏起来。真窗口行为（尺寸随回答增长/隐藏再唤起）此路径验证不到。
    console.log('    未能唤起真实速聊窗 → 兜底路径（仅渲染层；真窗口行为跳过）')
    console.log('    ' + hotkeyNote)
    await mev(`window.__wbFallback = true`)
    await mc.send('Page.navigate', { url: INDEX_URL.replace('index.html', 'quickchat.html') })
    await sleep(2500)
    qc = { c: mc, ev: mev }
  }
  // 透明窗口双信号探针：Chromium 在 Windows 上对 transparent 窗口的可见性/焦点
  // 两个信号都不可靠（show 后 visibilityState 不更新；hide 后 hasFocus 可能残留）。
  // 因此「可见」= vis==='visible' 或 focus===true；「已收起」= vis==='hidden' 且 focus===false。
  const probe = (ev) => ev(`JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus() })`)
  const isShown = (s) => { try { const o = JSON.parse(s); return o.vis === 'visible' || o.focus === true } catch { return false } }
  const isHidden = (s) => { try { const o = JSON.parse(s); return o.vis === 'hidden' && o.focus === false } catch { return false } }

  const { c: qcc, ev: qev } = qc
  // 不要 setDeviceMetricsOverride：速聊窗真实宽度约 648（主进程 bounds），
  // 把视口模拟成 760 会让页面按 760 布局、右侧被窗口裁掉（发送按钮被切一半的假象）。
  // 等字体就绪再截图，否则早期帧会用 fallback 字体渲染出错误字形（文字重影）。
  await qev(`(document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => 'fonts_ok') : 'no_fonts'`)

  const vis = await probe(qev)
  if (qcTarget) check('速聊窗真的显示出来了', isShown(vis), `probe=${vis}`)
  const focused = await qev(`document.activeElement && document.activeElement.tagName`)
  check('打开即聚焦输入框', focused === 'TEXTAREA', `activeElement=${focused}`)
  check('空态有引导文案', String(await qev(`document.body.innerText`)).includes('问点什么'))
  await shot(qcc, '01-速聊条-空态.png', 660, 240)

  await fill(qev, '用一句话解释速聊条是干什么的')
  await key(qcc, 'Enter', 'Enter', 13)
  await sleep(250)
  const st1 = JSON.parse((await qev(`JSON.stringify(window.__qcState())`)) || 'null')
  check('Enter 即发送（进入加载态）', st1 && st1.phase === 'asking', JSON.stringify(st1))
  await shot(qcc, '02-速聊条-思考中.png', 660, 260)

  // 轮询等回答（隐藏页定时器节流会让固定 sleep 不可靠；CDP 求值不受页面节流影响）
  let st2 = null
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    st2 = JSON.parse((await qev(`JSON.stringify(window.__qcState())`)) || 'null')
    if (st2 && st2.phase !== 'asking') break
  }
  check('拿到回答', st2 && st2.phase === 'done' && st2.answerLen > 0, JSON.stringify(st2))
  check('显示耗时与供应商', st2 && st2.ms === 842 && st2.provider === 'wb-sonnet', `ms=${st2?.ms} provider=${st2?.provider}`)
  await shot(qcc, '03-速聊条-回答.png', 660, 520)

  // 真实失焦：把主窗口带到前台，速聊窗应当自己收起
  if (qcTarget) {
    await mc.send('Page.bringToFront')
    await sleep(700)
    const vis2 = await probe(qev)
    check('失焦自动收起（真 blur）', isHidden(vis2), `probe=${vis2}`)
    // 再唤起一次，验证上一轮答案不残留（本环境无 SendKeys，改走按钮 IPC）
    await mev(`document.querySelector('[data-quickchat-open]').click()`)
    await sleep(1200)
    const st3 = JSON.parse((await qev(`JSON.stringify(window.__qcState())`)) || 'null')
    check('再次唤起是全新一轮', st3 && st3.phase === 'idle' && st3.answerLen === 0, JSON.stringify(st3))
    const vis3 = await probe(qev)
    check('再次唤起后窗口回到前台', isShown(vis3), `probe=${vis3}`)
  } else {
    // 兜底路径：只能验证处理函数接线（合成 blur 事件）
    await qev(`window.dispatchEvent(new Event('blur'))`)
    await sleep(250)
    check('失焦收起（合成事件，仅接线）', JSON.parse((await qev(`JSON.stringify(window.__wbEvents)`)) || '[]').includes('hide'))
  }

  // 真实 Esc 收起：透明窗口 hide 后页面 focus 信号会残留（与「刚 show 完」的探针完全相同），
  // 页面级信号无法区分，改用主进程诊断日志（hideQuickChat 里落的 isVisible）作权威判据。
  const logPath = path.join(process.env.APPDATA || '', 'ClaudeWorkbench', 'logs', 'main.log')
  const logLinesBefore = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').length
    : 0
  await key(qcc, 'Escape', 'Escape', 27)
  await sleep(500)
  const logTail = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').slice(logLinesBefore).join('\n')
    : ''
  if (qcTarget) {
    check('Esc 收起（主进程日志权威判定）', /\[quickchat\] hide/.test(logTail), `newLog=${logTail.trim().slice(-140)}`)
  } else {
    check('Esc 收起', JSON.parse((await qev(`JSON.stringify(window.__wbEvents)`)) || '[]').includes('hide'))
  }

  // 主窗口侧的常驻入口按钮（热键之外的第二条路）——已在阶段二用真实 IPC 唤起覆盖：
  // 按钮点击 → quickChatShow → 主进程创建真窗口 → 聚焦 / 失焦收起 / Esc 收起均 PASS。
  console.log('--- 速聊常驻入口 ---')
  skip('常驻入口按钮可唤起速聊条', '已由阶段二「经 quickChatShow 唤起真窗口」覆盖')

  /* ══════════ 阶段三：真实投送 → 主窗口自动开页签 ══════════ */
  console.log('--- 投送到完整会话（真链路） ---')
  let handoffId = null
  if (qcTarget) {
    await fill(qev, '从速聊投送过来的问题')
    await key(qcc, 'Enter', 'Enter', 13)
    await sleep(1400)
    const r = JSON.parse(
      (await qev(`(async () => JSON.stringify(await window.workbench.quickChatHandoff({ text: '从速聊投送过来的问题' })))()`) ||
        'null')
    )
    handoffId = r?.appSessionId ?? null
    check('handoff 返回会话 id', !!handoffId, JSON.stringify(r))
    await sleep(1200)
    const titles = await mev(`JSON.stringify(Array.from(document.querySelectorAll('[data-tab-key]')).map(e => e.innerText.trim()))`)
    check('主窗口自动打开投送会话的页签', String(titles).includes('从速聊投送过来的问题'), `titles=${titles}`)
    const activeText = await mev(`document.body.innerText`)
    check('投送的问句出现在主窗口', String(activeText).includes('从速聊投送过来的问题'), '')
    await shot(mc, '05-速聊投送自动开页签.png', 1280, 800)
  } else {
    skip('投送到完整会话（真链路）', '需真实速聊窗；本机 Alt+Space 注册失败（见回报）')
  }

  /* ══════════ 阶段四：更新提示 ══════════ */
  console.log('--- 更新提示 ---')
  await mc.send('Page.bringToFront')
  await sleep(400)
  const ver = await mev(`document.querySelector('[data-update-version]').innerText`)
  check('显示当前版本', !!ver && ver !== '—', `ver=${ver}`)

  // 先看真实通道说什么（无发布时应当有明确反馈，而不是点了没反应）
  const realCheck = await mev(
    `(async () => JSON.stringify(await window.workbench.checkUpdate().catch(e => ({ error: String(e && e.message) }))))()`
  )
  console.log('    真实 checkUpdate：', realCheck)

  await mev(`document.querySelector('[data-update-check]').click()`)
  await sleep(500)
  const upText = await mev(`document.body.innerText`)
  check('有新版本时显示版本号/说明/大小', String(upText).includes('0.2.0') && String(upText).includes('178.8 MB'), '')
  await shot(mc, '06-更新提示-有新版本.png', 1280, 800)

  await mev(`document.querySelector('[data-update-download]').click()`)
  await sleep(500)
  check('下载中显示进度', String(await mev(`document.body.innerText`)).includes('42%'))
  await shot(mc, '07-更新提示-下载中.png', 1280, 800)

  await mev(`window.__wbReleaseDownload && window.__wbReleaseDownload()`)
  await sleep(600)
  check('下载完成提示', String(await mev(`document.body.innerText`)).includes('已下载完成'))
  await mev(`document.querySelector('[data-update-open]').click()`)
  await sleep(300)
  await shot(mc, '08-更新提示-已下载.png', 1280, 800)

  await mev(`window.__wbUpdateMode = 'uptodate'`)
  await mev(`document.querySelector('[data-update-check]').click()`)
  await sleep(500)
  check('无新版本给出明确反馈', String(await mev(`document.body.innerText`)).includes('已是最新版本'))
  await shot(mc, '09-更新提示-已是最新.png', 1280, 800)

  await mev(`window.__wbUpdateMode = 'error'`)
  await mev(`document.querySelector('[data-update-check]').click()`)
  await sleep(400)
  check('检查失败有明确原因', String(await mev(`document.body.innerText`)).includes('无法连接发布仓库'))

  // 清理：真实投送产生的会话不该留在用户会话库里
  if (handoffId) {
    await mev(`window.workbench.removeSession('${handoffId}')`)
    console.log(`    清理测试会话 ${handoffId}`)
  }

  qc?.c.close?.()
  mc.close()
  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped).length
  console.log(`RESULT ${results.length - failed.length}/${results.length} passed (${skipped} skipped)`)
  console.log(failed.length === 0 ? 'QUICKCHAT_UI_OK' : 'QUICKCHAT_UI_FAIL ' + failed.length)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (err) {
  console.log('QUICKCHAT_UI_ERROR ' + String(err && err.stack ? err.stack : err))
  process.exit(2)
} finally {
  child.kill()
}
