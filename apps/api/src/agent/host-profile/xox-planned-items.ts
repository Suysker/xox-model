import type {
  AgentActionKind,
  AgentAutomationLevel,
  AgentNavigationEvent,
  AgentPlanStepStatus,
  AgentToolObservationLane,
  AgentToolObservationOutcome,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import type {
  AgentObservation as OsObservation,
  AgentToolObservationOutcome as OsToolObservationOutcome,
  JsonObject as OsJsonObject,
} from '@agentic-os/contracts'
import {
  buildToolSupervisorEmptyResultFailureObservation,
  classifyToolObservationOutcome,
  createHostObservationBridge,
  type HostObservationBridge,
} from '@agentic-os/core'
import type { Database, Row } from '../../db/schema.js'
import type { Settings } from '../../core/settings.js'
import type { CurrentUser } from '../../modules/auth.js'
import type { AgentToolCallStep } from '../tool-catalog.js'
import type { ParsedWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'

export type AgentActionDraft = {
  kind: AgentActionKind
  title: string
  summary: string
  targetLabel: string
  riskLevel: 'low' | 'medium' | 'high'
  details: Array<{ label: string; value: string }>
  navigation: AgentNavigationEvent
  payload: unknown
}

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
  observationOutcome?: AgentToolObservationOutcome
  observationLane?: AgentToolObservationLane
  syntheticObservation?: boolean
  navigation?: AgentNavigationEvent | null
  status?: AgentPlanStepStatus
}

export type AgentToolObservation = {
  title: string
  toolName: string
  toolCallId: string
  toolArguments: Record<string, unknown>
  displayPreview: string
  modelContent: string
  status: 'completed' | 'failed' | 'cancelled' | 'not_executed' | 'invalid'
  outcome?: AgentToolObservationOutcome
  lane?: AgentToolObservationLane
  synthetic?: boolean
}

export type XoxObservationBridge = HostObservationBridge<AgentToolObservation>

export type PlannerContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
  priorObservations?: AgentToolObservation[]
  automationLevel: AgentAutomationLevel
  abortSignal?: AbortSignal
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
}

export type PlannedItem = AgentActionDraft | ReadDraft

export type RuntimePlannerStep = AgentToolCallStep

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

type ToolSupervisorFailureStep = Pick<
  RuntimePlannerStep,
  'intent' | 'providerToolName' | 'providerToolCallId' | 'providerToolArguments'
>

export function toolSupervisorFailureReadDraft(step: ToolSupervisorFailureStep): ReadDraft {
  const toolName = step.providerToolName ?? step.intent ?? 'unknown_tool'
  const toolCallId = step.providerToolCallId ?? `fallback_${toolName}`
  const failure = buildToolSupervisorEmptyResultFailureObservation({
    title: '工具未生成业务结果',
    toolName,
    toolCallId,
    toolArguments: step.providerToolArguments ?? {},
  })
  return {
    title: failure.title,
    message: `工具 ${toolName} 没有生成可执行动作或可观察结果。`,
    readKind: 'tool_observation',
    toolName: failure.toolName,
    toolCallId: failure.toolCallId ?? toolCallId,
    toolArguments: failure.toolArguments,
    displayPreview: '工具没有生成业务结果。',
    modelContent: failure.modelContent,
    observationStatus: failure.observationStatus,
    observationOutcome: failure.observationOutcome,
    status: failure.status,
  }
}

export function toolSupervisorFailureObservation(step: ToolSupervisorFailureStep): AgentToolObservation {
  const toolName = step.providerToolName ?? step.intent ?? 'unknown_tool'
  const toolCallId = step.providerToolCallId ?? `fallback_${toolName}`
  const displayPreview = `工具 ${toolName} 没有生成可执行动作或可观察结果。`
  const failure = buildToolSupervisorEmptyResultFailureObservation({
    title: '工具未生成业务结果',
    toolName,
    toolCallId,
    toolArguments: step.providerToolArguments ?? {},
  })
  return {
    title: failure.title,
    toolName: failure.toolName,
    toolCallId: failure.toolCallId ?? toolCallId,
    toolArguments: failure.toolArguments,
    displayPreview,
    modelContent: failure.modelContent,
    status: failure.observationStatus,
    outcome: failure.observationOutcome,
  }
}

function compactJsonObject(value: unknown): OsJsonObject {
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
}

export function xoxObservationContent(observation: AgentToolObservation): OsJsonObject {
  return {
    xoxObservation: compactJsonObject(observation),
    displayPreview: observation.displayPreview,
    modelContent: observation.modelContent,
    status: observation.status,
    outcome: observation.outcome ?? null,
  }
}

export function xoxObservationOutcome(observation: AgentToolObservation): OsToolObservationOutcome {
  return classifyToolObservationOutcome(observation) as OsToolObservationOutcome
}

export function agenticOsObservationFromXox(
  observation: AgentToolObservation,
  index = 0,
): OsObservation {
  return {
    observationId: observation.toolCallId || `xox_observation_${index + 1}`,
    toolCallId: observation.toolCallId || `xox_tool_call_${index + 1}`,
    toolName: observation.toolName,
    status: observation.status === 'completed' ? 'ok' : 'error',
    outcome: xoxObservationOutcome(observation),
    content: xoxObservationContent(observation),
  }
}

export function xoxObservationFromAgenticOs(observation: OsObservation): AgentToolObservation {
  const content = observation.content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const maybeXox = (content as Record<string, unknown>).xoxObservation
    if (maybeXox && typeof maybeXox === 'object' && !Array.isArray(maybeXox)) {
      return maybeXox as AgentToolObservation
    }
  }

  const preview = typeof content === 'string'
    ? content
    : JSON.stringify(content ?? null)
  const fallback: AgentToolObservation = {
    title: observation.toolName,
    toolName: observation.toolName,
    toolCallId: observation.toolCallId,
    toolArguments: {},
    displayPreview: preview,
    modelContent: preview,
    status: observation.status === 'ok' ? 'completed' : 'failed',
    synthetic: true,
  }
  if (observation.outcome !== undefined) fallback.outcome = observation.outcome
  return fallback
}

export function xoxObservationKey(observation: AgentToolObservation): string {
  return [
    observation.toolCallId || observation.toolName,
    observation.status,
    observation.outcome ?? '',
    observation.modelContent,
  ].join(':')
}

export function createXoxObservationBridge(): XoxObservationBridge {
  return createHostObservationBridge<AgentToolObservation>({
    toCanonical: ({ hostObservation, index }) => agenticOsObservationFromXox(hostObservation, index),
    fromCanonical: ({ observation }) => xoxObservationFromAgenticOs(observation),
    hostKey: ({ hostObservation }) => xoxObservationKey(hostObservation),
  })
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
