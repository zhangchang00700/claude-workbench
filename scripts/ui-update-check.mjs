// 更新面板「一键安装并重启」的 UI 自检
// 真启动应用 → CDP 驱动检查更新 → 下载完成 → 断言一键安装按钮 / 确认文案 / 正在退出态 → 截图
//
// 只桩主进程通道（经 CDP 注入 __wbStub，渲染层走生产代码路径）：
//   checkUpdate / downloadUpdate / onUpdateProgress / updateInstall
// updateInstall 由 __wbInstallMode 切换 fail / ok，验证「失败显示原因」与「点击后正在退出」，
// 桩不真退出（ok 也只返回，不触发 app.quit()）。
//
// 用法：node scripts/ui-update-check.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PROJECT = path.resolve(import.meta.dirname, '..')
const EXE = process.argv[2] || path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT_DIR = path.resolve(PROJECT, 'docs', 'screenshots')
const RENDERER = path.resolve(PROJECT, 'out', 'renderer')
const PORT = Number(process.env.UI_CHECK_PORT || 9457)
const INDEX_URL = 'file:///' + path.join(RENDERER, 'index.html').replace(/\\/g, '/')

const HINT_TEXT = '将退出 ClaudeWorkbench 并覆盖安装（配置与会话数据不受影响），安装后自动重启'

// 桩：更新链路全桩（发布仓库没有 v0.2.1；updateInstall 不真退出）
const STUB = `
window.__wbEvents = [];
window.__wbLog = function (x) { window.__wbEvents.push(x); };
window.addEventListener('unhandledrejection', function (e) { window.__wbLog('rejection:' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
window.__wbUpdateMode = 'available';
window.__wbInstallMode = 'ok';
window.__wbStub = {
  checkUpdate: async function () {
    var mode = window.__wbUpdateMode;
    if (mode === 'uptodate') return { hasUpdate: false, current: '0.2.0' };
    if (mode === 'error') return { hasUpdate: false, error: '无法连接发布仓库（本机离线）' };
    return {
      hasUpdate: true,
      current: '0.2.0',
      latest: '0.2.1',
      notes: '· 新增一键安装并重启\\n· 更新面板下载完成后直接覆盖安装',
      assetName: 'ClaudeWorkbench-0.2.1-win.exe',
      assetSize: 187432960
    };
  },
  downloadUpdate: async function () {
    if (window.__wbProgress) window.__wbProgress({ phase: 'download', percent: 42, message: '下载中' });
    await new Promise(function (r) { setTimeout(r, 200); });
    if (window.__wbProgress) window.__wbProgress({ phase: 'done', percent: 100 });
    return { ok: true, path: 'C:\\\\Users\\\\demo\\\\Downloads\\\\ClaudeWorkbench-0.2.1-win.exe' };
  },
  onUpdateProgress: function (cb) {
    window.__wbProgress = cb;
    return function () { window.__wbProgress = null; };
  },
  updateInstall: async function () {
    window.__wbLog('install:' + window.__wbInstallMode);
    // 桩出「正在退出…」的可见时长；ok 也不真退出，好断言按钮态
    await new Promise(function (r) { setTimeout(r, 300); });
    if (window.__wbInstallMode === 'fail') return { ok: false, error: '安装包校验失败（自检桩）' };
    return { ok: true };
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
// dev 版（electron.exe）必须带 '.' 才能加载项目里的 out/
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

const shot = async (c, name, clip) => {
  const params = { format: 'png' }
  if (clip) params.clip = clip
  const r = await c.send('Page.captureScreenshot', params)
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  shot ${name} ${Math.round(fs.statSync(file).size / 1024)}KB`)
}

