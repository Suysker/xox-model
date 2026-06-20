import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource, AgentTurnLaneResolution } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { buildAgentAmbientContext } from './ambient-context.js'
import { directAnswerSystemPrompt } from './prompt-registry.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
import { planWithRuntimeAdapter, type RuntimeChatMessage, type RuntimePlanResult } from './runtime/runtime-adapter.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'
import { addMessage } from './thread-store.js'
import { storePlannedActionGraph } from './action-graph-store.js'
import { configuredRuntimePlannerSource, readDraftFromRuntimeResult } from './runtime-plan-reader.js'

export type DirectAnswerRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus
}

function compactJson(value: unknown) {
  return JSON.stringify(value)
}

function directAnswerMessages(input: {
  message: string
  ambientContext: ReturnType<typeof buildAgentAmbientContext>
}): RuntimeChatMessage[] {
  return [
    { role: 'system', content: directAnswerSystemPrompt() },
    {
      role: 'user',
      content: [
        'Ambient session context. This is authoritative for current date, time and timezone only.',
        compactJson({
          authority: 'ambient',
          source: 'agent_ambient_context',
          nowIso: input.ambientContext.nowIso,
          localDate: input.ambientContext.localDate,
          timezone: input.ambientContext.timezone,
          userDisplayName: input.ambientContext.userDisplayName ?? null,
          workspaceName: input.ambientContext.workspaceName ?? null,
        }),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `User message:\n${redactSecretLikeContent(input.message)}`,
    },
  ]
}

function usableAssistantText(result: RuntimePlanResult | null) {
  const text = result?.assistantText?.trim()
  return text && result?.steps.length === 0 ? text : null
}

export async function executeDirectAnswerRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  input: {
    resolution: AgentTurnLaneResolution
    beforeStateWrite: () => Promise<boolean>
  },
): Promise<DirectAnswerRunResult | null> {
  const ambientContext = buildAgentAmbientContext({
    user: ctx.user,
    workspace: ctx.workspace,
  })
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    channel: 'lifecycle',
    type: 'turn_intake_resolved',
    title: '对话入口已识别',
    message: '本轮可以通过轻量 direct_answer 路径回答，不进入 Agent goal harness。',
    status: 'info',
    data: {
      lane: input.resolution.lane,
      reason: input.resolution.reason,
      reasonCode: input.resolution.reasonCode,
      ambientAuthority: 'ambient',
    },
  })

  let plannerSource: AgentPlannerSource = configuredRuntimePlannerSource(ctx.settings) ?? 'rules'
  let assistantText: string | null = null
  if (ctx.settings.llmProvider !== 'rules') {
    const result = await planWithRuntimeAdapter({
      settings: ctx.settings,
      message: redactSecretLikeContent(ctx.message),
      context: { ambient: ambientContext },
      tools: [],
      messages: directAnswerMessages({ message: ctx.message, ambientContext }),
      maxTokens: 500,
      thinkingLevel: 'off',
      requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      onStreamEvent: (event) => addRuntimeStreamRunEvent({ ...ctx, phase: 'final_answer' }, event),
    })
    plannerSource = result?.source ?? plannerSource
    assistantText = usableAssistantText(result)
    if (result?.error) {
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        channel: 'lifecycle',
        type: 'direct_answer_provider_failed',
        title: '直接回答模型调用未完成',
        message: result.error.message ?? result.error.kind,
        status: 'info',
        data: { error: result.error },
      })
      if (!(await input.beforeStateWrite())) return null
      const stored = await storePlannedActionGraph(ctx, {
        items: [readDraftFromRuntimeResult(result)],
        plannerSource,
      })
      await ctx.db
        .updateTable('agent_runs')
        .set({ goal_status: 'failed' })
        .where('id', '=', ctx.runId)
        .execute()
      return {
        plannerSource,
        assistantMessage: null,
        navigationEvents: stored.navigationEvents,
        actionRows: stored.actionRows,
        planRows: stored.planRows,
        goalStatus: 'failed',
      }
    }
  }

  if (!assistantText) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      channel: 'lifecycle',
      type: 'direct_answer_provider_failed',
      title: '直接回答模型调用未完成',
      message: '模型没有返回可用的 assistant 文本，direct_answer 不使用本地语义替代路径。',
      status: 'failed',
      data: {
        lane: input.resolution.lane,
        reasonCode: input.resolution.reasonCode,
      },
    })
    if (!(await input.beforeStateWrite())) return null
    const source = configuredRuntimePlannerSource(ctx.settings) ?? 'openai_compatible_tool_calls'
    const stored = await storePlannedActionGraph(ctx, {
      items: [readDraftFromRuntimeResult({
        source,
        steps: [],
        error: {
          kind: 'provider_response_error',
          message: 'Direct answer provider did not return assistant text.',
        },
      })],
      plannerSource: source,
    })
    await ctx.db
      .updateTable('agent_runs')
      .set({ goal_status: 'failed' })
      .where('id', '=', ctx.runId)
      .execute()
    return {
      plannerSource: source,
      assistantMessage: null,
      navigationEvents: stored.navigationEvents,
      actionRows: stored.actionRows,
      planRows: stored.planRows,
      goalStatus: 'failed',
    }
  }

  if (!(await input.beforeStateWrite())) return null
  const assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', assistantText)
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    channel: 'assistant',
    type: 'assistant_final_message',
    title: '模型回复已完成',
    message: assistantText,
    status: 'completed',
    data: {
      phase: 'final_answer',
      messageId: assistantMessage.id,
      lane: 'direct_answer',
      ambientAuthority: 'ambient',
    },
  })
  await ctx.db
    .updateTable('agent_runs')
    .set({ goal_status: 'completed' })
    .where('id', '=', ctx.runId)
    .execute()

  return {
    plannerSource,
    assistantMessage,
    navigationEvents: [],
    actionRows: [],
    planRows: [],
    goalStatus: 'completed',
  }
}
