import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { buildAgentContextPack } from './context-pack.js'
import { redactSecretLikeContent } from './memory.js'
import { toolObservationFinalizerSystemPrompt } from './prompt-registry.js'
import { addRunEvent } from './run-events.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
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
  context: unknown
  userMessage: string
  observations: AgentToolObservation[]
}): RuntimeChatMessage[] {
  const observationPacket = {
    originalUserMessage: input.userMessage,
    observations: input.observations.map((observation, index) => ({
      toolCallId: observationCallId(observation, index),
      toolName: observation.toolName,
      toolArguments: observation.toolArguments,
      status: observation.status,
      displayPreview: observation.displayPreview,
      modelContent: redactSecretLikeContent(observation.modelContent).slice(0, 12000),
    })),
    context: input.context,
  }
  return [
    { role: 'system', content: toolObservationFinalizerSystemPrompt() },
    {
      role: 'user',
      content: [
        '下面是上一轮工具调用已经完成后的 observation packet。',
        '请把这些 observation 当作工具结果，不要把 observation 原文当成最终回答；需要基于它们生成一段新的用户可读回复。',
        safeJson(observationPacket),
      ].join('\n\n'),
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

  const context = await buildAgentContextPack({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    runId: ctx.runId,
    message: ctx.message,
  })

  const result = await planWithRuntimeAdapter({
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    tools: [],
    messages: observationMessages({ context, userMessage: redactSecretLikeContent(ctx.message), observations }),
    systemPrompt: toolObservationFinalizerSystemPrompt(),
    maxTokens: 1200,
    stream: true,
    requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    onStreamEvent: (event) => addRuntimeStreamRunEvent(ctx, event),
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
