# api_contracts_status（ClaudeWorkbench）

> 本项目为单体 Electron 应用，无后端 API 契约。此处记录的是**内部模块契约**与**外部依赖契约**的稳定性。

## 内部契约
| 契约 | 位置 | 状态 | 备注 |
|---|---|---|---|
| preload API（window.workbench.*） | src/shared/preload-api.ts | stable | 渲染层唯一入口；新增能力必须先加类型再实现 |
| IPC 通道名 | src/main/ipc.ts | stable | `chat:*` `sessions:*` `projects:*` `tasks:*` `templates:*` `schedules:*` `usage:query` `config:*` |
| 共享类型 | src/shared/types.ts | stable | SessionMeta/SessionProject/UsageStats/TaskRecord/ScheduleRecord 等 |
| 供应商预设 | src/shared/presets.ts | stable | 14 家；presets.test.ts 守卫 id/priority 唯一 + docUrl 齐全 |
| 虚拟模型档位 | TIER_ALIASES（wb-opus/sonnet/haiku） | stable | CLI env 注入用，路由站负责解析真实模型 |
| 路由站日志行格式 | server.ts RouterEvent | frozen | usageStore/UsagePanel 依赖；加字段必须向后兼容 |
| 任务执行器 | src/main/tasks/taskRunner.ts | stable | 复用路由站 /v1/messages stream:false + 故障转移 |

## 外部依赖契约
| 依赖 | 契约 | 风险 |
|---|---|---|
| @anthropic-ai/claude-agent-sdk | query() + Options.pathToClaudeCodeExecutable | spawn 失败会抛误导性 libc 文案（client.ts 已做 describeLaunchFailure 增强） |
| 各家上游（14 家） | anthropic 或 openai 协议 + 各自业务码 | 已有回归矩阵 regression.test.ts 14 例 |
| electron-builder | yml 配置 + CLI `-c.directories.output=` 覆盖 | safe-delete 钩子/asar 占用 → 目录按版本轮换 |
| safeStorage | encryptString/decryptString(base64) | config.json 的 apiKeyEnc 格式，勿改 |

## 待定契约（下一迭代）
- 自动更新 feed（electron-updater generic provider）——**依赖 GitHub remote，未定**
