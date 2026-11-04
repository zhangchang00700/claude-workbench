// 把明文 Key 用 safeStorage 加密后写入应用配置（与 config.ts encryptSecret 同一格式）。
// 用法：electron scripts/set-key.cjs
//   env CW_SET_KEYS='{"deepseek":"sk-...","kimi":"sk-..."}'
// 不打印 Key 明文；仅在缺失/成功时输出计数。
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const userData = path.join(process.env.APPDATA, 'ClaudeWorkbench')
app.setPath('userData', userData)

app.whenReady().then(() => {
  const cfgPath = path.join(userData, 'config.json')
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch (err) {
    console.log('CONFIG_READ_FAIL', String(err && err.message))
    app.exit(3)
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.log('SAFE_STORAGE_UNAVAILABLE')
    app.exit(2)
    return
  }
  let patch = {}
  try {
    patch = JSON.parse(process.env.CW_SET_KEYS || '{}')
  } catch {
    console.log('BAD_JSON')
    app.exit(4)
    return
  }
  let written = 0
  const ids = []
  for (const [id, key] of Object.entries(patch)) {
    const pv = (cfg.providers || []).find((p) => p.id === id)
    if (!pv) {
      console.log('MISSING_PROVIDER', id)
      continue
    }
    if (typeof key !== 'string' || !key.trim()) continue
    pv.apiKeyEnc = safeStorage.encryptString(key.trim()).toString('base64')
    ids.push(id)
    written++
  }
  // 可选：同时调整供应商字段（enabled/priority 等），如 CW_PATCH='{"glm":{"enabled":false}}'
  let patched = 0
  try {
    const p = JSON.parse(process.env.CW_PATCH || '{}')
    for (const [id, fields] of Object.entries(p)) {
      const pv = (cfg.providers || []).find((x) => x.id === id)
      if (!pv || !fields || typeof fields !== 'object') continue
      Object.assign(pv, fields)
      patched++
    }
  } catch {
    console.log('BAD_PATCH')
  }
  const tmp = cfgPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, cfgPath)
  console.log('WROTE', written, ids.join(','))
  console.log('PATCHED', patched)
  app.exit(0)
})
