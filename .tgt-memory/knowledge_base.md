# knowledge_base（踩坑与最佳实践）

## 环境坑（Windows 本机）
1. **父目录 0 字节 package.json 毒掉 Vite**：`C:\Users\91904\WorkBuddy\2026-10-16-19-01-10\package.json` 曾为 0 字节，Vite 的 PostCSS 向上查找时 `JSON.parse('')` 崩。已删。再遇 `Failed to load PostCSS config` 先查这个。
2. **改 package.json 禁用 PS 文本替换**：`Set-Content` 会写出 Node 不认的格式（ERR_INVALID_PACKAGE_CONFIG）。用 `npm pkg set` 或 `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`。
3. **PS 5.1 读 UTF-8 默认按 GBK**：中文正则/匹配会失配。用 `[System.IO.File]::ReadAllText(p,[Text.Encoding]::UTF8)` 或正则 `\uXXXX`。
4. **非交互会话回收站不可用**：`FileSystem::DeleteDirectory(...,SendToRecycleBin)` 报「系统调用级别不正确」。涉及删除的清理脚本默认 dry-run，真实删除应由用户在交互 PowerShell 执行。
5. **绝不杀用户的进程**：杀进程前必须核对启动时间与用户活动（2026-10-19 事故：误杀用户正用的 app + 误判回收站为永久删除）。
6. **Electron 渲染层不支持 window.prompt()**：需要文本输入用内联 input + Enter；confirm() 可用。
7. **沙箱禁 Add-Type**（运行时编译 .NET 被拦截）；spawn 出的 powershell 同样受限。
8. **Bash 工具有 fork 限制**：优先 PowerShell/Node。
9. **诊断 spawn 问题用绝对 exe 路径**：设了 cwd 时相对 exe 路径会自我制造 ENOENT。
10. **Defender/索引器长期占用大文件**（如各 release 的 app.asar）：删除遇锁改走「尽力删除 + 锁定清单」。

## 网络与 GitHub（2026-10-25 实测，发版/自动更新必读）
- **代理端口以环境变量为准**（实测 57548，非 56673）：脚本里从 `HTTPS_PROXY/HTTP_PROXY` 读取，别硬编码。
- 域名通断（经代理）：`api.github.com` **200 通**；`uploads.github.com` **可达**（POST 返回 GitHub 真身 401，说明 Release asset 上传可全自动）；`github.com` **只能看不能下**（首页 200，但 archive/raw 一律 502/断流）；`raw.githubusercontent.com` TLS 握手失败。
- 推论：**git 协议推拉 + electron-updater 默认 github.com 通道在本机不可用**。发布走 `gh api`（Git Data API / releases API）；客户端下载更新走 `gh api .../releases/assets/{id} -H "Accept: application/octet-stream" --output file`，全程 api.github.com 域。
- `npm run ship` 只做 patch 递增；要发 minor/major 须先 `npm version minor --no-git-tag-version` 再 `npm run ship -- --no-bump`。
- 大文件（263MB zip）上传用 curl `--data-binary @file` 流式读盘，不要走 `gh --input`（会整个读进内存）。

## 业务机制坑
- 智谱/DeepSeek/Kimi 的 Anthropic 垫片不实现 GET /v1/models：模型列表要用各家族原生端点（ProviderPreset.modelsEndpoint）。
- GLM 把欠费/限流编成 429；200+SSE error 帧无状态码，业务码表是唯一精确信号（failure.ts PROVIDER_BUSINESS_CODES）。
- 路由站日志 userData/logs/router-<date>.jsonl 是用量/成本面板唯一数据源，勿改格式（usageStore 依赖）。
- SDK 的「binary failed to launch / libc」文案是误导：真实原因常是 cwd 不存在（spawn ENOENT）。

## 流程经验
- 打包版本号必须随构建递增（ship 通道已固化）；产物名含版本，杜绝同名包囤积。
- clean-releases 按 semver 排序保留最新 N 个；legacy 命名（release-v14 无点号）视为遗留。
- GUI 自检断言注意 CSS uppercase（比较用小写）；期望值不能出现在 prompt 里（假阳性）。
- **通道升级后必须连坐检查周边脚本**（2026-11-13）：ship 改产物到 `release-v<version>/`、clean-releases 又删掉 legacy `release/` 后，smoke-test.ps1 / smoke-mock.ps1 仍只找 `release/*portable*.exe` → 冒烟硬门禁连续两次发版实际跑不起来（exit 10）。修法是集中的 `scripts/find-smoke-exe.ps1` 按 semver 自动发现，别在多个脚本里各写一份路径。
- **version bump 要紧挨 commit**：`npm version patch --no-git-tag-version` 若放在 `git commit` 之后执行，版本号会长期只存在于工作区，本地 git 历史与已发布 tag 不一致（v0.2.1 踩过，补提交后修复）。
- **API 快照推送要挂 parent**：publish-via-api.mjs 原先每次 `POST /git/commits` 不带 parents + force PATCH ref，结果是每次一条孤立提交、message 还写死「v0.1.1 初始发布」，公开仓库历史永远停在第一天。现按 package.json 版本动态生成 message、挂 parent、tree 相同则 `NO_CHANGES` 幂等返回。
- **公开仓库截图要先审内容**：主窗口截图常含内部调试对话、私人路径、自检桩文案，不能直接入库；只放干净的 UI 特写，且用 ASCII 文件名（中文名在 README 链接里需 URL 编码易错）。
- **冒烟三条通道，真实通道不必向用户索要 Key**：`smoke` 的凭证由 smoke.ts 的 `readHostClaudeEnv()` 读本机 `~/.claude/settings.json`，按 `ANTHROPIC_BASE_URL` 主机名匹配内置供应商后回填；`smoke:mock` / `smoke:failover` 零配额。2026-11-13 真实通道实跑还顺带验证了厂商故障转移（DeepSeek 配额耗尽 → Kimi 429 → Agnes 500/429 → Kimi 200），这类证据离线 mock 给不了。
