# AGENTS.md — ClaudeWorkbench 项目根本约定

> 本文件是本仓库的唯一根本约定源。所有 AI 协作者与人类开发者开工前必读。

## 1. 项目定位

以 claude CLI 为内核、Electron 便携单文件 exe 为载体的「AI 化 / 自动化 / 程序化 / 工业化工作台」。
- 目标机零依赖：自带 Chromium + Node 运行时 + claude CLI 原生二进制（asarUnpack）
- V1 全量范围：对话台 / 任务队列 / 定时自动化 / 模板 SOP 流水线 / 日志进度看板
- 分发给他人使用：首次启动配置向导，密钥 DPAPI 加密，V1 不签名（附处置说明）

## 2. 环境约定（硬约束）

- 包管理器：npm；Node 以 PATH 解析为准（勿全局安装包）
- **所有脚本必须是 .ps1（PowerShell）**：本机 Git Bash 有 fork 资源故障（实测 100% 失败）
- .ps1 文件若含中文，落盘后必须为 UTF-8 with BOM；更稳妥做法是 .ps1 内容纯 ASCII
- 构建机约束：16GB 内存（可用约 3GB），构建时关闭 dev server，不并行跑重活
- 项目路径全 ASCII（`claude-workbench`），规避中文路径解析问题

## 3. 命令速查

| 命令 | 用途 |
|---|---|
| `npm run dev` | 开发模式（electron-vite dev + 热重载） |
| `npm run build` | 构建 out/ |
| `npm run typecheck` | TS 全量类型检查 |
| `npm run dist` | 构建 + 打包便携 exe 到 release/ |
| `npm test` | vitest 单元测试 |
| `npm run smoke` | **冒烟硬门禁**：scripts/smoke-test.ps1 端到端真实 query |

冒烟契约：环境变量 `CLAUDE_WORKBENCH_SMOKE=1` 启动 exe（无窗口运行），向 `%TEMP%/claude-workbench-smoke-result.json` 写结果，退出码 0 且 ok=true 为通过。**不能用 `--smoke` 命令行参数触发**：若进程被以纯 Node 模式启动，Node 参数解析器会在 JS 执行前以退出码 9 拒绝未知 flag。冒烟是 R1（SDK 打包可用性）/ R2（env 整体替换）/ R7（版本配对）的回归网，**每次发布前必跑**。

冒烟两种模式：
- `npm run smoke`：真实供应商（凭证：`SMOKE_PROVIDER`+`SMOKE_AUTH_TOKEN`，或导入本机 `~/.claude/settings.json`）
- `npm run smoke:mock`：本地 mock 上游（零外部配额，CI/回归首选，验证 exe→路由站→上游全链路）

构建通道（本机环境特例）：
- `npm run dist` → `release/`（标准通道；输出目录被 AV/索引器锁定时会失败）
- `npx electron-builder --win portable -c electron-builder.fresh.yml` → `release-fresh/`（绕开锁定目录）
- `npx electron-builder --win portable -c electron-builder.fresh2.yml` → `release-fresh2/`（**离线通道**：`electronDist: node_modules/electron/dist` 跳过下载/解压/改名，规避 Defender 实时扫描导致的 EPERM）
- `npm run dist:v3` → `release-v3/`；`npm run dist:v4` → `release-v4/`（**当前交付通道**，离线 + 双产物：portable exe + zip）
- **输出目录只能换号、不能复用**：electron-builder 复用目录时会 `emptyDir` 清 80+ 文件，触发宿主 safe-delete 批量确认钩子（阈值 50）而失败；旧目录又常被 AV/索引器持锁删不掉。目录被占就复制一份 yml 改 `directories.output` 递增编号。

启动体检（新）：
- `npm run launch:check`：启动应用并计时到窗口出现，打印 `LAUNCH_CHECK_PASS` + main.log 尾部。**用户反馈「打不开」时第一件事跑它**。
- `node scripts/ui-check.mjs <exe>`：CDP 附加渲染层，断言 UI 真渲染（非白屏）+ `window.workbench` 挂载。
- `node scripts/ui-e2e.mjs <exe>`：驱动真实渲染层 API 走「加供应商→填 Key→测试连接→默认档生效」，需本地 mock 上游。

**启动耗时基线（实测，勿凭感觉判断）**：
- 目录版 `win-unpacked/ClaudeWorkbench.exe`：**约 5 秒**出窗口（推荐分发形态）
- 便携 exe `ClaudeWorkbench-0.1.0-win.exe`：**约 25 秒**出窗口（SFX 需自解压 176MB 到 `%TEMP%` 随机目录，且被 Defender 实时扫描）
- 便携 exe 双击后 20 秒内无任何界面是**正常**的，不是启动失败。若超过 60 秒仍无窗口，再跑 launch:check 排查。
- 宿主 safe-delete 钩子会拦截 electron-builder 对旧输出目录的批量删除（>50 文件需确认）——fresh 通道天然规避

