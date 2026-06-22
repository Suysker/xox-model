import type {
  AgentActionKind,
  AgentGoalFacts,
  AgentNavigationEvent,
  AgentPlanStepStatus,
  AgentToolObservationLane,
  AgentToolObservationOutcome,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import {
  buildToolSupervisorEmptyResultFailureObservation,
  classifyToolObservationOutcome,
} from '@agentic-os/core'
import { providerToolCallBoundaryObservations } from '@agentic-os/runtime-openai-compatible'
import type { Database, Row } from '../../db/schema.js'
import type { Settings } from '../../core/settings.js'
import type { CurrentUser } from '../../modules/auth.js'
import { redactSecretLikeContent } from '../memory.js'
import type { ParsedWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'
import type { AgentAutomationLevel } from '../tool-policy.js'
import type { AgentToolObservation } from '../agentic-os/xox-tool-observation-adapter.js'
import type { AgentLoopObligationPlan } from '../agentic-os/xox-final-review-adapter.js'
import type { RuntimePlanError, RuntimePlanResult } from '../agentic-os/xox-runtime-adapter.js'

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

export type PlannerContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
  planningTurn?: 'user_objective' | 'evaluator_repair'
  priorObservations?: AgentToolObservation[]
  loopObligationPlan?: AgentLoopObligationPlan
  goalFacts?: AgentGoalFacts
  automationLevel: AgentAutomationLevel
  abortSignal?: AbortSignal
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
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

function providerToolCallBoundaryObservationReads(error?: RuntimePlanError | null): ReadDraft[] | null {
  const observations = providerToolCallBoundaryObservations(error)
  if (observations.length === 0) return null

  return observations.map((observation) => {
    const toolName = observation.toolName
    const displayPreview = `Provider 返回了 ${toolName} 工具调用意图，但参数未形成可执行 observation。`
    const modelContent = observation.modelContent
    const observationOutcome = classifyToolObservationOutcome({
      toolName,
      status: 'not_executed',
      modelContent,
      synthetic: true,
    })
    return {
      title: '工具调用未形成可执行参数',
      message: displayPreview,
      readKind: 'tool_observation',
      toolName,
      toolCallId: observation.toolCallId,
      toolArguments: observation.toolArguments,
      displayPreview,
      modelContent,
      observationStatus: 'not_executed',
      observationOutcome,
      syntheticObservation: true,
      status: 'failed',
    } satisfies ReadDraft
  })
}

function modelToolCallRequiredRead(error?: RuntimePlanError | null): ReadDraft {
  if (error?.kind === 'missing_api_key') {
    return {
      title: '模型 API key 未配置',
      message: '当前已选择真实模型 provider，但没有可用 API key。请在模型配置里重新填写该 provider 的 API key；如果刚从 qwen 切到 DeepSeek，不要留空沿用旧 key。',
      readKind: 'status',
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_http_error') {
    const authFailed = error.classification === 'auth' || error.statusCode === 401 || error.statusCode === 403
    if (error.classification === 'unsupported_parameter') {
      return {
        title: '模型参数不兼容',
        message: `当前 provider 拒绝了本轮 Chat Completions 参数。系统会按 provider profile 省略不兼容参数；如果仍失败，请检查 model 是否支持 tools/tool_calls。${error.message ? ` Provider 提示：${error.message}` : ''}`,
        readKind: 'status',
        status: 'failed',
      }
    }
    if (error.classification === 'billing' || error.classification === 'rate_limit') {
      return {
        title: error.classification === 'billing' ? '模型服务额度不足' : '模型服务限流',
        message: `模型服务返回 HTTP ${error.statusCode ?? '错误'}。请检查该 provider 的余额、额度或请求频率。${error.message ? ` Provider 提示：${error.message}` : ''}`,
        readKind: 'status',
        status: 'failed',
      }
    }
    if (error.classification === 'context_overflow') {
      return {
        title: '模型上下文超限',
        message: `当前上下文超过了 provider/model 可接受长度。请缩短输入或切换更大上下文模型。${error.message ? ` Provider 提示：${error.message}` : ''}`,
        readKind: 'status',
        status: 'failed',
      }
    }
    return {
      title: authFailed ? '模型服务认证失败' : '模型服务请求失败',
      message: authFailed
        ? `模型服务认证失败：模型服务返回 HTTP ${error.statusCode}，当前保存的 API key 可能不是这个 provider 的 key，或已经失效。请重新保存 DeepSeek/Qwen/Doubao 对应的 API key。${error.message ? ` Provider 提示：${error.message}` : ''}`
        : `模型服务返回 HTTP ${error.statusCode ?? '错误'}。请检查 base URL、model 名称和 provider 配置。${error.message ? ` Provider 提示：${error.message}` : ''}`,
      readKind: 'status',
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_network_error') {
    return {
      title: '无法连接模型服务',
      message: `无法连接当前 provider 的 Chat Completions 接口。请检查 base URL 是否可访问，以及本地代理/网络设置。${error.message ? ` 错误：${error.message}` : ''}`,
      readKind: 'status',
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_timeout') {
    return {
      title: '模型服务响应超时',
      message: `当前 provider 在本轮规划预算内没有完成响应。复杂经营模型会自动使用更长预算并重试；如果仍失败，请稍后重试或检查 provider 负载。${error.message ? ` 错误：${error.message}` : ''}`,
      readKind: 'status',
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_response_error') {
    if (error.toolCallBoundary?.code === 'tool_call_registered_but_deferred') {
      return {
        title: '工具目录正在扩展',
        message: `模型选择了当前已注册但尚未物化的工具，系统会先扩展本轮工具目录再重新规划，不会直接执行未展示工具。${error.toolCallBoundary.toolNames.length ? ` 工具：${error.toolCallBoundary.toolNames.join(', ')}` : ''}${error.message ? ` 错误：${error.message}` : ''}`,
        readKind: 'status',
        status: 'info',
      }
    }
    if (error.toolCallBoundary?.code === 'tool_call_not_in_effective_inventory') {
      return {
        title: '工具调用被运行边界拒绝',
        message: `模型选择了当前有效工具清单之外的工具，系统没有执行该工具，也不会把前置回复当作最终答案。${error.toolCallBoundary.toolNames.length ? ` 工具：${error.toolCallBoundary.toolNames.join(', ')}` : ''}${error.message ? ` 错误：${error.message}` : ''}`,
        readKind: 'status',
        status: 'failed',
      }
    }
    if (error.toolCallBoundary?.code === 'tool_call_without_registered_handler') {
      return {
        title: '工具处理器未注册',
        message: `模型选择了一个没有接入运行图处理器的工具，系统没有执行该工具。${error.toolCallBoundary.toolNames.length ? ` 工具：${error.toolCallBoundary.toolNames.join(', ')}` : ''}${error.message ? ` 错误：${error.message}` : ''}`,
        readKind: 'status',
        status: 'failed',
      }
    }
    if (
      error.toolCallBoundary?.code === 'tool_call_arguments_truncated' ||
      error.toolCallBoundary?.code === 'tool_call_arguments_invalid' ||
      error.toolCallBoundary?.code === 'tool_call_stream_interrupted'
    ) {
      return {
        title: '工具调用未形成可执行参数',
        message: `模型已经选择工具，但 provider 返回的工具调用参数没有形成可执行 observation；系统不会执行不完整参数，也不会把前置文本当作最终答案。${error.toolCallBoundary.toolNames.length ? ` 工具：${error.toolCallBoundary.toolNames.join(', ')}` : ''}${error.message ? ` 错误：${error.message}` : ''}`,
        readKind: 'status',
        status: 'failed',
      }
    }
    return {
      title: '模型响应格式不可用',
      message: `模型服务返回了无法解析的工具调用或流式片段，系统没有生成写入动作。${error.message ? ` 错误：${error.message}` : ''}`,
      readKind: 'status',
      status: 'failed',
    }
  }

  return {
    title: '模型没有返回内容',
    message: '模型这轮没有返回可展示内容，也没有调用工具。系统没有生成任何写入动作；请换一种说法重试。',
    readKind: 'status',
    status: 'info',
  }
}

function providerAssistantTextRead(text: string): ReadDraft {
  const message = redactSecretLikeContent(text).trim().slice(0, 4000)
  return {
    title: '模型回复',
    message: message || '模型这轮没有返回可展示内容。',
    readKind: 'assistant_message',
    status: 'executed',
  }
}

export function readDraftFromRuntimeResult(result?: RuntimePlanResult | null): ReadDraft {
  return readDraftsFromRuntimeResult(result)[0] ?? modelToolCallRequiredRead(result?.error)
}

export function readDraftsFromRuntimeResult(result?: RuntimePlanResult | null): ReadDraft[] {
  if (result?.assistantText) {
    return [providerAssistantTextRead(result.assistantText)]
  }

  const boundaryObservations = providerToolCallBoundaryObservationReads(result?.error)
  if (boundaryObservations) return boundaryObservations

  return [modelToolCallRequiredRead(result?.error)]
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
