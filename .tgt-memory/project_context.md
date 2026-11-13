# project_context（ClaudeWorkbench）

## 项目定位
claude CLI 内核 + Electron 便携单文件 + AI 工业化工作台（对话台/任务队列/定时自动化/模板流水线/日志看板）。
对标 CC Switch：不追配置管理广度，押注运行时可观测/可调度/可恢复。

## 技术栈
- Electron + electron-vite（rolldown）+ React + TypeScript + Tailwind
- @anthropic-ai/claude-agent-sdk（协议层，驱动 claude.exe 子进程，stream-json）
- 自研模型路由站（http，14 家供应商预设，anthropic/openai 双协议 + 故障转移/熔断）
- 测试：vitest（236 例 / 18 文件）；构建：electron-builder（ship 通道）
- 包管理：npm（非 pnpm）；无 Prisma/无数据库（JSON 文件存储）

## 目录结构
- src/main：主进程（model-router 路由站、claude client、sessions/projects/tasks/templates/schedules/usage 各 store、quickchat、updater、tray、ipc、smoke）
- src/renderer：React UI（App、SettingsPage、TaskQueue、TemplatesPanel、SchedulePanel、UsagePanel、SessionSidebar、MascotPanel、quickchat、UpdatePanel）
- src/shared：类型与预设（types.ts 内含 `BUILTIN_PRESETS` 14 家、template-vars.ts、preload-api.ts）
  - ⚠️ **`src/shared/presets.ts` 不存在**：预设单一真源是 `types.ts`；旧文档多处误引，2026-11-13 已纠正
- scripts/：smoke-test.ps1、find-smoke-exe.ps1、set-key.cjs、ui-*-check.mjs（CDP 自检）、ship.mjs、check-ship.mjs、clean-releases.mjs、publish-release.mjs、publish-via-api.mjs
- docs/report/：开发日志（按日）与专项报告
- .tgt-memory/：本记忆库

## 关键机制（改动前必读）
- 路由站两条铁律：① 配置变更走热加载（reloadRouter），绝不重启路由站；② 故障转移判定看四类信号（状态码+厂商业务码表+错误体关键字+流式首帧）
- 会话 = JSON 文件（userData/sessions），项目分组 = userData/projects；模型路由站日志 = userData/logs/router-<date>.jsonl（用量/成本面板数据源）
- API Key 经 safeStorage 加密存 %APPDATA%\ClaudeWorkbench\config.json
- 打包：`npm run ship`（npm version patch → build → 打包到 release-v<semver> → 自动清理保留最新 2 个）
- GUI 自检：scripts/ui-chat-check.mjs / ui-models-check.mjs / ui-usage-check.mjs / ui-projects-check.mjs（支持 UI_CHECK_DEV=1）

## 版本状态（2026-11-13 核对）
- 当前版本 **0.2.1**，已发布 GitHub Release `v0.2.1`（zip 263.6MB / 便携 exe 177.8MB）
- 本地产物：`release-v0.2.1/`、`release-v0.2.0/`（各约 1093MB，clean-releases --keep=2 保留）；`release-v0.1.1/` 595MB 与 legacy `release/`、`release-v14/` 待清理（后者含被 Defender 持锁的 asar）
- git：本地 main 干净；**远端 origin = https://github.com/zhangchang00700/claude-workbench.git 已建立并同步**（非「无远程仓库」）
- M6 自动更新已实现：走 `gh api` / GitHub Releases 通道（checkUpdate → downloadUpdate → updateInstall 一键安装），非 electron-updater
- 里程碑 M1–M7 + P0 托盘 + P0 预设 14 家 + P1 回归矩阵全部 done，见 progress_tracker.json

## 已知坑（详见 knowledge_base）
- Electron 渲染层不支持 window.prompt()
- 父目录 0 字节 package.json 会毒掉 Vite 构建（已清理过一次）
- 非交互会话无法用回收站 API；杀进程前必须确认不是用户在用
