/**
 * 共享类型：模型路由站配置结构（AppConfig v2）。
 *
 * 设计原则：
 * - API Key 只存在于配置文件中（safeStorage 加密）或 CW_ 环境变量，严禁硬编码
 * - 切换模型/供应商只改配置，不改核心业务代码
 * - 内置 14 家供应商预设（deepseek/glm/kimi/agnes/ark/stepfun + 2026-10-17 扩充的 modelscope/minimax/tokenhub/siliconflow/aihubmix/bailian/qiniu/openrouter），预留自定义扩展位
 */

export type ModelTier = 'opus' | 'sonnet' | 'haiku'

/**
 * 上游端点协议类型。
 *
 * claude CLI 只说 Anthropic Messages 协议，所以路由站对上（CLI）永远是 Anthropic；
 * 对下（各家供应商）则分两类：
 * - anthropic：官方/兼容 /v1/messages（GLM、DeepSeek、Kimi、火山方舟 /api/compatible）
 * - openai   ：只提供 /chat/completions（Agnes 等中继），路由站做协议转换
 */
export type ProviderProtocol = 'anthropic' | 'openai'

/** 协议 → 端点路径与界面说明 */
export interface ProtocolSpec {
  label: string
  /** 对话端点（拼在 baseUrl 之后，CLI/路由站自动拼接，用户不需要填） */
  messagesPath: string
  /** 模型列表端点 */
  modelsPath: string
  /** 界面提示：告诉用户该填到哪一级路径 */
  hint: string
  /** 是否支持工具调用透传（openai 兼容端点仅做文本转换） */
  supportsTools: boolean
}

export const PROTOCOL_SPECS: Record<ProviderProtocol, ProtocolSpec> = {
  anthropic: {
    label: 'Anthropic 兼容',
    messagesPath: '/v1/messages',
    modelsPath: '/v1/models',
    hint: '填到域名/前缀一级即可（如 https://api.deepseek.com/anthropic），不要带 /v1 或 /v1/messages',
    supportsTools: true
  },
  openai: {
    label: 'OpenAI 兼容',
    messagesPath: '/chat/completions',
    modelsPath: '/models',
    hint: '填到带 /v1 的一级（如 https://apihub.agnes-ai.com/v1）；路由站做 Anthropic↔OpenAI 转换（含工具调用），不支持图片/文档块与 prompt caching',
    supportsTools: true
  }
}

/**
 * 规范化 baseUrl：去掉用户粘贴时常带的尾斜杠与端点后缀。
 * 这是本项目踩过的实际坑（端点被拼成 /v1/v1/messages 导致 404）。
 */
export function normalizeBaseUrl(raw: string, protocol: ProviderProtocol = 'anthropic'): string {
  let u = (raw ?? '').trim()
  if (!u) return u
  u = u.replace(/\/+$/, '')
  const strip = protocol === 'openai' ? ['/chat/completions', '/models'] : ['/v1/messages', '/v1/models', '/v1']
  for (const suffix of strip) {
    if (u.toLowerCase().endsWith(suffix)) {
      u = u.slice(0, -suffix.length)
      break
    }
  }
  return u.replace(/\/+$/, '')
}

/** 拼出实际请求 URL（界面展示用：让用户一眼看到会打到哪里） */
export function endpointUrl(baseUrl: string, protocol: ProviderProtocol, kind: 'messages' | 'models'): string {
  const spec = PROTOCOL_SPECS[protocol] ?? PROTOCOL_SPECS.anthropic
  return normalizeBaseUrl(baseUrl, protocol) + (kind === 'messages' ? spec.messagesPath : spec.modelsPath)
}

