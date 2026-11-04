import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 解析 claude CLI 原生可执行文件（claude.exe）路径。
 *
 * dev 模式：<项目根>/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
 * 打包模式：<resources>/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
 * 兜底（仅自用场景）：用户全局安装的 claude CLI
 */
export function resolveClaudeExecutable(): string {
  const candidates: string[] = []

  if (app.isPackaged) {
    candidates.push(
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe'
      )
    )
  } else {
    candidates.push(
      path.join(
        app.getAppPath(),
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe'
      )
    )
  }

  // 兜底：用户全局安装的 claude CLI（分发型 exe 跑在已装 CLI 的机器上）
  candidates.push(
    path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    )
  )

  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

export function claudeExecutableExists(): boolean {
  return fs.existsSync(resolveClaudeExecutable())
}
