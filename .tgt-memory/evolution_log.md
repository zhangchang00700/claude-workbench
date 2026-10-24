# evolution_log（技能自进化记录）

## 2026-10-24 记忆库 bootstrap
- 触发：Phase 0 校验发现 `.tgt-memory/` 不存在（项目此前用 `.workbuddy/memory/` 记日志）。
- 动作：从项目实况 + 工作区记忆 bootstrap 五件套；structure_hash=1267b8b9ff9b（70 src 文件）。
- 结论：非记忆损坏，属首次接入工业化流程；后续每次任务先读五件套再排产。

## 待沉淀经验（本轮迭代结束后归纳）
- 多 Agent 并行派发时的本机资源约束（16GB RAM，~3GB 可用）：重型构建（electron-builder）与全量 vitest 不宜同时跑。
- 删除类操作的授权边界：dry-run → 用户交互会话执行；AI 会话内永不静默永久删除。
