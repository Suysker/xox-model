import type { Kysely } from 'kysely'
import type {
  AgentActionRequest,
  AgentEvaluationResult,
  AgentGoalRecord,
  AgentMessage,
  AgentNavigationEvent,
  AgentPlannerSource,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentRunRecord,
  AgentThreadState,
  AgentThreadSummary,
} from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { coerceAgentActionKind, normalizeAgentAutomationLevel } from './tool-policy.js'
import { serializeRunEvent } from './run-events.js'
import { normalizeGoalStatus, serializeEvaluation, serializeGoal } from './goal-contract.js'
import { buildXoxThreadStateView } from './agentic-os/xox-thread-state-view.js'

export type AgentThreadUser = {
  id: string
}

export function serializeAction(row: Row<'agent_action_requests'>): AgentActionRequest {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: coerceAgentActionKind(row.kind),
    status: row.status as AgentActionRequest['status'],
    title: row.title,
    summary: row.summary,
    targetLabel: row.target_label,
    riskLevel: row.risk_level as AgentActionRequest['riskLevel'],
    details: parseJson<Array<{ label: string; value: string }>>(row.details_json, []),
    navigation: parseJson<AgentNavigationEvent>(row.navigation_json, {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      reason: '默认打开经营总览。',
    }),
    payload: parseJson<unknown>(row.payload_json, null),
    createdAt: row.created_at,
    executedAt: row.executed_at,
    errorMessage: row.error_message,
  }
}

export function serializePlanStep(row: Row<'agent_plan_steps'>): AgentPlanStep {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    actionRequestId: row.action_request_id,
    sequence: row.sequence_no,
    title: row.title,
    description: row.description,
    status: row.status as AgentPlanStepStatus,
    navigation: row.navigation_json ? parseJson<AgentNavigationEvent | null>(row.navigation_json, null) : null,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    toolArguments: row.tool_arguments_json ? parseJson<Record<string, unknown>>(row.tool_arguments_json, {}) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageRole(value: string): AgentMessage['role'] {
  return value === 'assistant' || value === 'system' ? value : 'user'
}

export function serializeMessage(row: Row<'agent_messages'>): AgentMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: messageRole(row.role),
    content: row.content,
    createdAt: row.created_at,
  }
}

function plannerSource(value: string | null): AgentPlannerSource | null {
  return value === 'openai_agents' || value === 'openai_compatible_tool_calls' || value === 'rules'
    ? value
    : null
}

function runStatus(value: string): AgentRunRecord['status'] {
  if (value === 'completed' || value === 'failed' || value === 'cancelled') return value
  return 'running'
}

export function serializeRun(row: Row<'agent_runs'>): AgentRunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: runStatus(row.status),
    planner: plannerSource(row.planner_source),
    automationLevel: normalizeAgentAutomationLevel(row.automation_level),
    goalStatus: normalizeGoalStatus(row.goal_status),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function threadTitleFromMessage(message: string) {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized || 'Agent 对话'
}