/** 校验 URL 是否可用（界面输入即时反馈） */
export function validateBaseUrl(raw: string, protocol: ProviderProtocol = 'anthropic'): string | null {
  const u = (raw ?? '').trim()
  if (!u) return 'base url 不能为空'
  if (!/^https?:\/\//i.test(u)) return '必须以 http:// 或 https:// 开头'
  try {
    new URL(u)
  } catch {
    return 'URL 格式不合法'
  }
  const normalized = normalizeBaseUrl(u, protocol)
  if (normalized !== u.replace(/\/+$/, '')) return `已自动去掉多余后缀，实际请求：${normalized}`
  return null
}

/** 供应商三档模型映射（对应 CLI 的 opus/sonnet/haiku 档位） */
export interface ProviderModelMap {
  opus?: string
  sonnet?: string
  haiku?: string
}

export interface ProviderConfig {
  /** 稳定 id，环境变量覆盖用：CW_PROVIDER_<ID>_API_KEY（ID 大写，连字符转下划线） */
  id: string
  name: string
  /** 端点前缀（不带具体端点路径，路由站按 protocol 自动拼接） */
  baseUrl: string
  /** 上游协议类型：anthropic 直连 / openai 需转换。缺省按 anthropic 处理（v2 旧配置兼容） */
  protocol?: ProviderProtocol
  /**
   * 模型列表端点（绝对 URL）。部分供应商的 Anthropic 兼容垫片不实现 /v1/models
   * （智谱/DeepSeek/Kimi 的模型列表只在原生 OpenAI 风格端点），此时必须显式指定；
   * 留空则按 protocol 默认路径（anthropic=<base>/v1/models，openai=<base>/models）。
   */
  modelsEndpoint?: string
  /** safeStorage 加密后的 API Key（明文绝不落盘） */
  apiKeyEnc: string
  models: ProviderModelMap
  /** 默认模型（ANTHROPIC_MODEL）；留空则取 sonnet 档 */
  defaultModel?: string
  /** 优先级，数字越小越优先；同优先级按配置顺序 */
  priority: number
  enabled: boolean
  maxContextTokens?: number
  /** 内置预设标记（预设项允许被用户改 baseUrl/key，但 id 不可改） */
  builtin: boolean
}

export interface RouterCircuitBreaker {
  /** 连续失败多少次触发熔断 */
  failureThreshold: number
  /** 熔断冷却毫秒数，到期后半开试探 */
  cooldownMs: number
}

export interface RouterConfig {
  /** 0 = 随机端口；固定端口便于排查问题 */
  port: number
  /** 本地校验 token（随机生成，随配置注入 CLI env，防同机其他进程盗用） */
  localToken: string
  /** 429 是否触发故障转移（默认 true） */
  retryOn429: boolean
  /** 上游超时毫秒（首字节） */
  timeoutMs: number
  circuitBreaker: RouterCircuitBreaker
}

export interface AppConfig {
  version: 2
  onboarded: boolean
  /** 模型路由站配置 */
  router: RouterConfig
  /** 供应商列表（内置预设 + 用户自定义） */
  providers: ProviderConfig[]
  workspace: {
    defaultDir: string
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    maxConcurrent: number
  }
  updatedAt: string
}

/** 路由站对外暴露的虚拟模型别名（CLI 只认这些名字） */
export const TIER_ALIASES: Record<ModelTier, string> = {
  opus: 'wb-opus',
  sonnet: 'wb-sonnet',
  haiku: 'wb-haiku'
}

/** CLI --fallback-model 传入的降级链（从高到低） */
export const DEFAULT_FALLBACK_CHAIN = [TIER_ALIASES.sonnet, TIER_ALIASES.haiku]

/** 内置供应商预设（baseUrl/key 以外的默认值；key 必须由用户填写） */
export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  protocol: ProviderProtocol
  models: ProviderModelMap
  defaultModel?: string
  priority: number
  maxContextTokens?: number
  /** 模型列表端点（绝对 URL，Bearer 鉴权）；见 ProviderConfig.modelsEndpoint 说明 */
  modelsEndpoint?: string
  /** 官方文档出处，界面「查看来源」用，也便于日后核对是否过期 */
  docUrl?: string
}

/**
 * 内置供应商预设（2026-10 核对各官方接入文档）。
 *
 * 核对原则：baseUrl 与模型名必须来自供应商官方「接入 Claude Code / Anthropic 兼容」文档；
 * 没有官方出处的模型名一律不写，宁可留空由「自动获取模型」补。
 * docUrl 便于下次核对是否过期（模型名迭代很快，DeepSeek/Kimi 均已换代）。
 */
