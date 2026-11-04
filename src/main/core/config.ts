import { app, safeStorage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import log from './logger'
import {
  BUILTIN_PRESETS,
  ENV_PREFIX,
  PRESET_FIXUPS,
  normalizeBaseUrl,
  providerEnvId,
  type AppConfig,
  type ProviderConfig,
  type ProviderModelMap
} from '../../shared/types'

export type { AppConfig, ProviderConfig, ProviderModelMap } from '../../shared/types'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function configFilePath(): string {
  return path.join(userDataDir(), 'config.json')
}

/** 写前备份文件路径：与 config.json 同目录 */
export function configBackupPath(): string {
  return path.join(userDataDir(), 'config.json.bak')
}

function presetToProvider(preset: (typeof BUILTIN_PRESETS)[number]): ProviderConfig {
  return {
    id: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    apiKeyEnc: '',
    models: { ...preset.models } as ProviderModelMap,
    defaultModel: preset.defaultModel,
    priority: preset.priority,
    enabled: true,
    maxContextTokens: preset.maxContextTokens,
    modelsEndpoint: preset.modelsEndpoint,
    builtin: true
  }
}

export function defaultConfig(): AppConfig {
  return {
    version: 2,
    onboarded: false,
    router: {
      port: 0,
      localToken: crypto.randomBytes(24).toString('base64url'),
      retryOn429: true,
      timeoutMs: 120000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 }
    },
    providers: BUILTIN_PRESETS.map(presetToProvider),
    workspace: {
      defaultDir: path.join(app.getPath('documents'), 'ClaudeWorkbench', 'workspace'),
      permissionMode: 'default',
      maxConcurrent: 2
    },
    updatedAt: new Date().toISOString()
  }
}

/** v1 → v2 迁移：旧 api 单供应商配置映射为 providers 列表 */
function migrateV1(raw: Record<string, unknown>): AppConfig {
  const cfg = defaultConfig()
  const api = raw.api as
    | { baseUrl?: string; authTokenEnc?: string; models?: ProviderModelMap; maxContextTokens?: number }
    | undefined
  if (api?.baseUrl) {
    cfg.providers.unshift({
      id: 'custom',
      name: '自定义（迁移自 v1）',
      baseUrl: api.baseUrl,
      apiKeyEnc: api.authTokenEnc ?? '',
      models: api.models ?? {},
      defaultModel: api.models?.sonnet,
      priority: 0,
      enabled: true,
      maxContextTokens: api.maxContextTokens,
      builtin: false
    })
  }
  if (raw.workspace) Object.assign(cfg.workspace, raw.workspace)
  return cfg
}

function parseJsonFile(p: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * 读主配置文件，损坏时回退备份并自愈（只依赖 fs 的纯函数，供测试与主流程共用）。
 * - 主文件可解析：直接返回。
 * - 主文件损坏/写一半：尝试备份文件；备份可用则把它复制回主文件（自愈）并用备份内容。
 * - 两者都不可用：返回 undefined，由调用方走默认配置路径。
 */
export function readConfigWithRecovery(
  mainPath: string,
  backupPath: string
): { parsed: Record<string, unknown>; recoveredFromBackup: boolean } | undefined {
  const main = parseJsonFile(mainPath)
  if (main) return { parsed: main, recoveredFromBackup: false }
  const bak = parseJsonFile(backupPath)
  if (!bak) return undefined
  // 备份可用：自愈，把备份恢复为主文件（失败不影响本次加载，内容仍来自备份）
  try {
    fs.copyFileSync(backupPath, mainPath)
  } catch {
    // 忽略自愈失败
  }
  return { parsed: bak, recoveredFromBackup: true }
}

/**
 * 写前备份：主文件存在且可解析为 JSON 时复制为备份文件（覆盖旧备份）。
 * 主文件损坏（不可解析）时不备份——坏内容不覆盖好备份。
 */
export function backupConfigFile(mainPath: string, backupPath: string): boolean {
  try {
    if (!fs.existsSync(mainPath)) return false
    JSON.parse(fs.readFileSync(mainPath, 'utf8')) // 可解析才值得备份
    fs.copyFileSync(mainPath, backupPath)
    return true
  } catch {
    return false
  }
}

export function loadConfig(): AppConfig {
  const cfg = defaultConfig()
  const p = configFilePath()
  // 无条件走恢复流程：主文件缺失（如被误删）时同样从 .bak 自愈
  const res = readConfigWithRecovery(p, configBackupPath())
  if (!res) {
    // 主文件与备份都不可用（缺失或损坏）：回退默认配置
    log.warn('[config] config.json 损坏且无可用备份（config.json.bak 缺失或损坏），使用默认配置')
    return applyEnvOverrides(cfg)
  }
  if (res.recoveredFromBackup) {
    log.warn('[config] config.json 损坏，已从 config.json.bak 恢复并继续加载')
  }
  const parsed = res.parsed
  if (parsed.version === 2) {
    Object.assign(cfg, parsed)
    // 补齐新增内置预设（升级场景）
    for (const preset of BUILTIN_PRESETS) {
      if (!cfg.providers.some((pv) => pv.id === preset.id)) {
        cfg.providers.push(presetToProvider(preset))
      }
    }
    // 升级修正：补 protocol 默认值 + 纠正上一版的错误默认值（仅当字段仍是旧值）
    const fixed = applyPresetFixups(cfg)
    if (fixed) saveConfig(cfg)
  } else {
    return applyEnvOverrides(migrateV1(parsed))
  }
  return applyEnvOverrides(cfg)
}

/**
 * 升级修正：内置供应商的 protocol 缺失时补 anthropic；
 * baseUrl/模型名若仍是历史错误值，按 PRESET_FIXUPS 纠正（用户手改过的字段不动）。
 * 返回是否发生改动。
 */
export function applyPresetFixups(cfg: AppConfig): boolean {
  let changed = false
  for (const pv of cfg.providers) {
    if (pv.protocol !== 'openai') {
      if (pv.protocol !== 'anthropic') {
        pv.protocol = 'anthropic'
        changed = true
      }
    }
    // 回填模型列表端点（2026-10-17 新增字段）：智谱/DeepSeek/Kimi 的 Anthropic 垫片
    // 不实现 /v1/models，模型列表只在原生端点。仅在该供应商没有值时填，不覆盖用户自填。
    const preset = BUILTIN_PRESETS.find((p) => p.id === pv.id)
    if (preset?.modelsEndpoint && !pv.modelsEndpoint) {
      pv.modelsEndpoint = preset.modelsEndpoint
      changed = true
    }
    const fix = PRESET_FIXUPS[pv.id]
    if (!fix) continue
    if (fix.baseUrl && pv.baseUrl === fix.baseUrl.from) {
      pv.baseUrl = fix.baseUrl.to
      changed = true
    }
    if (fix.models) {
      for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
        const rule = fix.models[tier]
        if (!rule) continue
        const froms = Array.isArray(rule.from) ? rule.from : [rule.from]
        const current = pv.models[tier]
        if (current !== undefined && froms.includes(current)) {
          pv.models[tier] = rule.to
          if (pv.defaultModel !== undefined && froms.includes(pv.defaultModel)) {
            pv.defaultModel = rule.to
          }
          changed = true
        }
      }
    }
  }
  return changed
}

