import type { Kysely } from 'kysely'
import type { AgentRunInput, AgentRunRecord, AgentRunResumeInput, AgentScope } from '@agentic-os/contracts'
import { normalizeAgentAutomationLevel, type AgentRunControl } from '@agentic-os/core'
import {
  applyAgentServerSaaSRunInterruption,
  createAgentServerSaaSDurableRunHostProfileRegistry,
  safeAgentServerErrorMessage,
  type AgentServerQueuedRun,
  type AgentServerSaaSRunInterruptionEffects,
  type AgentServerSaaSDurableRunClaimSource,
  type AgentServerSaaSDurableRunLoad,
} from '@agentic-os/server'
import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
import { parseJson } from '../../db/database.js'
import type { Settings } from '../../core/settings.js'
import { utcNow } from '../../core/time.js'
import type { CurrentUser } from '../../modules/auth.js'
import { resolveAgentRuntimeSettings } from '../provider-settings.js'
import type { PlannerContext } from '../host-profile/xox-planned-items.js'
import { executeXoxAgentRun, type AgenticOsKernelRunResult } from '../host-profile/xox-host-profile.js'
import {
  AgentRunLeaseLostError,
  claimAgentRunLease,
  claimRecoverableAgentRuns,
  refreshAgentRunLease,
  startAgentRunLeaseHeartbeat,
} from './xox-run-lease-store-adapter.js'
import { addRunEvent, agentThreadEvents } from './xox-run-event-store-adapter.js'
import { addMessage, touchThreadAfterRun } from './xox-thread-store-adapter.js'

const xoxRunHosts = createAgentServerSaaSDurableRunHostProfileRegistry<Kysely<Database>, Row<'agent_runs'>, AgenticOsKernelRunResult>()

type XoxRunLoad =
  | {
      ok: true
      run: Row<'agent_runs'>
      thread: Row<'agent_threads'>
      workspace: Row<'workspaces'>
      user: CurrentUser
      message: string
    }
  | {
      ok: false
      run: Row<'agent_runs'>
      thread: Row<'agent_threads'> | null
      invalidReason: string
    }

function xoxScope(workspace: Row<'workspaces'>, user: CurrentUser): AgentScope {
  return {
    tenantId: workspace.owner_id,
    workspaceId: workspace.id,
    userId: user.id,
  }
}

function xoxRunRecord(input: {
  workspace: Row<'workspaces'>
  user: CurrentUser
  run: Row<'agent_runs'>
}): AgentRunRecord {
  return {
    runId: input.run.id,
    threadId: input.run.thread_id,
    scope: xoxScope(input.workspace, input.user),
    status: 'running',
    createdAt: input.run.created_at,
  }
}

function xoxRunInput(input: {
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  message: string
  automationLevel: ReturnType<typeof normalizeAgentAutomationLevel>
}): AgentRunInput {
  return {
    threadId: input.threadId,
    scope: xoxScope(input.workspace, input.user),
    userMessage: input.message,
    automationLevel: input.automationLevel,
    maxIterations: 5,
    metadata: {
      host: 'xox-model',
      harness: 'agentic-os',
      xoxRunId: input.runId,
    },
  }
}

