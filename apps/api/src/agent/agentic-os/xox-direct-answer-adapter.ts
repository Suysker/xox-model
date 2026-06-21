import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  agentAmbientSessionContextFacts,
  buildAgentAmbientSessionContext,
  runDirectAnswerLane,
  type AgentAmbientSessionContext,
  type DirectAnswerLaneFailure,
  type DirectAnswerLaneModelOutput,
} from '@agentic-os/core'
import type { AgentTurnLaneResolution } from '@agentic-os/contracts'
import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../../db/schema.js'
import type { PlannerContext } from '../planning-context.js'
import {
  configuredRuntimePlannerSource,
  planWithRuntimeAdapter,
  type RuntimeChatMessage,
  type RuntimePlanError,
  type RuntimePlanResult,
} from './xox-runtime-adapter.js'
import { redactSecretLikeContent } from '../memory.js'
import { addRunEvent, addRuntimeStreamRunEvent } from './xox-run-event-store-adapter.js'
import { addMessage } from './xox-thread-store-adapter.js'
import { storePlannedActionGraph } from './xox-action-graph-adapter.js'
import { readDraftFromRuntimeResult } from '../action-draft-builder.js'

export type DirectAnswerRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus
}

type XoxDirectAnswerModelOutput = DirectAnswerLaneModelOutput<RuntimePlanError> & {
  result: RuntimePlanResult | null
}

const DIRECT_ANSWER_SYSTEM_PROMPT = readFileSync(
  fileURLToPath(new URL('../prompts/direct-answer.system.md', import.meta.url)),
  'utf8',
).trim()

function directAnswerSystemPrompt() {
  return DIRECT_ANSWER_SYSTEM_PROMPT
}

function compactJson(value: unknown) {
  return JSON.stringify(value)
}

function directAnswerMessages(input: {
  message: string
  ambientContext: AgentAmbientSessionContext
}): RuntimeChatMessage[] {
  return [
    { role: 'system', content: directAnswerSystemPrompt() },
    {
      role: 'user',
      content: [
        'Ambient session context. This is authoritative for current date, time and timezone only.',
        compactJson(agentAmbientSessionContextFacts(input.ambientContext)),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `User message:\n${redactSecretLikeContent(input.message)}`,
    },
  ]
}

function failureEventMessage(failure: DirectAnswerLaneFailure<RuntimePlanError>) {
  if (failure.code === 'provider_error') {
    return failure.error?.message ?? failure.error?.kind ?? failure.reason
  }
  if (failure.code === 'tool_calls_returned') {
    return '模型返回了工具调用，direct_answer 路径只接受 assistant 文本。'
  }
  return '模型没有返回可用的 assistant 文本，direct_answer 不使用本地语义替代路径。'
}

function failureStatus(failure: DirectAnswerLaneFailure<RuntimePlanError>) {
  return failure.code === 'provider_error' ? 'info' : 'failed'
}

function failureRuntimeResult(
  failure: DirectAnswerLaneFailure<RuntimePlanError, XoxDirectAnswerModelOutput>,
  source: Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>,
): RuntimePlanResult {
  if (failure.code === 'provider_error' && failure.modelOutput?.result) {
    return failure.modelOutput.result
  }
  return {
    source,
    steps: [],
    error: {
      kind: 'provider_response_error',
      message: failure.reason,
    },
  }
}

export async function executeXoxDirectAnswerLane(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  input: {
    resolution: AgentTurnLaneResolution
    beforeStateWrite: () => Promise<boolean>
  },
): Promise<DirectAnswerRunResult | null> {
  const ambientContext = buildAgentAmbientSessionContext({
    ...(process.env.XOX_AGENT_TIMEZONE ? { timezone: process.env.XOX_AGENT_TIMEZONE } : {}),
    userDisplayName: ctx.user.display_name ?? ctx.user.email ?? null,
    workspaceName: ctx.workspace.name ?? null,
  })
  let plannerSource: AgentPlannerSource = configuredRuntimePlannerSource(ctx.settings) ?? 'rules'

  const result = await runDirectAnswerLane<RuntimePlanError, XoxDirectAnswerModelOutput, DirectAnswerRunResult, DirectAnswerRunResult>({
    resolution: input.resolution,
    onLaneStarted: async () => {
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
    },
    runModel: async () => {
      if (ctx.settings.llmProvider === 'rules') {
        return null
      }
      const runtimeResult = await planWithRuntimeAdapter({
        settings: ctx.settings,
        message: redactSecretLikeContent(ctx.message),
        context: { ambient: agentAmbientSessionContextFacts(ambientContext) },
        tools: [],
        messages: directAnswerMessages({ message: ctx.message, ambientContext }),
        systemPrompt: directAnswerSystemPrompt(),
        maxTokens: 500,
        thinkingLevel: 'off',
        requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        onStreamEvent: (event) => addRuntimeStreamRunEvent({ ...ctx, phase: 'final_answer' }, event),
      })
      plannerSource = runtimeResult?.source ?? plannerSource
      return {
        result: runtimeResult,
        assistantText: runtimeResult?.assistantText ?? null,
        toolCallCount: runtimeResult?.steps.length ?? 0,
        error: runtimeResult?.error ?? null,
      }
    },
    beforeStateWrite: input.beforeStateWrite,
    errorMessage: (error) => error.message ?? error.kind,
    onFailureDetected: async (failure) => {
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        channel: 'lifecycle',
        type: 'direct_answer_provider_failed',
        title: '直接回答模型调用未完成',
        message: failureEventMessage(failure),
        status: failureStatus(failure),
        data: {
          lane: input.resolution.lane,
          reasonCode: input.resolution.reasonCode,
          ...(failure.error ? { error: failure.error } : {}),
        },
      })
    },
    persistSuccess: async (success) => {
      const assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', success.assistantText)
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        channel: 'assistant',
        type: 'assistant_final_message',
        title: '模型回复已完成',
        message: success.assistantText,
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
    },
    persistFailure: async (failure) => {
      const source = configuredRuntimePlannerSource(ctx.settings) ?? 'openai_compatible_tool_calls'
      const stored = await storePlannedActionGraph(ctx, {
        items: [readDraftFromRuntimeResult(failureRuntimeResult(failure, source))],
        plannerSource: failure.code === 'provider_error' ? plannerSource : source,
      })
      await ctx.db
        .updateTable('agent_runs')
        .set({ goal_status: 'failed' })
        .where('id', '=', ctx.runId)
        .execute()
      return {
        plannerSource: failure.code === 'provider_error' ? plannerSource : source,
        assistantMessage: null,
        navigationEvents: stored.navigationEvents,
        actionRows: stored.actionRows,
        planRows: stored.planRows,
        goalStatus: 'failed',
      }
    },
  })

  return result.status === 'cancelled_before_state_write' ? null : result.value
}
