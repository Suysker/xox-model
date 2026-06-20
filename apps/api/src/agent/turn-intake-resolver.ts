import type { Kysely } from 'kysely'
import type { AgentTurnLane, AgentTurnLaneReasonCode, AgentTurnLaneResolution } from '@xox/contracts'
import type { Settings } from '../core/settings.js'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { buildAgentAmbientContext } from './ambient-context.js'
import { redactSecretLikeContent } from './memory.js'
import { turnLaneSystemPrompt } from './prompt-registry.js'
import { planWithRuntimeAdapter } from './runtime/runtime-adapter.js'
import type { ChatTool, AgentToolCallStep } from './tool-catalog.js'
import { sanitizeAgentGoalFacts } from './runtime-goal-facts.js'

const TURN_LANE_RESOLUTION_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'turn_lane_resolve',
    description: 'Resolve the current user turn into the direct_answer lane or the full Agent goal lane.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['lane', 'requiresTools', 'reasonCode', 'confidence', 'missingContext'],
      properties: {
        lane: {
          type: 'string',
          enum: ['direct_answer', 'agent_goal'],
          description: 'direct_answer only for ordinary conversation or ambient session facts; agent_goal for workspace reads, tools, writes, confirmations, memory, navigation, sandbox or multi-step goals.',
        },
        requiresTools: {
          type: 'boolean',
          description: 'True when the request needs business tools, workspace reads, memory, navigation, sandbox, confirmation cards or writes.',
        },
        reasonCode: {
          type: 'string',
          enum: [
            'ordinary_conversation',
            'ambient_session_fact',
            'requires_workspace_tools',
            'requires_write_or_confirmation',
            'pending_action',
            'pending_clarification',
            'uncertain',
            'provider_unavailable',
          ],
          description: 'Stable reason category. Use uncertain when the lane is not obvious.',
        },
        confidence: {
          type: 'number',
          description: 'Confidence from 0 to 1.',
        },
        missingContext: {
          type: 'array',
          description: 'Context missing for lane resolution, not business execution. Usually empty.',
          items: { type: 'string' },
        },
        reason: {
          type: 'string',
          description: 'Short non-sensitive rationale.',
        },
        goalFacts: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional hard business facts extracted from the current objective for runner-side verification. Only include facts stated by the user or unambiguously implied by a pending clarification.',
          properties: {
            workspaceName: { type: 'string' },
            expectedMemberCount: { type: 'number' },
            expectedShareholderCount: { type: 'number' },
            expectedHorizonMonths: { type: 'number' },
            expectedStartMonth: { type: 'number' },
            requiresForecastSummary: { type: 'boolean' },
            requiresSandboxComputation: { type: 'boolean' },
            requiresOrderedEntityFacts: { type: 'boolean' },
            requiredActionCapabilities: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['draft', 'import_export', 'ledger', 'share', 'version'],
              },
            },
            forbiddenActions: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['publish_release', 'share_link', 'account_action'],
              },
            },
          },
        },
      },
    },
  },
}

function forcedResolution(lane: AgentTurnLane, reasonCode: AgentTurnLaneReasonCode, reason: string): AgentTurnLaneResolution {
  return {
    lane,
    requiresTools: lane === 'agent_goal',
    reasonCode,
    confidence: 1,
    missingContext: [],
    reason,
  }
}

function isTurnLane(value: unknown): value is AgentTurnLane {
  return value === 'direct_answer' || value === 'agent_goal'
}

function isReasonCode(value: unknown): value is AgentTurnLaneReasonCode {
  return value === 'ordinary_conversation' ||
    value === 'ambient_session_fact' ||
    value === 'requires_workspace_tools' ||
    value === 'requires_write_or_confirmation' ||
    value === 'pending_action' ||
    value === 'pending_clarification' ||
    value === 'uncertain' ||
    value === 'provider_unavailable'
}

function safeConfidence(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

function safeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function resolutionFromStep(step: AgentToolCallStep | undefined): AgentTurnLaneResolution | null {
  if (!step || step.intent !== 'turn_lane.resolve') return null
  if (!isTurnLane(step.lane)) return null
  return {
    lane: step.lane,
    requiresTools: typeof step.requiresTools === 'boolean' ? step.requiresTools : step.lane === 'agent_goal',
    reasonCode: isReasonCode(step.reasonCode) ? step.reasonCode : 'uncertain',
    confidence: safeConfidence(step.confidence),
    missingContext: safeStringArray(step.missingContext),
    goalFacts: sanitizeAgentGoalFacts(step.goalFacts),
    ...(typeof step.reason === 'string' ? { reason: redactSecretLikeContent(step.reason).slice(0, 300) } : {}),
  }
}

async function hasPendingAction(input: {
  db: Kysely<Database>
  thread: Row<'agent_threads'>
  workspace: Row<'workspaces'>
  user: CurrentUser
}) {
  const pending = await input.db
    .selectFrom('agent_action_requests')
    .select('id')
    .where('thread_id', '=', input.thread.id)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('status', '=', 'pending')
    .limit(1)
    .executeTakeFirst()
  return Boolean(pending)
}

async function hasPendingClarification(input: {
  db: Kysely<Database>
  thread: Row<'agent_threads'>
}) {
  const pending = await input.db
    .selectFrom('agent_goals')
    .select('id')
    .where('thread_id', '=', input.thread.id)
    .where('status', '=', 'needs_clarification')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return Boolean(pending)
}

export async function resolveTurnIntake(input: {
  db: Kysely<Database>
  settings: Settings
  workspace: Row<'workspaces'>
  user: CurrentUser
  thread: Row<'agent_threads'>
  message: string
  abortSignal?: AbortSignal
}): Promise<AgentTurnLaneResolution> {
  if (await hasPendingAction(input)) {
    return forcedResolution('agent_goal', 'pending_action', 'A pending action exists for this thread.')
  }
  if (await hasPendingClarification(input)) {
    return forcedResolution('agent_goal', 'pending_clarification', 'A pending clarification exists for this thread.')
  }
  if (input.settings.llmProvider === 'rules') {
    return forcedResolution('agent_goal', 'provider_unavailable', 'The local rules provider does not own semantic lane resolution.')
  }

  const ambient = buildAgentAmbientContext({ user: input.user, workspace: input.workspace })
  const result = await planWithRuntimeAdapter({
    settings: input.settings,
    systemPrompt: turnLaneSystemPrompt(),
    message: redactSecretLikeContent(input.message),
    context: {
      ambient: {
        nowIso: ambient.nowIso,
        localDate: ambient.localDate,
        timezone: ambient.timezone,
        userDisplayName: ambient.userDisplayName ?? null,
        workspaceName: ambient.workspaceName ?? null,
      },
    },
    tools: [TURN_LANE_RESOLUTION_TOOL],
    stream: false,
    thinkingLevel: 'off',
    maxTokens: 250,
    requestTimeoutMs: input.settings.agentProviderRequestTimeoutMs,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  })

  if (result?.error) {
    return forcedResolution('agent_goal', 'provider_unavailable', result.error.message ?? result.error.kind)
  }

  return resolutionFromStep(result?.steps.find((step) => step.intent === 'turn_lane.resolve')) ??
    forcedResolution('agent_goal', 'uncertain', 'The model did not return a lane contract.')
}