export async function getOrCreateThread(db: Kysely<Database>, workspace: Row<'workspaces'>, user: AgentThreadUser, threadId?: string | null) {
  if (threadId) {
    const existing = await db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirst()
    if (!existing) throw notFound('Agent thread not found')
    if (existing.workspace_id !== workspace.id || existing.user_id !== user.id) throw forbidden()
    return existing
  }

  const now = utcNow()
  const id = newId()
  await db
    .insertInto('agent_threads')
    .values({
      id,
      workspace_id: workspace.id,
      user_id: user.id,
      title: 'Agent 对话',
      created_at: now,
      updated_at: now,
    })
    .execute()
  return db.selectFrom('agent_threads').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function getThreadForUser(db: Kysely<Database>, workspace: Row<'workspaces'>, user: AgentThreadUser, threadId: string) {
  const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirst()
  if (!thread) throw notFound('Agent thread not found')
  if (thread.workspace_id !== workspace.id || thread.user_id !== user.id) throw forbidden()
  return thread
}

export async function addMessage(db: Kysely<Database>, threadId: string, role: 'user' | 'assistant' | 'system', content: string) {
  const id = newId()
  await db
    .insertInto('agent_messages')
    .values({
      id,
      thread_id: threadId,
      role,
      content,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function buildThreadSummary(db: Kysely<Database>, thread: Row<'agent_threads'>): Promise<AgentThreadSummary> {
  const [lastMessage, latestRun, pendingActions] = await Promise.all([
    db
      .selectFrom('agent_messages')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('agent_runs')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('agent_action_requests')
      .select('id')
      .where('thread_id', '=', thread.id)
      .where('status', '=', 'pending')
      .execute(),
  ])
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    lastMessage: lastMessage?.content ?? null,
    lastMessageAt: lastMessage?.created_at ?? null,
    latestRunStatus: latestRun ? runStatus(latestRun.status) : null,
    planner: latestRun ? plannerSource(latestRun.planner_source) : null,
    pendingActionCount: pendingActions.length,
  }
}

export async function buildThreadState(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: AgentThreadUser,
  threadId: string,
): Promise<AgentThreadState> {
  const thread = await getThreadForUser(db, workspace, user, threadId)
  const [messages, runs, actions] = await Promise.all([
    db.selectFrom('agent_messages').selectAll().where('thread_id', '=', thread.id).orderBy('created_at', 'asc').execute(),
    db
      .selectFrom('agent_runs')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .execute(),
    db
      .selectFrom('agent_action_requests')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('workspace_id', '=', workspace.id)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'asc')
      .execute(),
  ])
  const latestRun = runs[0] ?? null
  const [planSteps, runEvents, goals, evaluations] = latestRun
    ? await Promise.all([
        db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', latestRun.id).orderBy('sequence_no', 'asc').execute(),
        db.selectFrom('agent_run_events').selectAll().where('run_id', '=', latestRun.id).orderBy('sequence_no', 'asc').execute(),
        db.selectFrom('agent_goals').selectAll().where('run_id', '=', latestRun.id).orderBy('created_at', 'asc').execute(),
        db.selectFrom('agent_evaluations')
          .selectAll()
          .where('run_id', '=', latestRun.id)
          .orderBy((eb) => eb.case().when('status', '=', 'pass').then(1).else(0).end(), 'asc')
          .orderBy('iteration_no', 'asc')
          .execute(),
      ])
    : [[], [], [], []] as [Row<'agent_plan_steps'>[], Row<'agent_run_events'>[], Row<'agent_goals'>[], Row<'agent_evaluations'>[]]
  const navigationEvents = planSteps
    .map((step) => (step.navigation_json ? parseJson<AgentNavigationEvent | null>(step.navigation_json, null) : null))
    .filter((event): event is AgentNavigationEvent => Boolean(event))

  return buildXoxThreadStateView({
    workspace,
    user,
    thread: await buildThreadSummary(db, thread),
    messages: messages.map(serializeMessage),
    runs: runs.map(serializeRun),
    runInputs: runs.map((run) => ({
      runId: run.id,
      userMessage: run.input_message,
    })),
    planner: latestRun ? plannerSource(latestRun.planner_source) : null,
    goals: (goals as Row<'agent_goals'>[]).map(serializeGoal) as AgentGoalRecord[],
    evaluations: (evaluations as Row<'agent_evaluations'>[]).map(serializeEvaluation) as AgentEvaluationResult[],
    navigationEvents,
    runEvents: runEvents.map(serializeRunEvent),
    planSteps: planSteps.map(serializePlanStep),
    actionRequests: actions.map(serializeAction),
  })
}

export async function touchThreadAfterRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  message: string,
) {
  await db
    .updateTable('agent_threads')
    .set({
      title: thread.title === 'Agent 对话' ? threadTitleFromMessage(message) : thread.title,
      updated_at: utcNow(),
    })
    .where('id', '=', thread.id)
    .execute()
}
