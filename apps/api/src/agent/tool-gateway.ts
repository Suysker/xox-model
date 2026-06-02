import type { Kysely } from 'kysely'
import type { AgentGoalFacts } from '@xox/contracts'
import type { Settings } from '../core/settings.js'
import type { Database } from '../db/schema.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import { sanitizeAgentGoalFacts } from './runtime-goal-facts.js'
import {
  buildToolContextPack,
  type ToolContextPack,
} from './tool-context-engine/index.js'
import { buildEffectiveToolInventorySnapshot } from './tool-runtime/effective-tool-inventory.js'
import {
  AGENT_TOOL_REGISTRY,
  type AgentToolCapability,
  type AgentToolMetadata,
  type ChatTool,
} from './tool-catalog.js'

type ToolGatewayContext = {
  db: Kysely<Database>
  threadId: string
  runId: string
  settings?: Settings
  message?: string
  context?: unknown
  abortSignal?: AbortSignal
  userId?: string
  workspaceId?: string
  automationLevel?: 'manual' | 'low' | 'medium' | 'high'
}

export type ToolCatalogProjectionStrategy =
  | 'full_registry'
  | 'model_selected_capabilities'
  | 'router_fallback_business_core'
  | 'progressive_tool_discovery'

export type RuntimeToolCatalogProjection = {
  strategy: ToolCatalogProjectionStrategy
  tools: ChatTool[]
  toolCount: number
  toolNames: string[]
  toolCapabilities: AgentToolMetadata[]
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities: AgentToolCapability[]
  goalFacts: AgentGoalFacts
  inventorySnapshot: ReturnType<typeof buildEffectiveToolInventorySnapshot>
  toolDescriptors: ToolContextPack['toolDescriptors']
  discoveryTrace: ToolContextPack['discoveryTrace'] | null
  routerReason?: string
}

const ESSENTIAL_CAPABILITIES: AgentToolCapability[] = ['account', 'clarification']
const ROUTABLE_CAPABILITIES: AgentToolCapability[] = ['data', 'draft', 'import_export', 'ledger', 'memory', 'navigation', 'sandbox', 'share', 'version']
const BUSINESS_CORE_CAPABILITIES: AgentToolCapability[] = ROUTABLE_CAPABILITIES.filter((capability) => capability !== 'navigation')
const ALL_CAPABILITIES = new Set<AgentToolCapability>([...ESSENTIAL_CAPABILITIES, ...ROUTABLE_CAPABILITIES])

const CAPABILITY_ROUTER_SYSTEM_PROMPT = [
  '你是 xox-model 的 Tool Context Engine router。',
  '你的任务不是执行业务，也不是选择具体业务工具，而是为本轮用户指令选择需要暴露给主 Agent 的能力域。',
  '必须调用 tool_catalog_select_capabilities。可以选择多个能力域；普通问候、身份说明或闲聊可以传空数组。',
  '如果用户显式要求写入、保存、入账、发布、分享、导入、修改模型或生成确认卡，把对应能力域放进 requiredActionCapabilities；只读查询、解释、问候和“如果怎样”的纯测算不要放入 requiredActionCapabilities。',
  'goalFacts 只填写用户原话里明确、可验证的结构化事实，例如工作区名称、成员数量、预测月数、起始月份、股东/分红主体数量、是否明确要求不要发布/分享。没有把握就留空，不要用关键词猜测。',
  '用户明确要求“记住/以后默认/以后都”某个稳定偏好或默认业务习惯时选择 memory。',
  '用户询问以前保存的记忆、历史偏好、默认习惯、让 Agent 回忆某件事或需要查证已记住规则时选择 memory。',
  '只有当用户假设改变的是当前经营模型草稿里的可编辑参数（价格、场次、线上系数、成员、员工、股东、成本、预测节奏等）并询问试算或要求保存时选择 draft。',
  '用户基于当前工作区数据、股东、投资额、ROI、现金、回本、利润做只读分析，或加入通胀率、贷款利率、税率、机会成本等外部假设进行计算/解释时，至少选择 data；需要复杂模拟或代码计算时再额外选择 sandbox。',
  '用户要求重置当前草稿、恢复默认模型或用默认模板覆盖当前输入时选择 draft。',
  '用户一次性提供完整经营简报、投资结构、批量成员、员工、成本和多月节奏并要求生成经营模型时选择 draft。',
  '用户要求股东注资、追加投资、修改投资额或分红比例时选择 draft；这属于模型草稿/资本结构，不属于 ledger，除非用户明确说要把资金到账记入实际账本分录。',
  '用户要求运行代码、复杂模拟、临时文件清洗、解析 PDF/Word/Excel/图片/JSON/HTML/Markdown、生成短期文件或需要模型写代码处理当前工作区数据时选择 sandbox。',
  '用户在同一句里同时查询数据、记账、修改模型时必须选择多个能力域，例如回本查询=data，成员销售入账=ledger，股东注资=draft。',
  '不要臆造能力域，不要输出 JSON 文本替代 tool_call。',
].join('\n')

