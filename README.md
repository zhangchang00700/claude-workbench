# ClaudeWorkbench

以 claude CLI 为内核的「AI 化 / 自动化 / 程序化 / 工业化工作台」。Electron 便携单文件 exe，目标机零依赖（双击即用，无需安装 Node 或任何运行时）。

## 功能（V1 全量）

- **对话台**：类 Claude Desktop 的流式聊天、工具调用可视化、权限确认（允许一次/总是允许/拒绝）、会话恢复
- **任务队列**：批量提示词排队执行、并发控制、失败重试、manual 门禁
- **定时自动化**：node-cron 调度 + Windows 计划任务兜底导出
- **模板与 SOP 流水线**：`{{变量}}` 填充、CSV/JSON 批量展开、步骤门禁（contains/regex/manual）
- **日志与进度看板**：JSONL 追加式全量事件日志、任务进度实时视图

## 快速开始（开发）

```powershell
npm install
npm run dev
```

## 构建与冒烟

```powershell
npm run dist    # 产出 release/ClaudeWorkbench-<version>-portable.exe
npm run smoke   # 端到端冒烟（硬门禁）：真实 query，断言 SMOKE-OK
```

冒烟凭证来源（按优先级）：`SMOKE_BASE_URL` / `SMOKE_AUTH_TOKEN` / `SMOKE_MODEL` 环境变量 → 本机 `~/.claude/settings.json` 的 env 块 → 进程环境 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`。

**端点 URL 不要带 `/v1`**（CLI 自行拼接 `/v1/messages`），例如 `https://api.deepseek.com/anthropic`。`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 不要随意设 1000000——部分中继端点不接受 `[1m]` 模型变体后缀。

若从沙箱化会话启动应用出现"瞬间退出 / bad option"，检查 `ELECTRON_RUN_AS_NODE`（应用内置自愈，会清除该变量后以 Electron 模式重启）。

## 分发说明

见 `docs/sop/签名与分发SOP.md`（M6 补齐）。V1 不代码签名：SmartScreen 需「更多信息 → 仍要运行」；同时提供 zip 备选与 SHA-256 校验。

## 项目约定

见 [AGENTS.md](./AGENTS.md)。开发日志见 `docs/report/`。