const btnState = (ev, sel) =>
  ev(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.innerText.trim(), disabled: !!b.disabled, visible: r.width > 0 && r.height > 0 };
  })()`)

try {
  console.log('--- 更新面板：一键安装并重启 ---')
  const main = await findPage(/index\.html/, 45)
  if (!main) {
    console.log('UPDATE_UI_FAIL no_main_page')
    process.exit(1)
  }
  const { c, ev } = await attach(main, { reload: true })
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(800)
  await ev(`(document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => 'fonts_ok') : 'no_fonts'`)

  // 版本行在，面板活着
  const ver = await ev(`document.querySelector('[data-update-version]').innerText`)
  check('更新面板显示当前版本', !!ver && ver !== '—', `ver=${ver}`)

  // 走到「有新版本」
  await ev(`document.querySelector('[data-update-check]').click()`)
  await sleep(500)
  const upText = await ev(`document.body.innerText`)
  check('检查出新版本（v0.2.1）', String(upText).includes('0.2.1'), '')

  // 下载完成
  await ev(`document.querySelector('[data-update-download]').click()`)
  await sleep(700)
  const dlText = await ev(`document.body.innerText`)
  check('下载完成进入 downloaded 态', String(dlText).includes('已下载完成'), `stage=${await ev(`document.querySelector('[data-update-stage]').getAttribute('data-update-stage')`)}`)

  /* ══════════ 门禁断言 1：下载完成后一键安装按钮可见 ══════════ */
  const inst = await btnState(ev, '[data-update-install]')
  check('下载完成后「一键安装并重启」按钮可见', !!inst && inst.visible && inst.text === '一键安装并重启', JSON.stringify(inst))

  const open = await btnState(ev, '[data-update-open]')
  check('「打开所在文件夹」与安装按钮并排同行', !!open && open.visible && open.text === '打开所在文件夹', JSON.stringify(open))

  // 点击前的确认文案必须 inline 可见（不是弹窗）
  const hintEl = await ev(`(() => {
    const h = document.querySelector('[data-update-install-hint]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { text: h.innerText.trim(), visible: r.width > 0 && r.height > 0 };
  })()`)
  check('点击前有 inline 确认文案（非弹窗）', !!hintEl && hintEl.visible && hintEl.text === HINT_TEXT, JSON.stringify(hintEl))

  await shot(c, '10-更新-一键安装.png', { x: 0, y: 0, width: 1280, height: 800, scale: 1 })
  // 面板特写：按 [data-update-stage] 的实际位置裁剪，看清单双按钮与文案排版
  const rect = JSON.parse(
    (await ev(`JSON.stringify((() => { const r = document.querySelector('[data-update-stage]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })())`)) || 'null'
  )
  if (rect) {
    const pad = 8
    await shot(c, '10-更新-一键安装-特写.png', {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
      scale: 2
    })
  }

  // 失败路径：失败必须显示原因，按钮可再次点击
  await ev(`window.__wbInstallMode = 'fail'`)
  await ev(`document.querySelector('[data-update-install]').click()`)
  await sleep(700)
  const errBox = await ev(`(() => { const e = document.querySelector('[data-update-install-error]'); return e ? e.innerText.trim() : null })()`)
  check('安装失败显示错误原因', !!errBox && errBox.includes('安装包校验失败'), `err=${errBox}`)
  const instAfterFail = await btnState(ev, '[data-update-install]')
  check('失败后按钮恢复可重试', !!instAfterFail && !instAfterFail.disabled && instAfterFail.text === '一键安装并重启', JSON.stringify(instAfterFail))
  check('失败后不再显示即将重启提示', (await ev(`!!document.querySelector('[data-update-install-status]')`)) === false)
  await shot(c, '11-更新-一键安装-失败提示.png', { x: 0, y: 0, width: 1280, height: 800, scale: 1 })

  // 降级路径（软断言）：真实桥接也没有 updateInstall 时，点击应给出降级提示而不是静默失败
  const realHas = await ev(`typeof window.workbench.updateInstall`)
  if (realHas === 'undefined') {
    await ev(`delete window.__wbStub.updateInstall`)
    await ev(`document.querySelector('[data-update-install]').click()`)
    await sleep(400)
    const deg = await ev(`(() => { const e = document.querySelector('[data-update-install-error]'); return e ? e.innerText.trim() : null })()`)
    check('拿不到 updateInstall 时降级提示', !!deg && deg.includes('安装通道未接入'), `err=${deg}`)
    // 恢复桩，继续跑成功路径
    await ev(`window.__wbStub.updateInstall = async function () { window.__wbLog('install:' + window.__wbInstallMode); await new Promise(function (r) { setTimeout(r, 300); }); if (window.__wbInstallMode === 'fail') return { ok: false, error: '安装包校验失败（自检桩）' }; return { ok: true }; }`)
  } else {
    skip('拿不到 updateInstall 时降级提示', `真实桥接已有 updateInstall（typeof=${realHas}），不点真通道防真退出`)
  }

  /* ══════════ 门禁断言 2：点击后显示「正在退出…」 ══════════ */
  await ev(`window.__wbInstallMode = 'ok'`)
  await ev(`document.querySelector('[data-update-install]').click()`)
  await sleep(150)
  const instDuring = await btnState(ev, '[data-update-install]')
  check('点击后按钮变「正在退出…」并禁用', !!instDuring && instDuring.text === '正在退出…' && instDuring.disabled === true, JSON.stringify(instDuring))
  const openDuring = await btnState(ev, '[data-update-open]')
  check('退出中「打开所在文件夹」同步禁用', !!openDuring && openDuring.disabled === true, JSON.stringify(openDuring))
  // be 契约：ok=true 后主进程 500ms 内 app.quit()，UI 须提前显示即将重启提示
  const statusLine = await ev(`(() => { const e = document.querySelector('[data-update-install-status]'); return e ? e.innerText.trim() : null })()`)
  check('进行中显示「正在安装更新，应用即将重启…」', statusLine === '正在安装更新，应用即将重启…', `status=${statusLine}`)
  await shot(c, '11-更新-一键安装-正在退出.png', { x: 0, y: 0, width: 1280, height: 800, scale: 1 })

  // 等桩 resolve 后（ok 不真退出）按钮应保持「正在退出…」——成功后窗口本该被主进程关闭
  await sleep(500)
  const instAfterOk = await btnState(ev, '[data-update-install]')
  check('成功后保持「正在退出…」（等待 app.quit 关窗）', !!instAfterOk && instAfterOk.text === '正在退出…', JSON.stringify(instAfterOk))

  // be 契约兜底：点击 5 秒仍未关窗（桩不真退出，窗口必存活）→ 切「退出超时」文案
  const TIMEOUT_HINT = '退出超时，请手动关闭应用窗口，安装脚本将自动完成替换并重启'
  let slowLine = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    slowLine = await ev(`(() => { const e = document.querySelector('[data-update-install-status]'); return e ? e.innerText.trim() : null })()`)
    if (slowLine === TIMEOUT_HINT) break
  }
  check('5 秒未关窗切「退出超时」兜底文案', slowLine === TIMEOUT_HINT, `status=${slowLine}`)
  await shot(c, '11-更新-一键安装-退出超时.png', { x: 0, y: 0, width: 1280, height: 800, scale: 1 })

  c.close()
  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped).length
  console.log(`RESULT ${results.length - failed.length}/${results.length} passed (${skipped} skipped)`)
  console.log(failed.length === 0 ? 'UPDATE_UI_OK' : 'UPDATE_UI_FAIL ' + failed.length)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (err) {
  console.log('UPDATE_UI_ERROR ' + String(err && err.stack ? err.stack : err))
  process.exit(2)
} finally {
  child.kill()
}