const CAPABILITY_ROUTER_RETRY_SYSTEM_PROMPT = [
  CAPABILITY_ROUTER_SYSTEM_PROMPT,
  '上一次 capability 选择为空。本轮如果用户要求记账、调模型、新增/删除业务对象、版本、分享、导入导出、数据查询、账本筛选、运行代码或临时文件处理，必须选择至少一个非空能力域。',
  '如果用户明确要求保存长期记忆或默认偏好，必须选择 memory。',
  '只有纯问候、身份询问、闲聊或完全无业务意图时，capabilities 才能为空数组。',
].join('\n')

const CAPABILITY_SELECTION_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'tool_catalog_select_capabilities',
    description: [
      '选择本轮主 Agent planning 需要暴露的工具能力域。',
      'ledger=记账、实际分录、批量入账、历史分录修改/作废/恢复、锁账/解锁。',
      'memory=保存或只读检索当前用户在当前工作区内的长期记忆、日记忆、默认偏好、默认业务习惯和已记住规则。',
      'draft=调模型、预测试算当前草稿可编辑参数、团队成员/员工/股东/成本结构/工作区名称、重置草稿为默认模型等草稿变更。',
      'version=保存快照、发布正式版、恢复版本、快照发布为正式版、删除版本。',
      'share=创建或撤销分享链接。',
      'data=当前数据只读问答、预实分析深度追问、账本历史筛选，以及基于当前数据叠加通胀率、贷款利率、税率、机会成本等外部假设的只读财务分析。',
      'navigation=只打开页面或面板；数据问答、记账、调模型、版本、分享等业务工具会自己返回导航事件，不要额外选择 navigation。',
      'import_export=工作区 bundle 导入导出。',
      'sandbox=manifest-scoped 受控代码执行、复杂模拟、临时文件清洗/转换/校验、短期 artifact 生成；只返回 observation，不写业务数据。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          description: '本轮需要暴露给主 Agent 的能力域。若用户只是问候、闲聊或询问 Agent 身份，可以传空数组。',
          items: {
            type: 'string',
            enum: ROUTABLE_CAPABILITIES,
          },
        },
        requiredActionCapabilities: {
          type: 'array',
          description: '用户本轮明确要求产生写入动作、保存动作或确认卡的能力域。只读查询和不保存的试算不要填写。',
          items: {
            type: 'string',
            enum: ROUTABLE_CAPABILITIES,
          },
        },
        goalFacts: {
          type: 'object',
          description: '用户原话中明确出现且可由领域状态验证的目标事实；不确定时省略字段。',
          additionalProperties: false,
          properties: {
            workspaceName: { type: 'string', description: '明确要求的项目/工作区名称。' },
            expectedMemberCount: { type: 'number', description: '明确要求的成员数量。' },
            expectedShareholderCount: { type: 'number', description: '明确要求的股东或分红主体数量，含明确声明的预留池。' },
            expectedHorizonMonths: { type: 'number', description: '明确要求的预测周期月数。' },
            expectedStartMonth: { type: 'number', description: '明确要求的开始月份，1-12。' },
            requiresForecastSummary: { type: 'boolean', description: '用户明确要求输出收入、成本、利润、现金或回本等预测摘要。' },
            requiresSandboxComputation: { type: 'boolean', description: '用户明确要求跨多个事实、公式、敏感性假设、外部资金成本或临时数据转换的可复核计算，单个领域读工具不足以直接回答。' },
            forbiddenActions: {
              type: 'array',
              description: '用户明确禁止的动作。',
              items: {
                type: 'string',
                enum: ['publish_release', 'share_link', 'account_action'],
              },
            },
          },
        },
        reason: {
          type: 'string',
          description: '一句话说明选择原因，避免包含密钥、token 或 provider 原始响应。',
        },
      },
    },
  },
}

