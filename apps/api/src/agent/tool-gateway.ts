import type { Kysely } from 'kysely'
import type { Settings } from '../core/settings.js'
import type { Database } from '../db/schema.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
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

export type ToolCatalogProjectionStrategy = 'full_registry' | 'model_selected_capabilities' | 'router_fallback_business_core'

export type RuntimeToolCatalogProjection = {
  strategy: ToolCatalogProjectionStrategy
  tools: ChatTool[]
  toolCount: number
  toolNames: string[]
  toolCapabilities: AgentToolMetadata[]
  selectedCapabilities: AgentToolCapability[]
  inventorySnapshot: ReturnType<typeof buildEffectiveToolInventorySnapshot>
  routerReason?: string
}

const ESSENTIAL_CAPABILITIES: AgentToolCapability[] = ['account', 'clarification']
const ROUTABLE_CAPABILITIES: AgentToolCapability[] = ['data', 'draft', 'import_export', 'ledger', 'memory', 'navigation', 'sandbox', 'share', 'version']
const BUSINESS_CORE_CAPABILITIES: AgentToolCapability[] = ROUTABLE_CAPABILITIES.filter((capability) => capability !== 'navigation')
const ALL_CAPABILITIES = new Set<AgentToolCapability>([...ESSENTIAL_CAPABILITIES, ...ROUTABLE_CAPABILITIES])
const CAPABILITY_TOOL_EXPANSIONS: Partial<Record<AgentToolCapability, string[]>> = {
  data: ['workspace_update_online_factor'],
  draft: ['workspace_reset_draft'],
}

const CAPABILITY_ROUTER_SYSTEM_PROMPT = [
  '你是 xox-model 的 Tool Catalog Gateway capability router。',
  '你的任务不是执行业务，也不是选择具体业务工具，而是为本轮用户指令选择需要暴露给主 Agent 的能力域。',
  '必须调用 tool_catalog_select_capabilities。可以选择多个能力域；普通问候、身份说明或闲聊可以传空数组。',
  '用户明确要求“记住/以后默认/以后都”某个稳定偏好或默认业务习惯时选择 memory。',
  '用户做模型参数假设、试算或问“如果某参数变成 X 会怎样”时选择 draft；普通当前数据查询才选择 data。',
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
      'memory=保存当前用户在当前工作区内的长期记忆、默认偏好或默认业务习惯。',
      'draft=调模型、预测试算、如果某模型参数变成某值会怎样、团队成员/员工/股东/成本结构/工作区名称、重置草稿为默认模型等草稿变更。',
      'version=保存快照、发布正式版、恢复版本、快照发布为正式版、删除版本。',
      'share=创建或撤销分享链接。',
      'data=当前数据只读问答、预实分析深度追问、账本历史筛选；不要把参数假设试算只归到 data。',
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
  strategy?: ToolCatalogProjectionStrategy
  routerReason?: string
  settings?: Settings
  userId?: string
  workspaceId?: string
  automationLevel?: 'manual' | 'low' | 'medium' | 'high'
}): RuntimeToolCatalogProjection {
  const selectedCapabilities = safeCapabilities(input?.selectedCapabilities)
  const hasModelSelection = input?.selectedCapabilities !== undefined && input.selectedCapabilities !== null
  const strategy: ToolCatalogProjectionStrategy = input?.strategy ?? (hasModelSelection ? 'model_selected_capabilities' : 'full_registry')
  const allowedCapabilities = strategy === 'model_selected_capabilities' || strategy === 'router_fallback_business_core'
    ? new Set<AgentToolCapability>([...ESSENTIAL_CAPABILITIES, ...selectedCapabilities])
    : null
  const expandedToolNames = new Set(
    selectedCapabilities.flatMap((capability) => CAPABILITY_TOOL_EXPANSIONS[capability] ?? []),
  )
  const entries = allowedCapabilities
    ? AGENT_TOOL_REGISTRY.filter((entry) => allowedCapabilities.has(entry.capability) || expandedToolNames.has(entry.name))
    : AGENT_TOOL_REGISTRY

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
    inventorySnapshot,
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
    ? { ...retry, routerReason: retry.routerReason ?? 'router-retry-selected-capabilities' }
    : {
        selectedCapabilities: BUSINESS_CORE_CAPABILITIES,
        strategy: 'router_fallback_business_core' as const,
        routerReason: 'router-empty-fallback-business-core',
      }
}

export async function provideRuntimeToolCatalog(ctx: ToolGatewayContext) {
  const selection = await selectCapabilitiesWithModel(ctx)
  const projection = buildRuntimeToolCatalogProjection({
    ...selection,
    ...(ctx.settings ? { settings: ctx.settings } : {}),
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
      inventorySnapshot: projection.inventorySnapshot,
      routerReason: projection.routerReason ?? null,
    },
  })
  return projection
}
