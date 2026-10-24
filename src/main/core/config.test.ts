import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.ts 模块级 import electron / electron-log；
// applyPresetFixups 不碰 electron；loadConfig/saveConfig 通过 getPath 指向临时目录单测
const electronMock = vi.hoisted(() => ({
  getPath: (_name: string): string => '/tmp'
}))
const logMock = vi.hoisted(() => ({
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  error: (_msg: string) => {}
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => electronMock.getPath(name) },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-log', () => ({ default: logMock }))

const {
  applyPresetFixups,
  loadConfig,
  saveConfig,
  configFilePath,
  configBackupPath,
  backupConfigFile,
  readConfigWithRecovery
} = await import('./config')
type AppConfig = import('../../shared/types').AppConfig
type ProviderConfig = import('../../shared/types').ProviderConfig

function makeConfig(providers: ProviderConfig[]): AppConfig {
  return {
    version: 2,
    onboarded: true,
    router: {
      port: 0,
      localToken: 't',
      retryOn429: true,
      timeoutMs: 120000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 }
    },
    providers,
    workspace: { defaultDir: '/tmp', permissionMode: 'default', maxConcurrent: 2 },
    updatedAt: ''
  }
}

function deepseek(models: ProviderConfig['models'], defaultModel?: string): ProviderConfig {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    protocol: 'anthropic',
    apiKeyEnc: '',
    models,
    defaultModel,
    priority: 2,
    enabled: true,
    builtin: true
  }
}