export const BUILTIN_PRESETS: ProviderPreset[] = [
  {
    id: 'glm',
    name: '智谱 GLM',
    protocol: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: { opus: 'glm-5.3', sonnet: 'GLM-5.3-Flash', haiku: 'GLM-5.3-Flash' },
    defaultModel: 'GLM-5.3-Flash',
    priority: 1,
    maxContextTokens: 200000,
    // Anthropic 垫片不实现 /v1/models；模型列表只在原生端点（Bearer 鉴权）
    modelsEndpoint: 'https://open.bigmodel.cn/api/paas/v4/models',
    docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/latest-model'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    // V4 世代：deepseek-v4-pro（强）/ deepseek-flash（快）
    // 官方模型页明示「模型名请使用 deepseek-flash」；旧名 deepseek-v4-flash /
    // deepseek-v4-flash-vision-exp 仍可调用但对应模型已下线，仅按 Flash 价格计费的兼容别名
    models: { opus: 'deepseek-v4-pro', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' },
    defaultModel: 'deepseek-flash',
    priority: 2,
    maxContextTokens: 1024000,
    // Anthropic 垫片不实现 /v1/models；模型列表在 OpenAI 原生端点（Bearer 鉴权）
    modelsEndpoint: 'https://api.deepseek.com/models',
    docUrl: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code'
  },
  {
    id: 'kimi',
    name: '月之暗面 Kimi',
    protocol: 'anthropic',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    // 国际版 Key 需改填 https://api.moonshot.ai/anthropic
    models: { opus: 'kimi-k3', sonnet: 'kimi-k3', haiku: 'kimi-k2.7-code' },
    defaultModel: 'kimi-k3',
    priority: 3,
    maxContextTokens: 1000000,
    // Anthropic 垫片不实现 /v1/models；模型列表在 OpenAI 原生端点（Bearer 鉴权）
    modelsEndpoint: 'https://api.moonshot.cn/v1/models',
    docUrl: 'https://platform.moonshot.cn/docs/guide/claude-code-kimi'
  },
  {
    id: 'agnes',
    name: 'Agnes 中继',
    protocol: 'openai',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    models: { opus: 'agnes-2.0-flash', sonnet: 'agnes-2.0-flash', haiku: 'agnes-2.0-flash' },
    defaultModel: 'agnes-2.0-flash',
    priority: 4,
    maxContextTokens: 200000,
    docUrl: 'https://apihub.agnes-ai.com'
  },
  {
    id: 'ark',
    name: '火山引擎 Ark',
    protocol: 'anthropic',
    // 方舟两套协议两套地址：Anthropic 兼容 = /api/compatible（Claude Code 用这个），
    // OpenAI 兼容 = /api/v3。此前误填 /api/v3 会被拼成 /api/v3/v1/messages 直接 404。
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    models: {
      opus: 'doubao-seed-2-1-pro-260628',
      sonnet: 'doubao-seed-2-1-turbo-260628',
      haiku: 'doubao-seed-2-1-lite-260915'
    },
    defaultModel: 'doubao-seed-2-1-turbo-260628',
    priority: 5,
    maxContextTokens: 256000,
    docUrl: 'https://www.volcengine.com/docs/82379/1463945'
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    protocol: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    // 海外 Key 走 https://api.stepfun.ai/v1（OpenAI 兼容，同一套模型 ID）
    models: { opus: 'step-5-preview', sonnet: 'step-5-preview', haiku: 'step-3.7-flash' },
    defaultModel: 'step-5-preview',
    priority: 6,
    docUrl: 'https://platform.stepfun.com/docs/zh/api-reference/chat'
  },
  // ── 以下 8 家为 2026-10-17 预设库扩充（调研报告 docs/report/预设库扩充调研_2026-10-17.md）──
  // 统一续在既有 6 家之后，不打乱原路由顺序；用户可在设置页「提权」。key 均由用户填写。
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    protocol: 'anthropic',
    // 注册用户免费（2000 次/日）；Anthropic 兼容端点 base_url 不带 /v1
    baseUrl: 'https://api-inference.modelscope.cn',
    models: {
      opus: 'deepseek-ai/DeepSeek-V4-Pro',
      sonnet: 'ZhipuAI/GLM-5.2',
      haiku: 'Qwen/Qwen3.5-35B-A3B'
    },
    defaultModel: 'Qwen/Qwen3.5-35B-A3B',
    priority: 7,
    docUrl: 'https://www.modelscope.cn/docs/model-service/API-Inference/intro'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'anthropic',
    // 官方 Anthropic 端点（推荐接入方式）；注意 M2.5/M2.7 于 2026-11-18 退役，关注 M3.1-Flash
    baseUrl: 'https://api.minimaxi.com/anthropic',
    models: { opus: 'MiniMax-M3', sonnet: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7-highspeed' },
    defaultModel: 'MiniMax-M3',
    priority: 8,
    docUrl: 'https://platform.minimax.cn/docs/guides/quickstart-preparation'
  },
  {
    id: 'tokenhub',
    name: 'TokenHub（腾讯云）',
    protocol: 'anthropic',
    // 腾讯官方聚合：OpenAI/Anthropic 共用 Base URL 按路径区分；有 GET /v1/models 可自动获取
    baseUrl: 'https://tokenhub.tencentcloudmaas.com',
    models: { opus: 'hy4-preview', sonnet: 'glm-5.3', haiku: 'deepseek/deepseek-v4-flash' },
    defaultModel: 'deepseek/deepseek-v4-flash',
    priority: 9,
    docUrl: 'https://www.tencentcloud.com/zh/document/product/1300/80632'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    // 开源模型目录最全；有 GET /models；无 Anthropic 端点，由路由站做协议转换；模型 ID 带 org/ 前缀
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: {
      opus: 'deepseek-ai/DeepSeek-V4-Pro',
      sonnet: 'zai-org/GLM-5.1',
      haiku: 'deepseek-ai/DeepSeek-V4-Flash'
    },
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    priority: 10,
    docUrl: 'https://docs.siliconflow.cn/docs/api/models-get'
  },
  {
    id: 'aihubmix',
    name: 'AiHubMix',
    protocol: 'anthropic',
    // 少数同时提供 Claude 原生 /v1/messages + 27 个 *-free 免费模型的聚合站；有 GET /v1/models
    baseUrl: 'https://aihubmix.com',
    models: { opus: 'claude-opus-5-5', sonnet: 'claude-haiku-5-5', haiku: 'deepseek-v4-flash-0731' },
    defaultModel: 'claude-haiku-5-5',
    priority: 11,
    docUrl: 'https://docs.aihubmix.com/cn/api/Claude-Native'
  },
  {
    id: 'bailian',
    name: '阿里云百炼',
    protocol: 'openai',
    // 无 Anthropic 端点需协议转换；同平台可调 deepseek-v4-pro/glm-5.2 等三方模型
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: { opus: 'qwen3.8-max', sonnet: 'qwen3.7-plus', haiku: 'qwen3.8-flash' },
    defaultModel: 'qwen3.7-plus',
    priority: 12,
    docUrl: 'https://help.aliyun.com/zh/model-studio/text-generation-model'
  },
  {
    id: 'qiniu',
    name: '七牛云 AI 推理',
    protocol: 'anthropic',
    // 新用户赠 300 万 token；有 /v1/models；模型 ID 带 qiniu/ 前缀
    baseUrl: 'https://api.qnaigc.com',
    models: { opus: 'qiniu/qwen3-max', sonnet: 'qiniu/z-ai/glm-5', haiku: 'qiniu/deepseek-v3.2-251201' },
    defaultModel: 'qiniu/deepseek-v3.2-251201',
    priority: 13,
    docUrl: 'https://developer.qiniu.com/aitokenapi/13379/real-time-ai-interface-api'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    // 海外聚合，国内直连未实测；免费档无需信用卡；无 Anthropic 原生端点需协议转换
    baseUrl: 'https://openrouter.ai/api/v1',
    models: {
      opus: 'anthropic/claude-opus-5.5',
      sonnet: 'anthropic/claude-sonnet-5.5',
      haiku: 'anthropic/claude-haiku-5.5'
    },
    defaultModel: 'anthropic/claude-sonnet-5.5',
    priority: 14,
    docUrl: 'https://openrouter.ai/docs/api_reference/authentication'
  }
]

/**
 * 旧默认值修复表：升级后把「用户没改过、仍是上一版错误默认值」的字段纠正。
 * 只在该字段值与旧值完全一致时替换，用户手改过的一律不动。
 * from 支持多值：模型名可能经历多代更名（如 deepseek-chat → v4-flash → flash），
 * 每一代的旧值都要能修到现行值。
 * 记录历史：v2 首版内置值经官方文档核对后有 2 处端点错、3 处模型名过期。
 */
export const PRESET_FIXUPS: Record<
  string,
  {
    baseUrl?: { from: string; to: string }
    models?: Record<string, { from: string | string[]; to: string }>
  }
> = {
  agnes: { baseUrl: { from: 'https://apihub.agnes-ai.com', to: 'https://apihub.agnes-ai.com/v1' } },
  ark: {
    baseUrl: {
      from: 'https://ark.cn-beijing.volces.com/api/v3',
      to: 'https://ark.cn-beijing.volces.com/api/compatible'
    },
    models: {
      opus: { from: 'doubao-pro-32k', to: 'doubao-seed-2-1-pro-260628' },
      sonnet: { from: 'doubao-pro-32k', to: 'doubao-seed-2-1-turbo-260628' },
      haiku: { from: 'doubao-lite-4k', to: 'doubao-seed-2-1-lite-260915' }
    }
  },
  deepseek: {
    models: {
      opus: { from: 'deepseek-reasoner', to: 'deepseek-v4-pro' },
      // 2026-10-17 官方模型页明示现行名为 deepseek-flash；v4-flash 为已下线模型的兼容别名
      sonnet: { from: ['deepseek-chat', 'deepseek-v4-flash'], to: 'deepseek-flash' },
      haiku: { from: ['deepseek-chat', 'deepseek-v4-flash'], to: 'deepseek-flash' }
    }
  },
  kimi: {
    models: {
      opus: { from: 'kimi-k2-turbo-preview', to: 'kimi-k3' },
      sonnet: { from: 'kimi-k2-turbo-preview', to: 'kimi-k3' },
      haiku: { from: 'moonshot-v1-8k', to: 'kimi-k2.7-code' }
    }
  },
  glm: {
    models: {
      haiku: { from: 'glm-4.5-air', to: 'GLM-5.3-Flash' }
    }
  }
}

/** 环境变量覆盖前缀 */
export const ENV_PREFIX = 'CW_'

/** provider id → 环境变量名片段（大写，连字符转下划线） */
export function providerEnvId(id: string): string {
  return id.toUpperCase().replace(/-/g, '_')
}

/* ───────────────────────── 会话历史（M1 尾巴：持久化） ───────────────────────── */

/** 落盘的单条消息（system/router 提示不持久化，避免噪声） */
export interface StoredMsg {
  role: 'user' | 'assistant'
  text: string
  /** 底层 CLI 执行错误：以红字呈现，而非助手发言 */
  isError?: boolean
  ts: number
}

/** 会话元信息（列表用，不含整段消息） */
export interface SessionMeta {
  /** 应用层会话 id（与底层 CLI session 解耦） */
  id: string
  /** 标题（首条用户消息截断） */
  title: string
  createdAt: number
  updatedAt: number
  tier: ModelTier
  /** 底层 CLI session（用于 resume 续聊） */
  cliSessionId?: string | null
  messageCount: number
  /** 首屏预览文本 */
  preview: string
  /** 所属项目 id；null = 未分组（对齐 Claude Desktop 的「未加入项目的聊天」） */
  projectId: string | null
  /** 已归档的会话从主列表移出，进「已归档」折叠区，不删除 */
  archived: boolean
}

/**
 * 会话项目（对齐 Claude Desktop Projects，落盘 userData/projects/<id>.json）。
 * 本项目只做「分组 + 归档」，不引入 project knowledge / 项目级记忆。
 */
export interface SessionProject {
  id: string
  name: string
  description: string
  /** 归档后沉到列表底部（Claude Desktop 的 archived projects） */
  archived: boolean
  createdAt: number
  updatedAt: number
}

/** 完整会话记录（含消息） */
export interface SessionRecord extends SessionMeta {
  messages: StoredMsg[]
}

/* ───────────────────── 权限确认（M1 尾巴：PermissionBroker） ───────────────────── */

/** 渲染层见到的权限请求（已脱敏：只给可展示字段 + 输入摘要） */
export interface PermissionRequestView {
  /** 本次请求 id（respond 时回传） */
  id: string
  toolName: string
  /** 桥接层给的中文长句（如「Claude 想要读取 foo.txt」），优先展示 */
  title?: string
  /** 短名词（如「读取文件」），用于按钮/紧凑 UI */
  displayName?: string
  /** 桥接层副标题 */
  description?: string
  /** 对 tool input 做的友好摘要（命令/文件路径等） */
  summary: string
  /** 触发原因（decisionReason），便于用户判断风险 */
  reason?: string
}

/** 渲染层回传的裁决 */
export interface PermissionDecision {
  allow: boolean
  /** 本次允许并写入会话级规则，后续相同工具不再询问 */
  remember: boolean
}

/* ───────────────────── M2 任务队列（Task Queue） ───────────────────── */

/** 任务生命周期状态 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * 单条任务记录（落盘 userData/tasks/<id>.json）。
 *
 * 任务 = 一次「纯文本 prompt → 文本产出」的批量作业（类似 CLI --print 模式），
 * 不走工具调用/权限弹窗，由模型路由站统一执行，因此天然享受故障转移与熔断。
 */
export interface TaskRecord {
  id: string
  title: string
  prompt: string
  /** 任务档位：决定路由站解析到哪档真实模型（wb-opus/sonnet/haiku） */
  tier: ModelTier
  /** 单次请求最大输出 token */
  maxTokens: number
  /** 失败后最大重试次数（不含首次执行） */
  maxRetries: number
  status: TaskStatus
  /** 已尝试次数（含成功或最终失败那次） */
  attempts: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  /** 成功后的最终文本产出 */
  output: string
  /** 失败原因（最后一次错误摘要，截断到 500 字） */
  error: string | null
  /** 最近一次执行命中的供应商 id（结果旁注用，可选） */
  lastProvider?: string | null
}

/** 任务队列实时事件（stream:event domain='tasks' 的 payload）。all 为最新全量列表，渲染层直接替换。 */
export type TaskEvent =
  | { type: 'created' | 'updated'; task: TaskRecord; all: TaskRecord[] }
  | { type: 'removed'; id: string; all: TaskRecord[] }
  | { type: 'cleared' }

/**
 * 提示词模板（M3 模板流水线，落盘 userData/templates/<id>.json）。
 * prompt 内用 {{变量名}} 占位；入队时按「变量组」批量渲染成多条任务，走 M2 任务队列执行。
 */
export interface TemplateRecord {
  id: string
  name: string
  description: string
  prompt: string
  tier: ModelTier
  maxTokens: number
  maxRetries: number
  createdAt: number
  updatedAt: number
}

/** 模板变量的一组取值：变量名 → 多行值（每行对应一条任务） */
export type TemplateVars = Record<string, string>

/** 定时计划的上次执行结果分类 */
export type ScheduleStatus = 'never' | 'ok' | 'error'

/**
 * 用量记录视图（M5 用量看板）：由路由站请求日志（userData/logs/router-<date>.jsonl）
 * 解析而来，一次上游尝试一条。
 */
export interface UsageRecordView {
  ts: number
  provider: string | null
  /** CLI 请求的虚拟档位（wb-opus/wb-sonnet/wb-haiku） */
  requestedModel: string | null
  /** 路由解析后的真实模型名 */
  actualModel: string | null
  status: number | null
  ms: number | null
  ok: boolean
  /** 上游返回的输入/输出 token（抓不到时为 null） */
  inputTokens?: number | null
  outputTokens?: number | null
  /** 按官方价目表估算的金额（元）；无价目的模型为 null */
  cost: number | null
  /** 失败分类：failover=可转移并已转移；fault=客户端错误透传；fatal=其他 */
  failureKind: 'failover' | 'fault' | 'fatal' | null
  error: string | null
}

export interface ProviderBucket {
  provider: string
  requests: number
  failed: number
  avgMs: number
  /** 该供应商的 token 与估算金额（仅可估算的记录计入） */
  inputTokens: number
  outputTokens: number
  cost: number
}

export interface DayBucket {
  date: string
  requests: number
  failed: number
}

export interface UsageStats {
  total: number
  ok: number
  failed: number
  /** 因失败触发故障转移的次数 */
  failovers: number
  avgMs: number
  maxMs: number
  totalInputTokens: number
  totalOutputTokens: number
  /** 估算总金额（元），只累加有价目的记录 */
  totalCost: number
  /** 有 token 记录的请求数（用于说明成本覆盖率） */
  tokenRecords: number
  providers: ProviderBucket[]
  days: DayBucket[]
}

/**
 * 定时自动化计划（M4，落盘 userData/schedules/<id>.json）。
 * 到点后由本地调度器把「模板 × 变量组」或「固定 prompt」批量入队，
 * 复用 M2 任务队列执行（故障转移/熔断/并发限流一并享受）。
 */
export interface ScheduleRecord {
  id: string
  name: string
  enabled: boolean
  /** interval = 每 N 分钟；daily = 每天 HH:mm（本地时间） */
  kind: 'interval' | 'daily'
  intervalMinutes: number
  /** 'HH:mm'，kind='daily' 时用 */
  dailyTime: string
  /** template = 模板+变量组（可多条）；prompt = 固定 prompt 单条 */
  source: 'template' | 'prompt'
  templateId?: string
  vars?: TemplateVars[]
  prompt?: string
  tier: ModelTier
  maxRetries: number
  lastRunAt: number | null
  nextRunAt: number
  lastStatus: ScheduleStatus
  lastError: string | null
  createdAt: number
  updatedAt: number
}
