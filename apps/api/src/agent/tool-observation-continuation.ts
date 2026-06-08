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
import { providerToolObservationReplayMessages } from './runtime/provider-transcript-replay.js'
import type { AgentToolObservationOutcome } from '@xox/contracts'

export type AgentToolObservation = {
  title: string
  toolName: string
  toolCallId: string
  toolArguments: Record<string, unknown>
  displayPreview: string
  modelContent: string
  status: 'completed' | 'failed' | 'cancelled' | 'not_executed' | 'invalid'
  outcome?: AgentToolObservationOutcome
  synthetic?: boolean
}

export type ToolObservationContinuationResult =
  | { status: 'answered'; assistantText: string }
  | { status: 'skipped'; reason: 'no_observations' | 'rules_provider' }
  | { status: 'failed'; message: string; planStep: Row<'agent_plan_steps'> }

function parseJsonObject(value: string | null) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function conciseResult(value: unknown) {
  if (!value || typeof value !== 'object') return value ?? null
  const record = value as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const key of [
    'ok',
    'id',
    'revision',
    'workspaceName',
    'direction',
    'amount',
    'occurredAt',
    'relatedEntityName',
    'relatedEntityId',
    'status',
    'monthLabel',
  ]) {
    if (record[key] !== undefined) summary[key] = record[key]
  }
  if (record.version && typeof record.version === 'object') {
    const version = record.version as Record<string, unknown>
    summary.version = {
      id: version.id,
      versionNo: version.versionNo ?? version.version_no,
      name: version.name,
      kind: version.kind,
    }
  }
  if (record.share && typeof record.share === 'object') {
    summary.share = { ok: true }
  }
  return Object.keys(summary).length > 0 ? summary : { ok: true }
}

export function actionExecutionObservation(input: {
  action: Row<'agent_action_requests'>
  result?: unknown
}): AgentToolObservation {
  const displayPreview = `已执行：${input.action.title}`
  const details = parseJsonObject(input.action.details_json)
  return {
    title: input.action.title,
    toolName: input.action.kind,
    toolCallId: `action_${input.action.id}`,
    toolArguments: {
      actionRequestId: input.action.id,
      actionKind: input.action.kind,
      status: input.action.status,
    },
    displayPreview,
    modelContent: JSON.stringify({
      observationType: 'action_result',
      displayPreview,
      actionRequestId: input.action.id,
      actionKind: input.action.kind,
      title: input.action.title,
      summary: input.action.summary,
      targetLabel: input.action.target_label,
      riskLevel: input.action.risk_level,
      executionState: input.action.status,
      completed: input.action.status === 'executed',
      status: input.action.status,
      executedAt: input.action.executed_at,
      changeSet: details,
      result: conciseResult(input.result),
    }),
    status: input.action.status === 'executed' ? 'completed' : input.action.status === 'failed' ? 'failed' : 'cancelled',
    outcome: input.action.status === 'executed' ? 'completed_valid' : input.action.status === 'failed' ? 'failed_terminal' : 'pending_human',
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
      observationType: 'action_preview',
      displayPreview,
      actionRequestId: input.action.id,
      actionKind: input.action.kind,
      title: input.action.title,
      summary: input.action.summary,
      targetLabel: input.action.target_label,
      riskLevel: input.action.risk_level,
      executionState: 'pending_confirmation',
      completed: false,
      editable: true,
      status: input.action.status,
      changeSet: details,
    }),
    status: 'completed',
    outcome: 'pending_human',
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

function observationMessages(input: {
  settings: Settings
  userMessage: string
  observations: AgentToolObservation[]
  threadConversationLog?: ReturnType<typeof buildThreadConversationLog>
}): RuntimeChatMessage[] {
  return [
    { role: 'system', content: toolObservationFinalizerSystemPrompt() },
    ...runtimeMessagesFromThreadConversationLog(input.threadConversationLog),
    { role: 'user', content: redactSecretLikeContent(input.userMessage) },
    ...providerToolObservationReplayMessages({
      settings: input.settings,
      observations: input.observations,
      suffix: 'finalizer_observation',
    }),
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
      settings: ctx.settings,
      userMessage: redactSecretLikeContent(ctx.message),
      observations,
      threadConversationLog,
    }),
    systemPrompt: toolObservationFinalizerSystemPrompt(),
    maxTokens: observations.length > 2 ? 900 : 500,
    stream: true,
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
