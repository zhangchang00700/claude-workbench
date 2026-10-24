import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type EnvMap = Record<string, string>

/**
 * 只读本机 ~/.claude/settings.json 的 env 块（自用场景导入 / 冒烟兜底）。
 * 应用运行期不依赖该文件；分发型目标机器上它不存在。
 */
export function readHostClaudeEnv(): EnvMap {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json')
    if (!fs.existsSync(p)) return {}
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    const env = parsed?.env
    if (!env || typeof env !== 'object') return {}
    const out: EnvMap = {}
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 只读本机 ~/.claude/settings.json 的 permissions.defaultMode（自用导入用） */
export function readHostClaudePermissionMode(): string | null {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json')
    if (!fs.existsSync(p)) return null
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    const mode = parsed?.permissions?.defaultMode
    return typeof mode === 'string' ? mode : null
  } catch {
    return null
  }
}
