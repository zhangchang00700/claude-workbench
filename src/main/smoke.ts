import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import log from 'electron-log'
import { buildCliEnvOverrides, runPrompt } from './claude/client'
import { loadConfig, encryptSecret, type AppConfig } from './core/config'
import { readHostClaudeEnv } from './core/host-config'
import { ensureRouter, onFailover } from './model-router'

const RESULT_FILE = path.join(os.tmpdir(), 'claude-workbench-smoke-result.json')
const SMOKE_PROMPT = '请只回复 SMOKE-OK，不要输出任何其他内容。'

interface SmokeResult {
  ok: boolean
  text: string
  sessionId: string | null
  elapsedMs: number
  routerPort: number
  providerCount: number
  /** 本次请求发生的故障转移（证明上游失败后确实换了供应商） */
  failover?: { from: string; to: string; reason: string }[]
  error?: string
  finishedAt?: string
}

/**
 * 无窗口自检：经内部路由站跑一次真实 query。
 * 结果写入 %TEMP%/claude-workbench-smoke-result.json（GUI 子系统进程 stdout 不可靠，文件是唯一契约）。
 * 退出码：0=通过，1=结果不含 SMOKE-OK，2=异常，3=无可用供应商，4=缺凭证。
 *
 * 凭证来源（按优先级）：
 * 1. SMOKE_PROVIDER + SMOKE_AUTH_TOKEN（可加 SMOKE_BASE_URL/SMOKE_MODEL）——指定供应商
 * 2. 宿主机 ~/.claude/settings.json：按 baseUrl 主机名匹配内置供应商并回填 key（自用场景）
 */
