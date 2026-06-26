import type { Kysely } from 'kysely'
import type { AgentRunInput, AgentRunRecord, AgentScope } from '@agentic-os/contracts'
import { normalizeAgentAutomationLevel } from '@agentic-os/core'
import {
  applyAgentServerRunInterruptionProjection,
  createAgentServerDurableRunWorker,
  hasAgentServerRunPartialOutput,
  projectAgentServerInterruptedRunCompletion,
  projectAgentServerRunRecoveryFailClosedInterruption,
  projectAgentServerQueuedRunCompletion,
  safeAgentServerErrorMessage,
  type AgentServerDurableRunQueueStore,
  type AgentServerQueuedRun,
  type AgentServerRunExecutor,
  type AgentServerRunRecoveryCandidate,
  type AgentServerRunWorker,
} from '@agentic-os/server'
import type { AgentPlannerSource } from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
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

const agentRunWorkers = new WeakMap<Kysely<Database>, AgentServerRunWorker>()

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

async function persistRunInterruptionProjection(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  projected: Parameters<typeof applyAgentServerRunInterruptionProjection>[0]['projection'],
) {
  await applyAgentServerRunInterruptionProjection({
    projection: projected,
    effects: {
      appendAssistantMessage: async ({ message }) => {
        await addMessage(db, thread.id, 'assistant', message).catch(() => undefined)
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
      touchThread: async () => {
        await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute().catch(() => undefined)
      },
      appendRunEvent: async (event) => {
        await addRunEvent(db, event).catch(() => undefined)
      },
      publishSignal: ({ signal }) => {
        agentThreadEvents.publish(thread.id, signal)
      },
    },
  })
}

async function recordRunFailureFromError(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  error: unknown,
) {
  await persistRunInterruptionProjection(db, thread, projectAgentServerInterruptedRunCompletion({
    runId,
    threadId: thread.id,
    kind: 'failed',
    message: safeRunErrorMessage(error),
  }))
}

export async function cancelRunningAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
) {
  agentRunWorkers.get(db)?.cancelRun(runId, message)
  await persistRunInterruptionProjection(db, thread, projectAgentServerInterruptedRunCompletion({
    runId,
    threadId: thread.id,
    kind: 'cancelled',
    message,
  }))
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

async function recoveryCandidateFromRun(
  db: Kysely<Database>,
  run: Row<'agent_runs'>,
): Promise<AgentServerRunRecoveryCandidate> {
  const load = await loadXoxRun(db, run)
  if (!load.ok) {
    return {
      run: {
        runId: run.id,
        threadId: run.thread_id,
        scope: { tenantId: run.user_id, workspaceId: load.thread?.workspace_id ?? 'unknown', userId: run.user_id },
        status: 'running',
        createdAt: run.created_at,
      },
      request: null,
      invalidReason: load.invalidReason,
    }
  }
  const [planStepCount, actionRequestCount] = await Promise.all([
    countRunRows(db, 'agent_plan_steps', run.id),
    countRunRows(db, 'agent_action_requests', run.id),
  ])
  const queued = queuedRunFromLoad(load)
  const candidate: AgentServerRunRecoveryCandidate = {
    run: queued.run,
    request: queued.request,
    partialOutput: {
      planStepCount,
      actionRequestCount,
    },
  }
  if (queued.maxIterations !== undefined) candidate.maxIterations = queued.maxIterations
  if (queued.metadata !== undefined) candidate.metadata = queued.metadata
  return candidate
}

async function claimRows(
  db: Kysely<Database>,
  settings: Settings,
  input: { limit: number },
  source: 'pending' | 'recoverable',
) {
  const candidates = source === 'recoverable'
    ? await claimRecoverableAgentRuns(db, settings)
    : await db
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

function createXoxRunExecutor(db: Kysely<Database>, baseSettings: Settings): AgentServerRunExecutor {
  return {
    resumeRun: async (input, control) => {
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
    },
  }
}

function createXoxRunQueueStore(
  db: Kysely<Database>,
  settings: Settings,
): AgentServerDurableRunQueueStore {
  return {
    claimPendingRuns: async (input) => {
      const runs = await claimRows(db, settings, input, 'pending')
      const queuedRuns: AgentServerQueuedRun[] = []
      for (const run of runs) {
        const load = await loadXoxRun(db, run)
        if (load.ok) {
          const partialOutput = await runPartialOutputSummary(db, run.id)
          if (hasAgentServerRunPartialOutput(partialOutput)) {
            continue
          }
          queuedRuns.push(queuedRunFromLoad(load))
        } else if (load.thread) {
          await recordRunFailureFromError(db, load.thread, run.id, new Error(load.invalidReason))
        } else {
          await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', run.id).execute()
        }
      }
      return queuedRuns
    },
    claimRecoverableRuns: async (input) => {
      const runs = await claimRows(db, settings, input, 'recoverable')
      const candidates: AgentServerRunRecoveryCandidate[] = []
      for (const run of runs) {
        candidates.push(await recoveryCandidateFromRun(db, run))
      }
      return candidates
    },
    markRunStarted: async ({ queuedRun }) => {
      await addRunEvent(db, {
        threadId: queuedRun.run.threadId,
        runId: queuedRun.run.runId,
        type: 'worker_claimed',
        title: 'Worker 已认领',
        message: 'Agentic OS worker 已取得 run lease，开始执行。',
        status: 'running',
      })
      agentThreadEvents.publish(queuedRun.run.threadId, 'thread_started')
    },
    markRunCompleted: async ({ queuedRun, result }) => {
      const [planStepCount, actionCount] = await Promise.all([
        countRunRows(db, 'agent_plan_steps', queuedRun.run.runId),
        countRunRows(db, 'agent_action_requests', queuedRun.run.runId),
      ])
      const projected = projectAgentServerQueuedRunCompletion({
        queuedRun,
        result,
        partialOutput: { actionRequestCount: actionCount, planStepCount },
        data: { actionCount },
      })
      await db
        .updateTable('agent_runs')
        .set({
          status: projected.durableStatus,
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
      await addRunEvent(db, projected.event)
      agentThreadEvents.publish(queuedRun.run.threadId, projected.signal)
    },
    markRunFailed: async ({ queuedRun, error }) => {
      const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', queuedRun.run.threadId).executeTakeFirst()
      if (thread) await recordRunFailureFromError(db, thread, queuedRun.run.runId, error)
    },
    failClosedRecovery: async ({ candidate, decision }) => {
      const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', candidate.run.threadId).executeTakeFirst()
      if (!thread) {
        await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', candidate.run.runId).execute()
        return
      }
      await persistRunInterruptionProjection(db, thread, projectAgentServerRunRecoveryFailClosedInterruption({
        candidate,
        decision,
        copy: {
          partial_output_present: 'Agent run 在服务重启时已有部分运行产物，系统已取消未执行确认卡以避免重复执行。请重新发送这条指令。',
        },
      }))
    },
  }
}

function getAgentRunWorker(db: Kysely<Database>, settings: Settings) {
  let worker = agentRunWorkers.get(db)
  if (!worker) {
    worker = createAgentServerDurableRunWorker({
      server: createXoxRunExecutor(db, settings),
      store: createXoxRunQueueStore(db, settings),
      queueOptions: { recoverRunningRuns: true },
      workerOptions: {
        workerId: settings.agentWorkerId,
        batchSize: 1,
        pollIntervalMs: settings.agentRunWorkerPollMs,
      },
    })
    agentRunWorkers.set(db, worker)
  }
  return worker
}

async function queuedRunForRunId(db: Kysely<Database>, settings: Settings, runId: string) {
  const claimed = await claimAgentRunLease(db, settings, runId)
  if (!claimed) return null
  const load = await loadXoxRun(db, claimed)
  if (!load.ok) {
    if (load.thread) await recordRunFailureFromError(db, load.thread, runId, new Error(load.invalidReason))
    return null
  }
  return queuedRunFromLoad(load)
}

export async function completeAgentRun(input: PlannerContext & { thread: Row<'agent_threads'> }): Promise<AgenticOsKernelRunResult | null> {
  const worker = getAgentRunWorker(input.db, input.settings)
  const queuedRun = await queuedRunForRunId(input.db, input.settings, input.runId)
  if (!queuedRun) return null
  const execution = await worker.runQueuedRun(queuedRun)
  if (execution.status === 'failed') throw execution.error
  if (execution.status === 'skipped_active') return null
  const run = await input.db.selectFrom('agent_runs').selectAll().where('id', '=', input.runId).executeTakeFirstOrThrow()
  const load = await loadXoxRun(input.db, run)
  if (!load.ok) return null
  const actionRows = await input.db.selectFrom('agent_action_requests').selectAll().where('run_id', '=', input.runId).orderBy('created_at', 'asc').execute()
  const planRows = await input.db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', input.runId).orderBy('sequence_no', 'asc').execute()
  const assistantMessage = await input.db.selectFrom('agent_messages').selectAll().where('thread_id', '=', input.thread.id).where('role', '=', 'assistant').orderBy('created_at', 'desc').executeTakeFirst()
  return {
    agenticOsResult: execution.result,
    plannerSource: (run.planner_source as AgentPlannerSource | null) ?? xoxPlannerSource(input.settings),
    assistantMessage: assistantMessage ?? null,
    navigationEvents: [],
    actionRows,
    planRows,
  }
}

export async function recoverRunningAgentRuns(db: Kysely<Database>, settings: Settings) {
  const result = await getAgentRunWorker(db, settings).startReadyRuns()
  return result.started
}

export function scheduleAgentRunQueueDrain(db: Kysely<Database>, settings: Settings) {
  getAgentRunWorker(db, settings).scheduleStartReadyRuns()
}

export function startAgentRunQueueWorker(db: Kysely<Database>, settings: Settings) {
  return getAgentRunWorker(db, settings).start()
}