describe('applyPresetFixups：旧默认值更名链修复', () => {
  it('deepseek-chat（v7 及以前）→ deepseek-flash，defaultModel 跟随', () => {
    const cfg = makeConfig([
      deepseek({ opus: 'deepseek-reasoner', sonnet: 'deepseek-chat', haiku: 'deepseek-chat' }, 'deepseek-chat')
    ])
    expect(applyPresetFixups(cfg)).toBe(true)
    expect(cfg.providers[0].models.sonnet).toBe('deepseek-flash')
    expect(cfg.providers[0].models.haiku).toBe('deepseek-flash')
    expect(cfg.providers[0].models.opus).toBe('deepseek-v4-pro')
    expect(cfg.providers[0].defaultModel).toBe('deepseek-flash')
  })

  it('deepseek-v4-flash（v8 默认值，官方已下线仅作别名）→ deepseek-flash', () => {
    const cfg = makeConfig([
      deepseek({ opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-flash', haiku: 'deepseek-v4-flash' }, 'deepseek-v4-flash')
    ])
    expect(applyPresetFixups(cfg)).toBe(true)
    expect(cfg.providers[0].models.sonnet).toBe('deepseek-flash')
    expect(cfg.providers[0].models.haiku).toBe('deepseek-flash')
    expect(cfg.providers[0].defaultModel).toBe('deepseek-flash')
  })

  it('用户手改过的模型名一律不动', () => {
    const cfg = makeConfig([
      deepseek({ opus: 'my-own-model', sonnet: 'deepseek-chat', haiku: 'deepseek-chat' })
    ])
    expect(applyPresetFixups(cfg)).toBe(true)
    expect(cfg.providers[0].models.opus).toBe('my-own-model')
  })

  it('已是现行值：无改动返回 false', () => {
    const cfg = makeConfig([
      {
        ...deepseek({ opus: 'deepseek-v4-pro', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' }, 'deepseek-flash'),
        modelsEndpoint: 'https://api.deepseek.com/models'
      }
    ])
    expect(applyPresetFixups(cfg)).toBe(false)
  })

  it('glm 旧 haiku 名 glm-4.5-air → GLM-5.3-Flash', () => {
    const cfg = makeConfig([
      {
        id: 'glm',
        name: '智谱 GLM',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        protocol: 'anthropic',
        apiKeyEnc: '',
        models: { opus: 'glm-5.3', sonnet: 'GLM-5.3-Flash', haiku: 'glm-4.5-air' },
        priority: 1,
        enabled: true,
        builtin: true
      }
    ])
    expect(applyPresetFixups(cfg)).toBe(true)
    expect(cfg.providers[0].models.haiku).toBe('GLM-5.3-Flash')
  })

  it('回填 modelsEndpoint（Anthropic 垫片无 /v1/models 的供应商）', () => {
    const cfg = makeConfig([
      deepseek({ opus: 'deepseek-v4-pro', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' })
    ])
    expect(cfg.providers[0].modelsEndpoint).toBeUndefined()
    expect(applyPresetFixups(cfg)).toBe(true)
    expect(cfg.providers[0].modelsEndpoint).toBe('https://api.deepseek.com/models')
    // 用户自填的不覆盖
    const cfg2 = makeConfig([
      { ...deepseek({}), modelsEndpoint: 'https://my-relay.example/models' }
    ])
    expect(applyPresetFixups(cfg2)).toBe(false)
    expect(cfg2.providers[0].modelsEndpoint).toBe('https://my-relay.example/models')
    // 自定义供应商没有预设端点，不填
    const cfg3 = makeConfig([
      {
        id: 'custom',
        name: '自定义',
        baseUrl: 'https://x.example/v1',
        protocol: 'anthropic',
        apiKeyEnc: '',
        models: {},
        priority: 9,
        enabled: true,
        builtin: false
      }
    ])
    expect(applyPresetFixups(cfg3)).toBe(false)
    expect(cfg3.providers[0].modelsEndpoint).toBeUndefined()
  })
})

describe('config 存储：写前备份 + 损坏回退', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-config-'))
    electronMock.getPath = (name: string) =>
      name === 'documents' ? path.join(dir, 'docs') : dir
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function cfgWithToken(token: string): AppConfig {
    // modelsEndpoint 预填，避免 applyPresetFixups 在 loadConfig 内触发二次 saveConfig 干扰断言
    const cfg = makeConfig([
      {
        ...deepseek({ opus: 'm-opus', sonnet: 'm-sonnet', haiku: 'm-haiku' }),
        modelsEndpoint: 'https://api.deepseek.com/models'
      }
    ])
    cfg.router.localToken = token
    return cfg
  }

  it('写前备份：保存两次后 .bak 内容 = 第一次保存的内容', () => {
    saveConfig(cfgWithToken('token-one'))
    expect(fs.existsSync(configBackupPath())).toBe(false)
    const firstContent = fs.readFileSync(configFilePath(), 'utf8')
    expect(JSON.parse(firstContent).router.localToken).toBe('token-one')

    saveConfig(cfgWithToken('token-two'))
    const bakContent = fs.readFileSync(configBackupPath(), 'utf8')
    expect(JSON.parse(bakContent).router.localToken).toBe('token-one')
    expect(JSON.parse(fs.readFileSync(configFilePath(), 'utf8')).router.localToken).toBe('token-two')
  })

  it('主文件损坏：loadConfig 回退 .bak 且 config.json 被自愈修复', () => {
    saveConfig(cfgWithToken('token-good'))
    saveConfig(cfgWithToken('token-good')) // 第二次保存产生 .bak
    expect(fs.existsSync(configBackupPath())).toBe(true)

    // 手工写坏主文件（模拟写一半 / JSON 损坏）
    fs.writeFileSync(configFilePath(), '{broken json', 'utf8')

    const loaded = loadConfig()
    expect(loaded.router.localToken).toBe('token-good')
    // 自愈：config.json 已恢复且可解析，内容与备份一致
    const healed = JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as {
      router: { localToken: string }
    }
    expect(healed.router.localToken).toBe('token-good')
    expect(fs.readFileSync(configFilePath(), 'utf8')).toBe(
      fs.readFileSync(configBackupPath(), 'utf8')
    )
  })

  it('主文件与 .bak 都损坏：返回默认配置且不抛异常', () => {
    fs.writeFileSync(configFilePath(), '{broken', 'utf8')
    fs.writeFileSync(configBackupPath(), '}also broken', 'utf8')
    expect(() => loadConfig()).not.toThrow()
    const cfg = loadConfig()
    expect(cfg.version).toBe(2)
    expect(cfg.onboarded).toBe(false)
  })

  it('无 .bak 且 config.json 损坏：返回默认配置', () => {
    fs.writeFileSync(configFilePath(), '{broken', 'utf8')
    expect(fs.existsSync(configBackupPath())).toBe(false)
    expect(() => loadConfig()).not.toThrow()
    const cfg = loadConfig()
    expect(cfg.version).toBe(2)
    expect(cfg.onboarded).toBe(false)
  })

  it('主文件损坏时 saveConfig 不用坏内容覆盖好备份', () => {
    saveConfig(cfgWithToken('token-a'))
    saveConfig(cfgWithToken('token-b')) // .bak = token-a 版本
    const bakBefore = fs.readFileSync(configBackupPath(), 'utf8')

    fs.writeFileSync(configFilePath(), '{broken', 'utf8')
    saveConfig(cfgWithToken('token-c'))
    // 备份保持为最后一个好版本，未被坏内容覆盖
    expect(fs.readFileSync(configBackupPath(), 'utf8')).toBe(bakBefore)
    expect(
      (JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as { router: { localToken: string } })
        .router.localToken
    ).toBe('token-c')
  })

  it('原子写：保存后目录内不残留 tmp 文件', () => {
    saveConfig(cfgWithToken('token-tmp'))
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('纯函数 readConfigWithRecovery：主文件好/坏/双坏三种路径', () => {
    const main = path.join(dir, 'm.json')
    const bak = path.join(dir, 'm.json.bak')

    // 主文件好：直接用主文件
    fs.writeFileSync(main, '{"a":1}', 'utf8')
    fs.writeFileSync(bak, '{"a":2}', 'utf8')
    let res = readConfigWithRecovery(main, bak)
    expect(res).toEqual({ parsed: { a: 1 }, recoveredFromBackup: false })

    // 主文件坏、备份好：回退备份并自愈
    fs.writeFileSync(main, '{bad', 'utf8')
    res = readConfigWithRecovery(main, bak)
    expect(res).toEqual({ parsed: { a: 2 }, recoveredFromBackup: true })
    expect(JSON.parse(fs.readFileSync(main, 'utf8'))).toEqual({ a: 2 })

    // 双坏：undefined
    fs.writeFileSync(main, '{bad', 'utf8')
    fs.writeFileSync(bak, '}worse', 'utf8')
    expect(readConfigWithRecovery(main, bak)).toBeUndefined()
  })

  it('纯函数 backupConfigFile：不存在/不可解析时不备份', () => {
    const main = path.join(dir, 'x.json')
    const bak = path.join(dir, 'x.json.bak')
    expect(backupConfigFile(main, bak)).toBe(false) // 主文件不存在
    fs.writeFileSync(main, '{bad', 'utf8')
    expect(backupConfigFile(main, bak)).toBe(false) // 不可解析
    expect(fs.existsSync(bak)).toBe(false)
    fs.writeFileSync(main, '{"ok":true}', 'utf8')
    expect(backupConfigFile(main, bak)).toBe(true)
    expect(JSON.parse(fs.readFileSync(bak, 'utf8'))).toEqual({ ok: true })
  })

  it('主文件完全不存在但 .bak 存在且有效：loadConfig 回退备份并自愈', () => {
    saveConfig(cfgWithToken('token-v1'))
    saveConfig(cfgWithToken('token-v2')) // .bak = token-v1 版本
    expect(fs.existsSync(configBackupPath())).toBe(true)

    fs.rmSync(configFilePath()) // 主文件彻底消失
    const loaded = loadConfig()
    // 应回退到备份内容（上一次保存的 token-v1）
    expect(loaded.router.localToken).toBe('token-v1')
    // 自愈：主文件被恢复且与备份一致
    expect(fs.existsSync(configFilePath())).toBe(true)
    expect(JSON.parse(fs.readFileSync(configFilePath(), 'utf8')).router.localToken).toBe('token-v1')
  })

  it('主文件为空文件（0 字节）：视为损坏，走备份回退', () => {
    saveConfig(cfgWithToken('token-empty-case'))
    saveConfig(cfgWithToken('token-empty-case')) // 产生 .bak（内容同 token）
    fs.writeFileSync(configFilePath(), '', 'utf8') // 0 字节
    expect(fs.statSync(configFilePath()).size).toBe(0)

    const loaded = loadConfig()
    expect(loaded.router.localToken).toBe('token-empty-case')
    // 自愈后主文件可解析
    expect(() => JSON.parse(fs.readFileSync(configFilePath(), 'utf8'))).not.toThrow()
  })

  it('连续保存 3 次：.bak 始终是「上一次」的内容（滚动备份）', () => {
    saveConfig(cfgWithToken('v1'))
    expect(fs.existsSync(configBackupPath())).toBe(false) // 首次保存无备份
    saveConfig(cfgWithToken('v2'))
    saveConfig(cfgWithToken('v3'))
    // 第 3 次保存后，备份 = 第 2 次的内容
    const bak = JSON.parse(fs.readFileSync(configBackupPath(), 'utf8')) as {
      router: { localToken: string }
    }
    expect(bak.router.localToken).toBe('v2')
    const main = JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as {
      router: { localToken: string }
    }
    expect(main.router.localToken).toBe('v3')
  })

  it('readConfigWithRecovery：.bak 缺失时返回 undefined 且不抛异常', () => {
    const main = path.join(dir, 'no-bak.json')
    const bak = path.join(dir, 'no-bak.json.bak')
    fs.writeFileSync(main, '{bad', 'utf8')
    expect(fs.existsSync(bak)).toBe(false)
    expect(() => readConfigWithRecovery(main, bak)).not.toThrow()
    expect(readConfigWithRecovery(main, bak)).toBeUndefined()
  })
})