## 4. 归因与开发日志（强制）

- 对话中输出的代码块必须标注 `【修改者：WorkBuddy-{Agent-name}】`
- **文件正文、代码注释、文档内容中禁止写【修改者】类署名**
- 每完成一次代码/文件/文档改动，必须同步开发日志：`docs/report/开发日志_YYYY-MM-DD.md`（当日不存在则新建，存在则追加）
- 日志条目 4 要素：角色 / 文件（相对路径逐条）/ 内容（改了什么、为何、解决什么）/ 时间
- 提交信息用 Conventional Commits：`<type>(<scope>): <description>`，scope 用方向/模块名

## 5. 架构要点（实现时必须遵守）

- Claude 集成：主进程 `@anthropic-ai/claude-agent-sdk@0.3.301` 的 `query()` in-process；`pathToClaudeCodeExecutable` 显式指向 asarUnpack 出的 claude.exe；`ClaudeClient` 接口保留 `CliClaudeClient`（spawn + NDJSON）降级实现
- **env 注入必须是 `{...process.env, ...覆盖项}`**：SDK 的 env 为整体替换语义，漏 spread 会直接崩
- **`settingSources: []`**：不加载 user/project/local settings 文件——否则宿主机 `~/.claude/settings.json` 的 env 块会覆盖应用注入的端点/模型（实测该 env 块优先级高于进程环境变量）。应用配置（向导/AppConfig）是唯一事实来源
- **端点 URL 不带 `/v1`**：CLI 自行拼接 `/v1/messages`；base 写成 `https://api.xxx.com/anthropic` 而非 `.../v1`
- **1M 上下文陷阱**：`CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` 会让 CLI 给模型名追加 `[1m]` 变体后缀，部分中继端点不接受；默认 200000，按端点能力上调
- **`ELECTRON_RUN_AS_NODE` 自愈**：沙箱化会话会设置该变量使 electron 退化为纯 Node（`require('electron')` 返回路径字符串、未知 flag 退出码 9）。`src/main/guard.ts` 检测到即清除该变量并自重启；测试时也可在 PowerShell 先 `$env:ELECTRON_RUN_AS_NODE = $null`
- **GPU 三开关**：`disableHardwareAcceleration()` + `--disable-gpu` + `--disable-gpu-sandbox`——GPU 进程不可用的环境（虚拟机/沙箱/远程桌面）下 Chromium 会 FATAL，必须禁用
- 配置：`%APPDATA%/ClaudeWorkbench/`（入口显式 setPath 固化，不随 package.json name 漂移）；config.json 密钥 safeStorage 加密 / app-settings/ / sessions.jsonl / tasks.jsonl / schedules.json / templates/ / logs/；**不读写用户 ~/.claude**
- **模型路由站**（`src/main/model-router/`）：CLI 的 `ANTHROPIC_BASE_URL` 指向主进程 127.0.0.1 路由站；模型名一律用虚拟别名 `wb-opus/wb-sonnet/wb-haiku`，真实模型由路由站按供应商 priority 解析；内置 5 家供应商预设（glm/deepseek/kimi/agnes/ark）+ 自定义扩展位；故障转移（429/5xx/网络错误换家）+ 熔断（连续失败冷却半开）+ 档位降级（opus→sonnet→haiku）；`CW_PROVIDER_<ID>_*` 环境变量可免改文件覆盖一切；详见 `docs/design/模型路由站设计.md`
- 数据层零原生依赖：JSONL 追加 + 单写者 WriteQueue 串行化；读时按 id 折叠取终态
- 安全基线：contextIsolation=true、nodeIntegration=false、preload 仅窄 API + `stream:event` 单通道

## 6. 里程碑与 SOP 索引

- M0 空壳+冒烟（硬门禁）→ M1 单轮对话 → M2 权限与会话 → M3 任务队列 → M4 模板流水线 → M5 定时自动化 → M6 日志看板+分发就绪
- SOP 文档（M6 补齐）：docs/sop/ 构建、冒烟测试、签名与分发、升级SDK与CLI
- 风险清单：docs/risks.md

## 7. 版本锁定

electron 44.8.0 / @anthropic-ai/claude-agent-sdk 0.3.301（自带配对 CLI 2.1.301）/ vite 8 / react 19 / tailwindcss 4 / zustand 5 / typescript 5.9。升级任一座必须走升级 SOP：锁版 → npm ci → dist → smoke → 日志。