function safeCapabilities(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const selected: AgentToolCapability[] = []
  for (const item of values) {
    if (typeof item !== 'string') continue
    if (!ALL_CAPABILITIES.has(item as AgentToolCapability)) continue
    if (!selected.includes(item as AgentToolCapability)) selected.push(item as AgentToolCapability)
  }
  return selected
}

function capabilitiesFromRouterStep(step: unknown) {
  const value = step && typeof step === 'object'
    ? (step as any).capabilities ??
      (step as any).capability ??
      (step as any).selectedCapabilities ??
      (step as any).capabilityDomains ??
      (step as any).domains
    : null
  return safeCapabilities(value)
}

function requiredActionCapabilitiesFromRouterStep(step: unknown) {
  const value = step && typeof step === 'object'
    ? (step as any).requiredActionCapabilities ??
      (step as any).actionRequiredCapabilities ??
      (step as any).writeCapabilities
    : null
  return safeCapabilities(value)
}

function goalFactsFromRouterStep(step: unknown): AgentGoalFacts {
  const value = step && typeof step === 'object' ? (step as any).goalFacts : null
  return sanitizeAgentGoalFacts(value)
}

function toolMetadata(entry: (typeof AGENT_TOOL_REGISTRY)[number]): AgentToolMetadata {
  return {
    name: entry.name,
    capability: entry.capability,
    riskLevel: entry.riskLevel,
    confirmationMode: entry.confirmationMode,
    navigationTarget: entry.navigationTarget,
  }
}

export function buildRuntimeToolCatalogProjection(input?: {
  selectedCapabilities?: AgentToolCapability[] | null
  requiredActionCapabilities?: AgentToolCapability[] | null
  goalFacts?: AgentGoalFacts | null
  strategy?: ToolCatalogProjectionStrategy
  routerReason?: string
  message?: string
  settings?: Settings
  userId?: string
  workspaceId?: string
  automationLevel?: 'manual' | 'low' | 'medium' | 'high'
}): RuntimeToolCatalogProjection {
  const selectedCapabilities = safeCapabilities(input?.selectedCapabilities)
  const requiredActionCapabilities = safeCapabilities(input?.requiredActionCapabilities)
    .filter((capability) => selectedCapabilities.length === 0 || selectedCapabilities.includes(capability))
  const goalFacts = sanitizeAgentGoalFacts(input?.goalFacts)
  const hasModelSelection = input?.selectedCapabilities !== undefined && input.selectedCapabilities !== null
  const requestedStrategy: ToolCatalogProjectionStrategy = input?.strategy ?? (hasModelSelection ? 'model_selected_capabilities' : 'full_registry')
  const toolContext = requestedStrategy === 'full_registry'
    ? null
    : buildToolContextPack({
        registry: AGENT_TOOL_REGISTRY,
        selectedCapabilities,
        requiredActionCapabilities,
        ...(input?.message !== undefined ? { message: input.message } : {}),
        ...(input?.routerReason !== undefined ? { routerReason: input.routerReason } : {}),
        ...(input?.automationLevel !== undefined ? { automationLevel: input.automationLevel } : {}),
      })
  const byName = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))
  const entries = toolContext
    ? toolContext.toolNames.map((name) => byName.get(name)).filter((entry): entry is (typeof AGENT_TOOL_REGISTRY)[number] => Boolean(entry))
    : AGENT_TOOL_REGISTRY
  const strategy: ToolCatalogProjectionStrategy = toolContext ? 'progressive_tool_discovery' : requestedStrategy

  const toolCapabilities = entries.map(toolMetadata)
  const settings = input?.settings
  const inventorySnapshot = buildEffectiveToolInventorySnapshot({
    userId: input?.userId ?? 'unknown_user',
    workspaceId: input?.workspaceId ?? 'unknown_workspace',
    automationLevel: input?.automationLevel ?? 'manual',
    ...(settings ? { settings } : { provider: 'unknown', model: 'unknown' }),
    strategy,
    toolCapabilities,
    selectedCapabilities,
    ...(input?.routerReason ? { routerReason: redactSecretLikeContent(input.routerReason).slice(0, 300) } : {}),
  })

  return {
    strategy,
    tools: entries.map((entry) => entry.tool),
    toolCount: entries.length,
    toolNames: entries.map((entry) => entry.name),
    toolCapabilities,
    selectedCapabilities,
    requiredActionCapabilities,
    goalFacts,
    inventorySnapshot,
    toolDescriptors: toolContext?.toolDescriptors ?? [],
    discoveryTrace: toolContext?.discoveryTrace ?? null,
    ...(input?.routerReason ? { routerReason: redactSecretLikeContent(input.routerReason).slice(0, 300) } : {}),
  }
}

