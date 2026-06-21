import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AGENT_TURN_LANE_RESOLUTION_TOOL_NAME,
  AGENT_TURN_LANE_RESOLUTION_TOOL_SCHEMA,
  agentAmbientSessionContextFacts,
  buildAgentAmbientSessionContext,
  normalizeAgentTurnLaneResolution,
  resolveAgentTurnIntake,
  type AgentTurnIntakeModelResult,
} from '@agentic-os/core'
import type { Row } from '../../db/schema.js'
import type { PlannerContext } from '../planning-context.js'
import { redactSecretLikeContent } from '../memory.js'
import { planWithRuntimeAdapter } from '../runtime/runtime-adapter.js'
import { sanitizeAgentGoalFacts } from '../runtime-goal-facts.js'
import type { AgentToolCallStep, ChatTool } from '../tool-catalog.js'

const TURN_LANE_SYSTEM_PROMPT = readFileSync(
  fileURLToPath(new URL('../prompts/turn-lane.system.md', import.meta.url)),
  'utf8',
).trim()

function turnLaneSystemPrompt() {
  return TURN_LANE_SYSTEM_PROMPT
}

const TURN_LANE_RESOLUTION_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: AGENT_TURN_LANE_RESOLUTION_TOOL_NAME,
    description: 'Resolve the current user turn into the direct_answer lane or the full Agent goal lane.',
    parameters: AGENT_TURN_LANE_RESOLUTION_TOOL_SCHEMA as unknown as ChatTool['function']['parameters'],
  },
}

async function hasPendingAction(ctx: PlannerContext & { thread: Row<'agent_threads'> }) {
  const pending = await ctx.db
    .selectFrom('agent_action_requests')
    .select('id')
    .where('thread_id', '=', ctx.thread.id)
    .where('workspace_id', '=', ctx.workspace.id)
    .where('user_id', '=', ctx.user.id)
    .where('status', '=', 'pending')
    .limit(1)
    .executeTakeFirst()
  return Boolean(pending)
}

async function hasPendingClarification(ctx: PlannerContext & { thread: Row<'agent_threads'> }) {
  const pending = await ctx.db
    .selectFrom('agent_goals')
    .select('id')
    .where('thread_id', '=', ctx.thread.id)
    .where('status', '=', 'needs_clarification')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return Boolean(pending)
}

function turnLaneResolutionFromStep(step: AgentToolCallStep | undefined) {
  if (!step || step.intent !== 'turn_lane.resolve') return null
  return normalizeAgentTurnLaneResolution(step, {
    sanitizeGoalFacts: (value) => sanitizeAgentGoalFacts(value),
    redactReason: (value) => redactSecretLikeContent(value),
  })
}

async function resolveTurnLaneWithModel(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
): Promise<AgentTurnIntakeModelResult> {
  const ambient = buildAgentAmbientSessionContext({
    ...(process.env.XOX_AGENT_TIMEZONE ? { timezone: process.env.XOX_AGENT_TIMEZONE } : {}),
    userDisplayName: ctx.user.display_name ?? ctx.user.email ?? null,
    workspaceName: ctx.workspace.name ?? null,
  })
  const result = await planWithRuntimeAdapter({
    settings: ctx.settings,
    systemPrompt: turnLaneSystemPrompt(),
    message: redactSecretLikeContent(ctx.message),
    context: { ambient: agentAmbientSessionContextFacts(ambient) },
    tools: [TURN_LANE_RESOLUTION_TOOL],
    stream: false,
    thinkingLevel: 'off',
    maxTokens: 250,
    requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })

  if (result?.error) {
    return { status: 'provider_unavailable', reason: result.error.message ?? result.error.kind }
  }

  return {
    status: 'resolved',
    resolution: turnLaneResolutionFromStep(result?.steps.find((step) => step.intent === 'turn_lane.resolve')),
  }
}

export async function resolveXoxAgentTurnIntake(ctx: PlannerContext & { thread: Row<'agent_threads'> }) {
  return resolveAgentTurnIntake({
    hasPendingAction: () => hasPendingAction(ctx),
    hasPendingClarification: () => hasPendingClarification(ctx),
    ...(ctx.settings.llmProvider === 'rules'
      ? { providerUnavailableReason: 'The local rules provider does not own semantic lane resolution.' }
      : { resolveWithModel: () => resolveTurnLaneWithModel(ctx) }),
  })
}
