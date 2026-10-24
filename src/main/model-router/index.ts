import type { AppConfig } from '../core/config'
import { ModelRouter, type FailoverNotice } from './server'

let instance: ModelRouter | null = null
/** 上一次使用的端口：路由站若真需要重启，必须复用它，否则正在跑的 CLI 会话会指向死端口 */
let lastPort = 0

/** 启动（或复用）路由站；返回 Base URL 与本地 token 供 CLI env 注入 */
export async function ensureRouter(getConfig: () => AppConfig): Promise<{ baseUrl: string; localToken: string }> {
  if (!instance) {
    instance = new ModelRouter(getConfig)
    await instance.start(lastPort)
    lastPort = instance.port()
  }
  const cfg = getConfig()
  return { baseUrl: instance.baseUrl(), localToken: cfg.router.localToken }
}

export function getRouter(): ModelRouter | null {
  return instance
}

export function stopRouter(): void {
  instance?.stop()
  instance = null
}

/**
 * 配置变更后的生效方式：热加载，不重启。
 *
 * 路由站的 getConfig 每次请求实时求值（普通模式读盘），所以改供应商/Key/模型名
 * 下一次请求自动生效；这里只需让 /v1/models 缓存失效。
 * 不重启有两个直接收益：端口不变（进行中的 CLI 会话不受影响）、熔断计数不丢。
 */
export async function reloadRouter(getConfig: () => AppConfig): Promise<void> {
  await ensureRouter(getConfig)
  instance?.invalidateModelsCache()
}

/** 注册故障转移回调（界面提示「X 挂了 → 已切 Y」） */
export function onFailover(fn: (n: FailoverNotice) => void): void {
  instance?.setFailoverHandler(fn)
}

export type { FailoverNotice }
