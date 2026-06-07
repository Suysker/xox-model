import type { AgentNavigationEvent, AgentPlanStepStatus } from '@xox/contracts'
import type { AgentActionDraft } from './approval-executor.js'
import type { RuntimePlanResult } from './runtime/runtime-adapter.js'

export type ReadDraft = {
  title: string
  message: string
  readKind?: 'assistant_message' | 'tool_observation' | 'status'
  toolName?: string
  toolCallId?: string
  toolArguments?: Record<string, unknown>
  modelContent?: string
  displayPreview?: string
  observationStatus?: 'completed' | 'failed' | 'cancelled' | 'not_executed' | 'invalid'
  syntheticObservation?: boolean
  navigation?: AgentNavigationEvent | null
  status?: AgentPlanStepStatus
}

export type PlannedItem = AgentActionDraft | ReadDraft

export type RuntimePlannerStep = RuntimePlanResult['steps'][number]

export type PlannedItemResult = PlannedItem | PlannedItem[] | null

export type ActionDraftHandler<TContext> = (
  ctx: TContext,
  step: RuntimePlannerStep,
) => PlannedItemResult | Promise<PlannedItemResult>

export type ActionDraftBuilderHandlers<TContext> = Partial<Record<string, ActionDraftHandler<TContext>>>

export function isActionDraft(item: PlannedItem): item is AgentActionDraft {
  return Boolean((item as AgentActionDraft).kind)
}

export function accountForbiddenRead(): ReadDraft {
  return {
    title: '账号动作需要手动完成',
    message: '账号登录、退出、注销、删除账号和改密等动作不能由 Agent 自动执行，请在账号入口手动操作。',
    readKind: 'tool_observation',
    status: 'info',
  }
}

function clarificationRead(step: RuntimePlannerStep): ReadDraft {
  const question = typeof step.question === 'string' && step.question.trim()
    ? step.question.trim()
    : '我还缺少必要信息，能补充一下吗？'
  const missingFields = Array.isArray(step.missingFields)
    ? step.missingFields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
    : []
  const suggestions = Array.isArray(step.suggestions)
    ? step.suggestions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const suffix = [
    missingFields.length > 0 ? `缺少：${missingFields.join('、')}` : null,
    suggestions.length > 0 ? `可选参考：${suggestions.join('、')}` : null,
  ].filter(Boolean).join('。')
  return {
    title: '需要补充信息',
    message: `${question}${suffix ? `（${suffix}）` : ''}`,
    readKind: 'tool_observation',
    status: 'info',
  }
}

function uiNavigateRead(step: RuntimePlannerStep): ReadDraft | null {
  if (!step.mainTab) return null
  return {
    title: '打开页面',
    message: '已打开相关页面。',
    readKind: 'tool_observation',
    navigation: {
      type: 'navigation',
      route: { mainTab: step.mainTab, secondaryTab: step.secondaryTab as never },
      reason: '用户要求切换工作台页面。',
    },
    status: 'executed',
  }
}

function attachToolMetadata(item: PlannedItemResult, step: RuntimePlannerStep): PlannedItemResult {
  if (!item) return item
  if (Array.isArray(item)) return item.map((entry) => attachToolMetadata(entry, step) as PlannedItem)
  if (isActionDraft(item)) return item
  const toolName = step.providerToolName
  return {
    ...item,
    readKind: item.readKind ?? (toolName ? 'tool_observation' : 'status'),
    ...(toolName ? { toolName } : {}),
    ...(step.providerToolCallId ? { toolCallId: step.providerToolCallId } : {}),
    ...(step.providerToolArguments ? { toolArguments: step.providerToolArguments } : {}),
  }
}

export async function buildPlannedItemFromRuntimeStep<TContext>(
  ctx: TContext,
  step: RuntimePlannerStep,
  handlers: ActionDraftBuilderHandlers<TContext>,
): Promise<PlannedItemResult> {
  if (step.intent === 'agent.ask_clarification') return attachToolMetadata(clarificationRead(step), step)
  if (step.intent === 'account.forbidden') return attachToolMetadata(accountForbiddenRead(), step)
  if (step.intent === 'ui.navigate') return attachToolMetadata(uiNavigateRead(step), step)
  if (!step.intent) return null
  const handler = handlers[step.intent]
  return handler ? attachToolMetadata(await handler(ctx, step), step) : null
}
