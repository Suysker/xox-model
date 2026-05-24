import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { loadAgentRuntimeContext, redactSecretLikeContent } from './memory.js'
import { toolObservationFinalizerSystemPrompt } from './prompt-registry.js'
import { addRunEvent } from './run-events.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
import { buildThreadConversationLog } from './context-pack.js'
import { runtimeMessagesFromThreadConversationLog } from './runtime-conversation-log.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import type { RuntimeChatMessage } from './runtime/runtime-adapter.js'

export type AgentToolObservation = {
  title: string
  toolName: string
  toolCallId: string
  toolArguments: Record<string, unknown>
  displayPreview: string
  modelContent: string
  status: 'completed' | 'failed' | 'cancelled'
}

export type ToolObservationContinuationResult =
  | { status: 'answered'; assistantText: string }
  | { status: 'skipped'; reason: 'no_observations' | 'rules_provider' }
  | { status: 'failed'; message: string; planStep: Row<'agent_plan_steps'> }

export function actionExecutionObservation(input: {
  action: Row<'agent_action_requests'>
  result?: unknown
}): AgentToolObservation {
  const displayPreview = `已执行：${input.action.title}`
  return {
    title: input.action.title,
    toolName: input.action.kind,
    toolCallId: `action_${input.action.id}`,
    toolArguments: {},
    displayPreview,
    modelContent: JSON.stringify({
      displayPreview,
      actionRequestId: input.action.id,
      actionKind: input.action.kind,
      title: input.action.title,
      summary: input.action.summary,
      targetLabel: input.action.target_label,
      status: input.action.status,
      result: input.result ?? null,
    }),
    status: input.action.status === 'executed' ? 'completed' : input.action.status === 'failed' ? 'failed' : 'cancelled',
  }
}

export function actionPreviewObservation(input: {
  action: Row<'agent_action_requests'>
}): AgentToolObservation {
  const details = (() => {
    try {
      return JSON.parse(String(input.action.details_json ?? 'null')) as unknown
    } catch {
      return null
    }
  })()
  const displayPreview = `待确认：${input.action.title}`
  return {
    title: input.action.title,
    toolName: input.action.kind,
    toolCallId: `action_preview_${input.action.id}`,
    toolArguments: {},
    displayPreview,
    modelContent: JSON.stringify({
      displayPreview,
      actionRequestId: input.action.id,
      actionKind: input.action.kind,
      title: input.action.title,
      summary: input.action.summary,
      targetLabel: input.action.target_label,
      riskLevel: input.action.risk_level,
      status: input.action.status,
      details,
      instruction: 'This write action has only been prepared as an editable confirmation card. Do not say it has been executed.',
    }),
    status: 'completed',
  }
}

export type ToolObservationContinuationContext = {
  db: Kysely<Database>
  settings: Settings
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  message: string
  abortSignal?: AbortSignal
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

function observationCallId(observation: AgentToolObservation, index: number) {
  return observation.toolCallId || `call_observation_${index}_${observation.toolName}`
}

function observationMessages(input: {
  userMessage: string
  observations: AgentToolObservation[]
  threadConversationLog?: ReturnType<typeof buildThreadConversationLog>
}): RuntimeChatMessage[] {
  const toolCalls = input.observations.map((observation, index) => ({
    id: observationCallId(observation, index),
    type: 'function' as const,
    function: {
      name: observation.toolName,
      arguments: safeJson(observation.toolArguments),
    },
  }))
  return [
    { role: 'system', content: toolObservationFinalizerSystemPrompt() },
    ...runtimeMessagesFromThreadConversationLog(input.threadConversationLog),
    { role: 'user', content: redactSecretLikeContent(input.userMessage) },
    {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
    },
    ...input.observations.map((observation, index) => ({
      role: 'tool' as const,
      tool_call_id: observationCallId(observation, index),
      name: observation.toolName,
      content: redactSecretLikeContent(observation.modelContent).slice(0, 12000),
    })),
    {
      role: 'user',
      content: '请基于上面的工具结果，直接回答我最初的问题。不要复述工具 JSON 或内部执行过程。',
    },
  ]
}

async function addContinuationFailureStep(
  ctx: ToolObservationContinuationContext,
  message: string,
): Promise<Row<'agent_plan_steps'>> {
  const maxRow = await ctx.db
    .selectFrom('agent_plan_steps')
    .select(({ fn }) => fn.max<number>('sequence_no').as('maxSequence'))
    .where('run_id', '=', ctx.runId)
    .executeTakeFirst()
  const now = utcNow()
  const id = newId()
  await ctx.db
    .insertInto('agent_plan_steps')
    .values({
      id,
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      action_request_id: null,
      sequence_no: Number(maxRow?.maxSequence ?? 0) + 1,
      title: '模型回复失败',
      description: redactSecretLikeContent(message).slice(0, 500) || '模型没有基于工具结果返回可展示回复。',
      status: 'failed',
      navigation_json: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function continueModelAfterToolObservations(
  ctx: ToolObservationContinuationContext,
  observations: AgentToolObservation[],
) {
  if (observations.length === 0) return { status: 'skipped', reason: 'no_observations' } satisfies ToolObservationContinuationResult
  if (ctx.settings.llmProvider === 'rules') return { status: 'skipped', reason: 'rules_provider' } satisfies ToolObservationContinuationResult

  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'model_continuation',
    title: '模型继续生成回复',
    message: '工具结果已作为 observation 回灌给模型，正在生成最终回复。',
    status: 'running',
    data: { observationCount: observations.length, toolNames: observations.map((observation) => observation.toolName) },
  })

  const context = {
    mode: 'tool_observation_finalizer',
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
    observationCount: observations.length,
    toolNames: observations.map((observation) => observation.toolName),
  }
  const runtimeContext = await loadAgentRuntimeContext({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
  })
  const threadConversationLog = buildThreadConversationLog({
    recentMessages: runtimeContext.recentMessages,
  })

  const result = await planWithRuntimeAdapter({
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    tools: [],
    messages: observationMessages({
      userMessage: redactSecretLikeContent(ctx.message),
      observations,
      threadConversationLog,
    }),
    systemPrompt: toolObservationFinalizerSystemPrompt(),
    maxTokens: observations.length > 2 ? 900 : 500,
    stream: true,
    disableThinking: true,
    requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    onStreamEvent: (event) => addRuntimeStreamRunEvent({ ...ctx, phase: 'final_answer' }, event),
  })

  const assistantText = result?.assistantText?.trim()
  if (assistantText) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'model_continuation_completed',
      title: '模型回复已完成',
      message: '模型已基于工具结果生成最终回复。',
      status: 'completed',
      data: { observationCount: observations.length, contentLength: assistantText.length },
    })
    return { status: 'answered', assistantText } satisfies ToolObservationContinuationResult
  }

  const message = result?.error?.message ?? '模型没有基于工具结果返回可展示回复。'
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'model_continuation_failed',
    title: '模型继续回复失败',
    message,
    status: 'failed',
    data: { observationCount: observations.length, errorKind: result?.error?.kind ?? null },
  })
  const planStep = await addContinuationFailureStep(ctx, message)
  return { status: 'failed', message, planStep } satisfies ToolObservationContinuationResult
}