export async function runSmokeSelfTest(): Promise<number> {
  const t0 = Date.now()
  const result: SmokeResult = {
    ok: false,
    text: '',
    sessionId: null,
    elapsedMs: 0,
    routerPort: 0,
    providerCount: 0
  }

  const finish = (code: number): number => {
    result.elapsedMs = Date.now() - t0
    result.finishedAt = new Date().toISOString()
    try {
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8')
    } catch (e) {
      log.error('[smoke] write result file failed', e)
    }
    return code
  }

  try {
    fs.unlinkSync(RESULT_FILE)
  } catch {
    // 文件不存在，忽略
  }

  const cfg: AppConfig = loadConfig()
  result.providerCount = cfg.providers.filter((p) => p.enabled && p.apiKeyEnc).length

  // --- 故障转移冒烟：两家 mock，第一家必失败，验证自动切到第二家 ---
  // SMOKE_FAILOVER=1 + SMOKE_FAIL_URL + SMOKE_OK_URL
  if (process.env.SMOKE_FAILOVER === '1' && process.env.SMOKE_FAIL_URL && process.env.SMOKE_OK_URL) {
    const mock = (id: string, name: string, baseUrl: string, priority: number): AppConfig['providers'][number] => ({
      id,
      name,
      baseUrl,
      protocol: 'anthropic',
      apiKeyEnc: encryptSecret('mock-key-not-a-real-secret'),
      models: { opus: 'mock-flash', sonnet: 'mock-flash', haiku: 'mock-flash' },
      defaultModel: 'mock-flash',
      priority,
      enabled: true,
      builtin: false
    })
    cfg.providers = [
      mock('mockfail', 'Mock Fail', process.env.SMOKE_FAIL_URL, 0),
      mock('mockok', 'Mock OK', process.env.SMOKE_OK_URL, 1)
    ]
    log.info('[smoke] failover mode: fail=%s ok=%s', process.env.SMOKE_FAIL_URL, process.env.SMOKE_OK_URL)
  }

  // --- 凭证注入（仅内存，不落盘）---
  const host = readHostClaudeEnv()
  const smokeProvider = process.env.SMOKE_PROVIDER
  if (process.env.SMOKE_FAILOVER !== '1' && smokeProvider && process.env.SMOKE_AUTH_TOKEN) {
    const pv = cfg.providers.find((p) => p.id === smokeProvider)
    if (!pv) {
      result.error = `SMOKE_PROVIDER=${smokeProvider} 不在供应商列表中`
      log.error('[smoke]', result.error)
      return finish(3)
    }
    pv.apiKeyEnc = encryptSecret(process.env.SMOKE_AUTH_TOKEN)
    if (process.env.SMOKE_BASE_URL) pv.baseUrl = process.env.SMOKE_BASE_URL
    // SMOKE_PROTOCOL=openai 时走 OpenAI 兼容路径（验证路由站协议转换链路）
    if (process.env.SMOKE_PROTOCOL === 'openai' || process.env.SMOKE_PROTOCOL === 'anthropic') {
      pv.protocol = process.env.SMOKE_PROTOCOL
    }
    if (process.env.SMOKE_MODEL) {
      pv.defaultModel = process.env.SMOKE_MODEL
      pv.models.sonnet = process.env.SMOKE_MODEL
    }
    pv.enabled = true
    pv.priority = 0
  } else if (process.env.SMOKE_FAILOVER !== '1' && host.ANTHROPIC_AUTH_TOKEN && host.ANTHROPIC_BASE_URL) {
    // 自用场景：按 baseUrl 主机名匹配内置供应商，回填宿主机 key
    let hostname = host.ANTHROPIC_BASE_URL
    try {
      hostname = new URL(host.ANTHROPIC_BASE_URL).hostname
    } catch {
      /* 原样使用 */
    }
    let matched = 0
    for (const pv of cfg.providers) {
      if (!pv.apiKeyEnc && pv.baseUrl.includes(hostname)) {
        pv.apiKeyEnc = encryptSecret(host.ANTHROPIC_AUTH_TOKEN)
        matched++
      }
    }
    if (matched === 0) {
      result.error = `宿主机配置的主机 ${hostname} 不匹配任何内置供应商 baseUrl，且未提供 SMOKE_PROVIDER/SMOKE_AUTH_TOKEN`
      log.error('[smoke]', result.error)
      return finish(4)
    }
  }

  if (cfg.providers.filter((p) => p.enabled && p.apiKeyEnc).length === 0) {
    result.error = '没有已填写 Key 的供应商：设置 SMOKE_PROVIDER + SMOKE_AUTH_TOKEN，或先在设置页完成配置'
    log.error('[smoke]', result.error)
    return finish(4)
  }

  // --- 启动路由站并冒烟 ---
  let router: { baseUrl: string; localToken: string }
  try {
    router = await ensureRouter(() => cfg)
    result.routerPort = Number(new URL(router.baseUrl).port)
    result.failover = []
    onFailover((n) => result.failover?.push({ from: n.from, to: n.to, reason: n.reason }))
  } catch (err) {
    result.error = `router start failed: ${err instanceof Error ? err.message : String(err)}`
    log.error('[smoke]', result.error)
    return finish(2)
  }

  log.info('[smoke] start, router=%s providers_with_key=%d', router.baseUrl, result.providerCount)

  try {
    const res = await runPrompt(SMOKE_PROMPT, {
      env: buildCliEnvOverrides(router, { tier: 'sonnet' }),
      cwd: app.getPath('temp'),
      maxTurns: 1,
      tier: 'sonnet'
    })
    result.sessionId = res.sessionId
    result.text = res.text.slice(0, 2000)
    result.ok = res.text.includes('SMOKE-OK')
    if (process.env.SMOKE_FAILOVER === '1' && (result.failover?.length ?? 0) === 0) {
      result.ok = false
      result.error = 'failover expected but none happened'
    }
    if (!result.ok && res.isError) result.error = `cli error subtype=${res.errorSubtype}`
    log.info('[smoke] done ok=%s sessionId=%s', result.ok, result.sessionId)
    return finish(result.ok ? 0 : 1)
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    log.error('[smoke] query failed', err)
    return finish(2)
  }
}