function xoxPlannerSource(settings: Settings): AgentPlannerSource {
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

async function executeAgentRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgenticOsKernelRunResult | null> {
  return executeXoxAgentRun(ctx, options)
}

export function safeRunErrorMessage(error: unknown) {
  return safeAgentServerErrorMessage(error)
}

function xoxRunInterruptionEffects(db: Kysely<Database>): AgentServerSaaSRunInterruptionEffects {
  return {
    appendAssistantMessage: async ({ threadId, message }) => {
      await addMessage(db, threadId, 'assistant', message).catch(() => undefined)
    },
    updatePendingActions: async ({ runId, status, errorMessage }) => {
      await db
        .updateTable('agent_action_requests')
        .set({ status, error_message: errorMessage })
        .where('run_id', '=', runId)
        .where('status', '=', 'pending')
        .execute()
        .catch(() => undefined)
    },
    updatePendingPlanSteps: async ({ runId, status }) => {
      await db
        .updateTable('agent_plan_steps')
        .set({ status, updated_at: utcNow() })
        .where('run_id', '=', runId)
        .where('status', '!=', 'executed')
        .execute()
        .catch(() => undefined)
    },
    updateRun: async ({ runId, status }) => {
      await db
        .updateTable('agent_runs')
        .set({
          status,
          completed_at: utcNow(),
          lease_expires_at: null,
        })
        .where('id', '=', runId)
        .execute()
        .catch(() => undefined)
    },
    touchThread: async ({ threadId }) => {
      await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', threadId).execute().catch(() => undefined)
    },
    appendRunEvent: async (event) => {
      await addRunEvent(db, event).catch(() => undefined)
    },
    publishSignal: ({ threadId, signal }) => {
      agentThreadEvents.publish(threadId, signal)
    },
  }
}

export async function cancelRunningAgentRun(
  db: Kysely<Database>,
  settings: Settings,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
) {
  createXoxDurableRunStore(db, settings).cancelActive(runId, message)
  await applyAgentServerSaaSRunInterruption({
    interruption: {
      kind: 'cancelled',
      runId,
      threadId: thread.id,
      message,
    },
    effects: xoxRunInterruptionEffects(db),
  })
}

async function countRunRows(db: Kysely<Database>, table: 'agent_plan_steps' | 'agent_action_requests', runId: string) {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

async function runPartialOutputSummary(db: Kysely<Database>, runId: string) {
  const [planStepCount, actionRequestCount] = await Promise.all([
    countRunRows(db, 'agent_plan_steps', runId),
    countRunRows(db, 'agent_action_requests', runId),
  ])
  return { planStepCount, actionRequestCount }
}

async function recoverRunMessage(db: Kysely<Database>, run: Row<'agent_runs'>) {
  const stored = run.input_message?.trim()
  if (stored) return stored
  if (run.input_message_id) {
    const message = await db
      .selectFrom('agent_messages')
      .select('content')
      .where('id', '=', run.input_message_id)
      .where('role', '=', 'user')
      .executeTakeFirst()
    if (message?.content.trim()) return message.content.trim()
  }
  const fallback = await db
    .selectFrom('agent_messages')
    .select('content')
    .where('thread_id', '=', run.thread_id)
    .where('role', '=', 'user')
    .where('created_at', '<=', run.created_at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return fallback?.content.trim() ?? null
}

async function loadXoxRun(db: Kysely<Database>, run: Row<'agent_runs'>): Promise<XoxRunLoad> {
  const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', run.thread_id).executeTakeFirst()
  if (!thread) return { ok: false, run, thread: null, invalidReason: 'Agent run 无法恢复：线程已不存在。' }
  const [workspace, user, message] = await Promise.all([
    db.selectFrom('workspaces').selectAll().where('id', '=', thread.workspace_id).executeTakeFirst(),
    db.selectFrom('users').selectAll().where('id', '=', run.user_id).executeTakeFirst(),
    recoverRunMessage(db, run),
  ])
  if (!workspace || !user || thread.user_id !== run.user_id) {
    return { ok: false, run, thread, invalidReason: 'Agent run 无法恢复：用户或工作区已不存在。' }
  }
  if (!message) {
    return { ok: false, run, thread, invalidReason: 'Agent run 无法恢复：缺少原始用户指令。请重新发送这条指令。' }
  }
  return { ok: true, run, thread, workspace, user, message }
}

function queuedRunFromLoad(load: Extract<XoxRunLoad, { ok: true }>): AgentServerQueuedRun {
  const automationLevel = normalizeAgentAutomationLevel(load.run.automation_level)
  return {
    run: xoxRunRecord({
      workspace: load.workspace,
      user: load.user,
      run: load.run,
    }),
    request: xoxRunInput({
      workspace: load.workspace,
      user: load.user,
      threadId: load.thread.id,
      runId: load.run.id,
      message: load.message,
      automationLevel,
    }),
    maxIterations: 5,
    metadata: {
      xoxRunId: load.run.id,
      xoxThreadId: load.thread.id,
    },
  }
}

function invalidRunRecord(run: Row<'agent_runs'>, thread: Row<'agent_threads'> | null): AgentRunRecord {
  return {
    runId: run.id,
    threadId: run.thread_id,
    scope: {
      tenantId: run.user_id,
      workspaceId: thread?.workspace_id ?? 'unknown',
      userId: run.user_id,
    },
    status: 'running',
    createdAt: run.created_at,
  }
}

async function loadProfileRun(
  db: Kysely<Database>,
  run: Row<'agent_runs'>,
): Promise<AgentServerSaaSDurableRunLoad<Row<'agent_runs'>>> {
  const load = await loadXoxRun(db, run)
  if (load.ok) {
    return {
      status: 'ready',
      row: run,
      queuedRun: queuedRunFromLoad(load),
    }
  }
  return {
    status: 'invalid',
    row: run,
    run: invalidRunRecord(run, load.thread),
    message: load.invalidReason,
  }
}

async function claimRows(
  db: Kysely<Database>,
  settings: Settings,
  input: { limit: number },
  source: AgentServerSaaSDurableRunClaimSource,
) {
  if (source === 'recoverable') {
    return (await claimRecoverableAgentRuns(db, settings)).slice(0, input.limit)
  }

  const candidates = await db
      .selectFrom('agent_runs')
      .selectAll()
      .where('status', '=', 'running')
      .where((eb) =>
        eb.or([
          eb('worker_id', 'is', null),
          eb('lease_expires_at', 'is', null),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(input.limit)
      .execute()

  const claimed: Row<'agent_runs'>[] = []
  for (const run of candidates.slice(0, input.limit)) {
    const row = await claimAgentRunLease(db, settings, run.id)
    if (row) claimed.push(row)
  }
  return claimed
}

function runNavigationEvents(planRows: Row<'agent_plan_steps'>[]): AgentNavigationEvent[] {
  return planRows
    .map((step) => (step.navigation_json ? parseJson<AgentNavigationEvent | null>(step.navigation_json, null) : null))
    .filter((event): event is AgentNavigationEvent => Boolean(event))
}

async function resumeProfileRun(
  db: Kysely<Database>,
  baseSettings: Settings,
  input: AgentRunResumeInput,
  control?: AgentRunControl,
) {
  const run = await db.selectFrom('agent_runs').selectAll().where('id', '=', input.run.runId).executeTakeFirst()
  if (!run) throw new Error(`Agent run not found: ${input.run.runId}`)
  const load = await loadXoxRun(db, run)
  if (!load.ok) throw new Error(load.invalidReason)
  const runtimeSettings = await resolveAgentRuntimeSettings(db, baseSettings, load.workspace, load.user)
  const runtimeCtx: PlannerContext & { thread: Row<'agent_threads'> } = {
    db,
    settings: runtimeSettings,
    user: load.user,
    workspace: load.workspace,
    thread: load.thread,
    threadId: load.thread.id,
    runId: run.id,
    message: load.message,
    automationLevel: normalizeAgentAutomationLevel(run.automation_level),
  }
  if (control?.abortSignal !== undefined) {
    runtimeCtx.abortSignal = control.abortSignal as AbortSignal
  }
  let stopHeartbeat: (() => void) | null = null
  try {
    stopHeartbeat = startAgentRunLeaseHeartbeat(db, runtimeSettings, run.id)
    const completed = await executeAgentRun(runtimeCtx, {
      beforeStateWrite: () => refreshAgentRunLease(db, runtimeSettings, run.id),
    })
    if (!completed) throw new AgentRunLeaseLostError(run.id)
    return completed.agenticOsResult
  } finally {
    stopHeartbeat?.()
  }
}

async function submittedProfileRun(db: Kysely<Database>, settings: Settings, runId: string) {
  const claimed = await claimAgentRunLease(db, settings, runId)
  if (!claimed) return null
  return loadProfileRun(db, claimed)
}

async function materializeXoxRunResult(
  db: Kysely<Database>,
  settings: Settings,
  input: {
    queuedRun: AgentServerQueuedRun
    result: AgenticOsKernelRunResult['agenticOsResult']
  },
): Promise<AgenticOsKernelRunResult | null> {
  const run = await db.selectFrom('agent_runs').selectAll().where('id', '=', input.queuedRun.run.runId).executeTakeFirstOrThrow()
  const load = await loadXoxRun(db, run)
  if (!load.ok) return null
  const actionRows = await db.selectFrom('agent_action_requests').selectAll().where('run_id', '=', run.id).orderBy('created_at', 'asc').execute()
  const planRows = await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', run.id).orderBy('sequence_no', 'asc').execute()
  const assistantMessage = await db.selectFrom('agent_messages').selectAll().where('thread_id', '=', input.queuedRun.run.threadId).where('role', '=', 'assistant').orderBy('created_at', 'desc').executeTakeFirst()
  return {
    agenticOsResult: input.result,
    plannerSource: (run.planner_source as AgentPlannerSource | null) ?? xoxPlannerSource(settings),
    assistantMessage: assistantMessage ?? null,
    navigationEvents: runNavigationEvents(planRows),
    actionRows,
    planRows,
  }
}

export function createXoxDurableRunStore(db: Kysely<Database>, settings: Settings) {
  return xoxRunHosts.forHost(db, () => ({
    resumeRun: (input, control) => resumeProfileRun(db, settings, input, control),
    rows: {
      claim: (input) => claimRows(db, settings, input, input.source),
      load: ({ row }) => loadProfileRun(db, row),
      loadSubmittedRun: (runId) => submittedProfileRun(db, settings, runId),
    },
    partialOutput: ({ runId }) => runPartialOutputSummary(db, runId),
    effects: {
      started: async ({ projection }) => {
        await addRunEvent(db, {
          ...projection.event,
          title: 'Worker 已认领',
          message: 'Agentic OS worker 已取得 run lease，开始执行。',
        })
        agentThreadEvents.publish(projection.event.threadId, projection.signal)
      },
      completed: async ({ queuedRun, projection, partialOutput }) => {
        const actionCount = partialOutput?.actionRequestCount ?? 0
        await db
          .updateTable('agent_runs')
          .set({
            status: projection.durableStatus,
            planner_source: xoxPlannerSource(settings),
            completed_at: utcNow(),
            lease_expires_at: null,
          })
          .where('id', '=', queuedRun.run.runId)
          .where('status', '=', 'running')
          .where('worker_id', '=', settings.agentWorkerId)
          .execute()
        const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', queuedRun.run.threadId).executeTakeFirst()
        if (thread) await touchThreadAfterRun(db, thread, queuedRun.request.userMessage)
        await addRunEvent(db, {
          ...projection.event,
          data: {
            ...projection.event.data,
            actionCount,
          },
        })
        agentThreadEvents.publish(queuedRun.run.threadId, projection.signal)
      },
    },
    interruption: {
      effects: xoxRunInterruptionEffects(db),
      recoveryCopy: {
        partial_output_present: 'Agent run 在服务重启时已有部分运行产物，系统已取消未执行确认卡以避免重复执行。请重新发送这条指令。',
      },
    },
    queueOptions: { recoverRunningRuns: true },
    workerOptions: {
      workerId: settings.agentWorkerId,
      batchSize: 1,
      pollIntervalMs: settings.agentRunWorkerPollMs,
    },
    materializeResult: (input) => materializeXoxRunResult(db, settings, input),
  }))
}
