# api_contracts_status（ClaudeWorkbench）

> 本项目为单体 Electron 应用，无后端 API 契约。此处记录的是**内部模块契约**与**外部依赖契约**的稳定性。

## 内部契约
| 契约 | 位置 | 状态 | 备注 |
|---|---|---|---|
| preload API（window.workbench.*） | src/shared/preload-api.ts | stable | 渲染层唯一入口；新增能力必须先加类型再实现 |
| IPC 通道名 | src/main/ipc.ts | stable | `chat:*` `sessions:*` `projects:*` `tasks:*` `templates:*` `schedules:*` `usage:query` `config:*` **`quickchat:*`**（ask/handoff/hide/show/hotkey/resize）**`update:*`**（check/download/install/openFolder + `update:progress` 推送） |
| 共享类型 | src/shared/types.ts | stable | SessionMeta/SessionProject/UsageStats/TaskRecord/ScheduleRecord 等 |
| 供应商预设 | **src/shared/types.ts**（`BUILTIN_PRESETS`） | stable | 14 家 priority 1–14；presets.test.ts 守卫 id/priority 唯一 + 端点可拼 + docUrl 齐全。⚠️ `src/shared/presets.ts` 不存在 |
| 虚拟模型档位 | TIER_ALIASES（wb-opus/sonnet/haiku） | stable | CLI env 注入用，路由站负责解析真实模型 |
| 路由站日志行格式 | server.ts RouterEvent | frozen | usageStore/UsagePanel 依赖；加字段必须向后兼容 |
| 任务执行器 | **src/main/tasks/taskExecutor.ts**（分派）+ taskRunner.ts（调度） | stable | 双通道：`text` 走路由站 stream:false；`agent` 走 CLI（runPrompt）+ PermissionBroker + resume。taskRunner 本身与通道无关 |
| TaskRecord 通道字段 | src/shared/types.ts | **draft（v0.3.0 未发版）** | `mode?: 'text'\|'agent'`（缺省 text）、`cliSessionId?`、`permissionMode?`、`maxTurns?`、`cwd?`；旧记录读时由 `normalizeTask()` 兜底 |

## 外部依赖契约
| 依赖 | 契约 | 风险 |
|---|---|---|
| @anthropic-ai/claude-agent-sdk | query() + Options.pathToClaudeCodeExecutable | spawn 失败会抛误导性 libc 文案（client.ts 已做 describeLaunchFailure 增强） |
| 各家上游（14 家） | anthropic 或 openai 协议 + 各自业务码 | 已有回归矩阵 regression.test.ts 14 例 |
| electron-builder | yml 配置 + CLI `-c.directories.output=` 覆盖 | safe-delete 钩子/asar 占用 → 目录按版本轮换 |
| safeStorage | encryptString/decryptString(base64) | config.json 的 apiKeyEnc 格式，勿改 |

## 更新通道（已实现，v0.2.1）
- 自动更新**不采用 electron-updater**：走 `src/main/updater.ts` + `gh api` / GitHub Releases 通道（本机 github.com 只能看不能下，api.github.com 通；见 knowledge_base 网络段）。
- 契约：`checkUpdate()` / `downloadUpdate()` / `onUpdateProgress()` / `openUpdateFolder()` / `updateInstall()`；下载产物为 `ClaudeWorkbench-*-win.zip`，一键安装生成纯 ASCII PowerShell 脚本后覆盖并重启，配置与会话数据保留。
- 发布侧：`scripts/publish-release.mjs`（curl 上传必须带 `--ssl-no-revoke`）+ `scripts/publish-via-api.mjs`（挂 parent 的连续历史 + NO_CHANGES 幂等）。

## 未定契约（下一迭代候选）
- v0.3.0 已落地「双通道」第一刀（见上表 `TaskRecord 通道字段`）：`tasks:create` 新增 `mode/permissionMode/maxTurns/cwd`，缺省全部向后兼容。
- 仍待补：agent 通道的**中途工具调用流式回传**（现仅返回最终文本，渲染层看不到中间工具名）；以及模板/定时流水线是否允许产出 agent 任务（当前模板与定时只产 text 任务）。
