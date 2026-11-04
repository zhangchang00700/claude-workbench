# ClaudeWorkbench

> claude CLI 内核 + Electron 便携单文件的 AI 工业化工作台：对话、任务队列、模板流水线、定时自动化、多供应商路由、用量成本、常驻速聊入口。

Windows x64 便携版，解压即用（无需安装 Node 或任何运行时）。

## 下载

到 [Releases](https://github.com/zhangchang00700/claude-workbench/releases) 下载最新 `ClaudeWorkbench-<版本>-win.zip`（解压即用）或 `...-win.exe`（便携单文件）。

## 功能（v0.2.1）

### 对话与会话
- **对话台**：流式聊天、工具调用可视化、权限确认（允许一次/总是允许/拒绝）、会话恢复
- **多会话页签**：多会话并行推进，各自草稿独立；后台会话继续输出，切回内容完整
- **会话管理**：项目分组、归档（不删数据）、删除、移入移出项目（语义对齐 Claude Desktop）
- **全局热键速聊条**：任意界面一键唤起（默认 `Alt+Space`，被系统占用时自动降级 `Ctrl+Alt+Space`，以界面显示为准），Esc/失焦即收起，答完可「投送到完整会话」

### 自动化与批量
- **任务队列**：批量提示词排队执行、并发控制、失败重试、manual 门禁
- **模板与 SOP 流水线**：`{{变量}}` 填充、CSV/JSON 批量展开、步骤门禁（contains/regex/manual）
- **定时自动化**：间隔/每日调度，到点批量入队（模板×变量组或固定提示词）

### 模型路由与成本
- **模型路由站**：14 家供应商预设（智谱 GLM / DeepSeek / Kimi / 阶跃 / 方舟 / 硅基流动 / MiniMax 等），自动故障转移、熔断、厂商业务码表识别
- **用量与成本看板**：请求维度统计 + token 与金额估算（官方价目表，含 DeepSeek 峰谷时段）；数据来自路由站请求日志，实时
- **托盘**：供应商秒切、主窗口呼出、速聊兜底入口

### 更新
- **内置更新检测与一键安装**：检查新版本 → 下载（带进度）→ 一键安装并重启（配置与会话数据不受影响）

## 快速开始（开发）

```powershell
npm install
npm run dev
```

## 构建与发版

```powershell
npm run build          # 编译 out/
npm run ship           # 版本自增 + 构建 + 打包 release-v<version>/ + 自动清理旧产物
node scripts/publish-release.mjs   # 发布到 GitHub Releases（gh api 通道）
```

门禁：`npm run typecheck`（0 错误）+ `npx vitest run`（0 失败）+ GUI 自检脚本（`scripts/ui-*-check.mjs`，真实启动应用模拟用户操作流）。

## 架构速览

```
Electron 主进程
├── 模型路由站（本地 HTTP，/v1/messages）─ 供应商预设 × 故障转移 × 熔断 × 请求日志
├── 会话存储（%APPDATA%\ClaudeWorkbench，写入串行化，损坏自动从 .bak 恢复）
├── 任务队列 / 模板流水线 / 定时调度
└── 速聊窗（预热常驻）/ 托盘 / 桌宠 / 更新通道（gh api）
渲染层 React + Tailwind（主窗口 + 速聊条 + 桌宠三入口）
```

- 主窗口对话依赖本机 claude CLI；**速聊条不依赖 CLI**，直连模型路由站（秒开秒答）
- API Key 经系统 safeStorage 加密存储于 `%APPDATA%\ClaudeWorkbench\config.json`

## 已知限制

- 仅 Windows x64
- 自动更新检测依赖 `gh` CLI（`gh auth login`）或网络可达 GitHub API，不满足时给出明确原因

## 项目约定

见 [AGENTS.md](./AGENTS.md)。开发日志见 `docs/report/`。