async function callCapabilityRouter(
  ctx: ToolGatewayContext & { settings: Settings; message: string; context: unknown },
  systemPrompt: string,
) {
  const result = await planWithRuntimeAdapter({
    settings: ctx.settings,
    systemPrompt,
    message: redactSecretLikeContent(ctx.message),
    context: {
      task: redactSecretLikeContent(ctx.message),
      availableCapabilities: ROUTABLE_CAPABILITIES,
      routerPurpose: 'Only choose capability buckets for the main planner. Do not inspect or copy full workspace context.',
    },
    tools: [CAPABILITY_SELECTION_TOOL],
    stream: false,
    maxTokens: 400,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })

  const selectedStep = result?.steps.find((step) => step.intent === 'tool_catalog.select_capabilities')
  const routerReason = typeof selectedStep?.reason === 'string' ? selectedStep.reason : ''
  return {
    selectedCapabilities: capabilitiesFromRouterStep(selectedStep),
    requiredActionCapabilities: requiredActionCapabilitiesFromRouterStep(selectedStep),
    goalFacts: goalFactsFromRouterStep(selectedStep),
    ...(routerReason ? { routerReason } : {}),
  }
}

async function selectCapabilitiesWithModel(ctx: ToolGatewayContext) {
  if (!ctx.settings || !ctx.message || !ctx.context || ctx.settings.llmProvider === 'rules') {
    return { selectedCapabilities: null }
  }
  const routerCtx = {
    ...ctx,
    settings: ctx.settings,
    message: ctx.message,
    context: ctx.context,
  }

  const first = await callCapabilityRouter(routerCtx, CAPABILITY_ROUTER_SYSTEM_PROMPT)
  if (first.selectedCapabilities.length > 0) return first
  const retry = await callCapabilityRouter(routerCtx, CAPABILITY_ROUTER_RETRY_SYSTEM_PROMPT)
  return retry.selectedCapabilities.length > 0
    ? {
        ...retry,
        goalFacts: Object.keys(retry.goalFacts).length > 0 ? retry.goalFacts : first.goalFacts,
        routerReason: retry.routerReason ?? 'router-retry-selected-capabilities',
      }
    : {
        selectedCapabilities: BUSINESS_CORE_CAPABILITIES,
        requiredActionCapabilities: [],
        goalFacts: first.goalFacts,
        strategy: 'router_fallback_business_core' as const,
        routerReason: 'router-empty-fallback-business-core',
      }
}

export async function provideRuntimeToolCatalog(ctx: ToolGatewayContext) {
  const selection = await selectCapabilitiesWithModel(ctx)
  const projection = buildRuntimeToolCatalogProjection({
    ...selection,
    ...(ctx.settings ? { settings: ctx.settings } : {}),
    ...(ctx.message ? { message: ctx.message } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx.automationLevel ? { automationLevel: ctx.automationLevel } : {}),
  })
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_catalog_ready',
    title: '工具目录已提供',
    message: `本轮向模型提供 ${projection.toolCount} 个 provider-native 工具，由模型通过 tool_calls 选择。`,
    status: 'running',
    data: {
      projectionStrategy: projection.strategy,
      toolCount: projection.toolCount,
      toolNames: projection.toolNames,
      toolCapabilities: projection.toolCapabilities,
      selectedCapabilities: projection.selectedCapabilities,
      requiredActionCapabilities: projection.requiredActionCapabilities,
      goalFacts: projection.goalFacts,
      inventorySnapshot: projection.inventorySnapshot,
      toolDescriptors: projection.toolDescriptors,
      discoveryTrace: projection.discoveryTrace,
      routerReason: projection.routerReason ?? null,
    },
  })
  return projection
}