export function saveConfig(cfg: AppConfig): void {
  cfg.updatedAt = new Date().toISOString()
  const p = configFilePath()
  fs.mkdirSync(userDataDir(), { recursive: true })
  // 写前备份：旧配置可解析才复制为 .bak（坏内容不覆盖好备份）
  backupConfigFile(p, configBackupPath())
  // 原子写：tmp + rename，避免写一半产生损坏文件
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

/**
 * 环境变量覆盖（CW_ 前缀）。规则：
 * - CW_PROVIDER_<ID>_API_KEY / _BASE_URL / _ENABLED / _MODEL
 * - CW_ROUTER_PORT
 * 环境变量优先于配置文件，便于 CI / 分发场景免改文件切换供应商。
 */
export function applyEnvOverrides(cfg: AppConfig): AppConfig {
  const env = process.env
  for (const pv of cfg.providers) {
    const eid = providerEnvId(pv.id)
    const key = env[`${ENV_PREFIX}PROVIDER_${eid}_API_KEY`]
    if (key) pv.apiKeyEnc = encryptSecret(key)
    const proto = env[`${ENV_PREFIX}PROVIDER_${eid}_PROTOCOL`]
    if (proto === 'openai' || proto === 'anthropic') pv.protocol = proto
    const base = env[`${ENV_PREFIX}PROVIDER_${eid}_BASE_URL`]
    // 环境变量同样做规范化：避免 /v1 结尾拼出 /v1/v1/messages
    if (base) pv.baseUrl = normalizeBaseUrl(base, pv.protocol ?? 'anthropic')
    const enabled = env[`${ENV_PREFIX}PROVIDER_${eid}_ENABLED`]
    if (enabled === 'true' || enabled === 'false') pv.enabled = enabled === 'true'
    const model = env[`${ENV_PREFIX}PROVIDER_${eid}_MODEL`]
    if (model) {
      pv.defaultModel = model
      pv.models.sonnet = model
    }
  }
  const port = env[`${ENV_PREFIX}ROUTER_PORT`]
  if (port && /^\d+$/.test(port)) cfg.router.port = parseInt(port, 10)
  return cfg
}

/** DPAPI 加密；不可用时退化为 base64（设置页明示风险） */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(plain, 'utf8').toString('base64')
  return safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(enc: string): string {
  if (!enc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

export function getProviderKey(pv: ProviderConfig): string {
  return decryptSecret(pv.apiKeyEnc)
}

/** 可用供应商 = enabled 且已填 key，按优先级排序 */
export function activeProviders(cfg: AppConfig): ProviderConfig[] {
  return cfg.providers
    .filter((pv) => pv.enabled && pv.apiKeyEnc)
    .sort((a, b) => a.priority - b.priority)
}
