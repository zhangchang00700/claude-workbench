import { spawnSync } from 'node:child_process'

/**
 * 自愈兜底（必须在其他模块之前加载）。
 *
 * 当外部环境设置了 ELECTRON_RUN_AS_NODE（例如把本 exe 当作纯 Node 启动，
 * 或被其他 Electron 宿主以 node 模式 spawn），Electron 会退化为纯 Node：
 * require('electron') 返回路径字符串、app 为 undefined、--flag 被 Node 的
 * 参数解析器以 "bad option" 拒绝。此时清除该变量并以 Electron 模式重启自身。
 *
 * 仅在检测到该变量存在时触发，子进程已无此变量，不会形成重启循环。
 */
if (!process.type && process.env.ELECTRON_RUN_AS_NODE) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  }
  const result = spawnSync(process.execPath, process.argv.slice(1), { env, stdio: 'inherit' })
  process.exit(result.status ?? 0)
}
