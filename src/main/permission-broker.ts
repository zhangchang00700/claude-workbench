/**
 * 权限确认弹窗（M1 尾巴 · PermissionBroker）。
 *
 * claude CLI 每次要调用工具（Bash / Read / Write / Edit …）都会走 canUseTool 回调。
 * 在 in-process SDK 模式下没有交互式 stdin，不接这一层工具调用要么被默认拒绝、
 * 要么（bypass 模式）静默全放行。这里把请求抛给渲染层，用户点「允许/拒绝/记住」
 * 后再把裁决回传 CLI，实现可视化的权限闸门。
 *
 * 安全边界：
 * - 没有渲染窗口时一律拒绝（绝不静默放行）
 * - 超时（默认 10 分钟）自动拒绝
 * - options.signal 中止（用户点了停止/中断）时立即拒绝并清理
 */
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision, PermissionRequestView } from '../shared/types'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

interface Pending {
  resolve: (r: PermissionResult) => void
  timer: NodeJS.Timeout
  suggestions?: PermissionUpdate[]
}

export class PermissionBroker {
  private pending = new Map<string, Pending>()
  private seq = 0

  constructor(
    private readonly emit: (req: PermissionRequestView) => void,
    private readonly hasWindow: () => boolean,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  /** 给 CLI 的 canUseTool 实现 */
  readonly handler: CanUseTool = (toolName, input, options) => {
    if (!this.hasWindow()) {
      return Promise.resolve({ behavior: 'deny', message: '无可用窗口，已自动拒绝' })
    }
    const id = `perm_${Date.now().toString(36)}_${this.seq++}`
    const view: PermissionRequestView = {
      id,
      toolName,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      summary: summarizeInput(toolName, input),
      reason: options.decisionReason
    }

    const result = new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ behavior: 'deny', message: '用户超时未响应，已自动拒绝' })
      }, this.timeoutMs)
      this.pending.set(id, { resolve, timer, suggestions: options.suggestions })
      this.emit(view)
    })

    options.signal?.addEventListener('abort', () => {
      const p = this.pending.get(id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.resolve({ behavior: 'deny', message: '操作已中止' })
      }
    })

    return result
  }

  /** 渲染层裁决回传 */
  respond(id: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(id)
    if (decision.allow) {
      const res: PermissionResult = { behavior: 'allow' }
      // 「记住」：把 CLI 给的建议权限写回，作为会话级规则，后续同一工具不再询问
      if (decision.remember && p.suggestions && p.suggestions.length > 0) {
        res.updatedPermissions = p.suggestions
      }
      p.resolve(res)
    } else {
      p.resolve({ behavior: 'deny', message: '用户拒绝' })
    }
    return true
  }
}

/** 把工具 input 转成可展示的短摘要（命令/文件路径/网址等） */
function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const s = (k: string): string | undefined => {
    const v = input[k]
    return typeof v === 'string' && v ? v : undefined
  }
  const tn = toolName.toLowerCase()

  if (tn === 'bash' || tn.includes('powershell') || tn === 'shell') {
    return s('command') ?? s('cmd') ?? s('script') ?? '(无命令内容)'
  }
  if (['read', 'write', 'edit', 'multiedit', 'notebookread', 'notebookedit', 'todowrite'].includes(tn)) {
    return s('file_path') ?? s('path') ?? '(无路径)'
  }
  if (tn === 'glob') {
    const pat = s('pattern') ?? '*'
    const p = s('path') ? ` @ ${s('path')}` : ''
    return `${pat}${p}`
  }
  if (tn === 'grep') {
    const pat = s('pattern') ?? ''
    const p = s('path') ? ` @ ${s('path')}` : ''
    return `${pat}${p}`
  }
  if (tn === 'webfetch') return s('url') ?? '(无 url)'
  if (tn === 'websearch') return s('query') ?? '(无查询)'
  if (['task', 'taskcreate', 'taskupdate', 'taskget', 'tasklist'].includes(tn)) {
    return s('description') ?? s('subject') ?? s('content') ?? toolName
  }
  // 兜底：截图关键字段，过长截断
  const fallback = JSON.stringify(input)
  return fallback.length > 240 ? `${fallback.slice(0, 240)}…` : fallback
}

export function createPermissionBroker(
  emit: (req: PermissionRequestView) => void,
  hasWindow: () => boolean
): PermissionBroker {
  return new PermissionBroker(emit, hasWindow)
}
