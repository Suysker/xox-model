import type { Kysely } from 'kysely'
import type {
  AgentRunInput,
  AgentRunRecord,
  AgentRunResult,
  AgentRunResumeInput,
  AgentScope,
  JsonValue,
} from '@agentic-os/contracts'
import { createAgentTraceContext, normalizeAgentAutomationLevel, type AgentRunControl } from '@agentic-os/core'
import {
  applyAgentServerSaaSRunInterruption,
  createAgentServerDurableJournalCausalFactPort,
  createAgentServerSaaSDurableRunHostProfileRegistry,
  safeAgentServerErrorMessage,
  type AgentServerQueuedRun,
  materializeAgentServerRunRecoverySnapshot,
  type AgentServerSaaSRunInterruptionEffects,
  type AgentServerSaaSDurableRunClaimSource,
  type AgentServerSaaSDurableRunLoad,
  type AgentServerRunRecoverySnapshot,
} from '@agentic-os/server'
import type { AgentNavigationEvent, AgentRuntimeSource } from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
import { parseJson } from '../../db/database.js'
import type { Settings } from '../../core/settings.js'
import { utcNow } from '../../core/time.js'
import type { CurrentUser } from '../../modules/auth.js'
import type { SandboxBroker } from '@agentic-os/sandbox'
import { resolveAgentRuntimeSettings } from '../provider-settings.js'
import type { AgentTurnContext } from '../host-profile/xox-runtime-items.js'
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
import { createXoxHarnessControlInfrastructure } from './xox-harness-control-store-adapter.js'

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

function xoxRuntimeSource(settings: Settings): AgentRuntimeSource {
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

async function executeAgentRun(
  ctx: AgentTurnContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean>; sandboxBroker: SandboxBroker },
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
  sandboxBroker: SandboxBroker,
) {
  createXoxDurableRunStore(db, settings, { sandboxBroker }).cancelActive(runId, message)
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

function queuedRunFromLoad(
  load: Extract<XoxRunLoad, { ok: true }>,
  source: AgentServerSaaSDurableRunClaimSource,
  ownership: AgentServerQueuedRun['ownership'],
): AgentServerQueuedRun {
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
    ownership,
    source: source === 'recoverable' ? 'recovery' : 'pending',
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
  source: AgentServerSaaSDurableRunClaimSource,
  infrastructure: ReturnType<typeof createXoxHarnessControlInfrastructure>,
): Promise<AgentServerSaaSDurableRunLoad<Row<'agent_runs'>>> {
  const load = await loadXoxRun(db, run)
  if (load.ok) {
    const scope = xoxScope(load.workspace, load.user)
    const [state, journalCursor] = await Promise.all([
      infrastructure.control.loopState.load({ scope, runId: run.id }),
      infrastructure.traceJournal.currentCursor({ scope, runId: run.id }),
    ])
    const workerId = run.worker_id
    if (workerId === null) throw new Error(`Agent run ${run.id} has no durable worker owner.`)
    const ownership = await infrastructure.durableRunOwnership.claim({
      scope,
      runId: run.id,
      workerId,
      expectedStateVersion: state?.stateVersion ?? 0,
      journalCursor,
      now: run.heartbeat_at ?? utcNow(),
    })
    const queuedRun = queuedRunFromLoad(load, source, ownership)
    let recoverySnapshot: AgentServerRunRecoverySnapshot | undefined
    if (source === 'recoverable' && state !== null) {
      try {
        recoverySnapshot = await materializeAgentServerRunRecoverySnapshot({
          dependencies: {
            control: infrastructure.control,
            runtimeExecution: infrastructure.runtimeExecutionStore,
            loadTerminalResult: async ({ run: recoveryRun, resultRef }) => {
              const record = await infrastructure.control.records.load<AgentRunResult & JsonValue>({
                scope: recoveryRun.scope,
                runId: recoveryRun.runId,
                refId: resultRef,
                kind: 'run_result',
              })
              return record?.value ?? null
            },
          },
          run: queuedRun.run,
          ownership,
          journalCursor,
        })
      } catch (error) {
        queuedRun.metadata = {
          ...(queuedRun.metadata ?? {}),
          recoverySnapshotError: safeRunErrorMessage(error),
        }
      }
    }
    return {
      status: 'ready',
      row: run,
      queuedRun,
      ...(recoverySnapshot === undefined ? {} : { recoverySnapshot }),
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
  control: AgentRunControl | undefined,
  sandboxBroker: SandboxBroker,
) {
  const run = await db.selectFrom('agent_runs').selectAll().where('id', '=', input.run.runId).executeTakeFirst()
  if (!run) throw new Error(`Agent run not found: ${input.run.runId}`)
  const load = await loadXoxRun(db, run)
  if (!load.ok) throw new Error(load.invalidReason)
  const runtimeSettings = await resolveAgentRuntimeSettings(db, baseSettings, load.workspace, load.user)
  const runtimeCtx: AgentTurnContext & { thread: Row<'agent_threads'> } = {
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
      sandboxBroker,
    })
    if (!completed) throw new AgentRunLeaseLostError(run.id)
    return completed.agenticOsResult
  } finally {
    stopHeartbeat?.()
  }
}

async function submittedProfileRun(
  db: Kysely<Database>,
  settings: Settings,
  runId: string,
  infrastructure: ReturnType<typeof createXoxHarnessControlInfrastructure>,
) {
  const claimed = await claimAgentRunLease(db, settings, runId)
  if (!claimed) return null
  return loadProfileRun(db, claimed, 'pending', infrastructure)
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
    runtimeSource: (run.runtime_source as AgentRuntimeSource | null) ?? xoxRuntimeSource(settings),
    assistantMessage: assistantMessage ?? null,
    navigationEvents: runNavigationEvents(planRows),
    actionRows,
    planRows,
  }
}

export function createXoxDurableRunStore(
  db: Kysely<Database>,
  settings: Settings,
  options: { sandboxBroker: SandboxBroker },
) {
  const infrastructure = createXoxHarnessControlInfrastructure(db, settings.agentRunLeaseTtlMs)
  return xoxRunHosts.forHost(db, () => ({
    resumeRun: (input, control) => resumeProfileRun(db, settings, input, control, options.sandboxBroker),
    causalFacts: createAgentServerDurableJournalCausalFactPort({
      journal: infrastructure.traceJournal,
      resolveWriter: (fact) => infrastructure.traceJournal.acquireWriter({
        scope: fact.scope,
        runId: fact.runId,
        ownerId: settings.agentWorkerId,
        traceContext: createAgentTraceContext({
          run: {
            runId: fact.runId,
            threadId: fact.threadId,
            scope: fact.scope,
            status: 'running',
            createdAt: fact.occurredAt,
          },
          contentPolicyId: 'agentic-os.metadata-only.v1',
        }),
      }),
    }),
    rows: {
      claim: (input) => claimRows(db, settings, input, input.source),
      load: ({ row, source }) => loadProfileRun(db, row, source, infrastructure),
      loadSubmittedRun: (runId) => submittedProfileRun(db, settings, runId, infrastructure),
    },
    ownership: {
      refresh: async ({ queuedRun, workerId, now }) => {
        if (workerId !== settings.agentWorkerId || queuedRun.ownership.workerId !== workerId) {
          return { active: false as const }
        }
        if (!(await refreshAgentRunLease(db, settings, queuedRun.run.runId))) {
          return { active: false as const }
        }
        const row = await db
          .selectFrom('agent_runs')
          .select(['status', 'worker_id', 'lease_expires_at'])
          .where('id', '=', queuedRun.run.runId)
          .executeTakeFirst()
        if (
          row?.status !== 'running' ||
          row.worker_id !== workerId ||
          row.lease_expires_at === null ||
          row.lease_expires_at <= now
        ) {
          return { active: false as const }
        }
        return infrastructure.durableRunOwnership.refresh({ queuedRun, workerId, now })
      },
      release: async ({ ownership, workerId, now }) => {
        if (workerId !== settings.agentWorkerId || ownership.workerId !== workerId) return 'stale' as const
        return infrastructure.durableRunOwnership.release({ ownership, now })
      },
    },
    effects: {
      started: async ({ projection }) => {
        await addRunEvent(db, {
          ...projection.event,
          title: 'Worker 已认领',
          message: 'Agentic OS worker 已取得 run lease，开始执行。',
        })
        agentThreadEvents.publish(projection.event.threadId, projection.signal)
      },
      completed: async ({ queuedRun, projection }) => {
        const actionCount = await countRunRows(db, 'agent_action_requests', queuedRun.run.runId)
        await db
          .updateTable('agent_runs')
          .set({
            status: projection.durableStatus,
            runtime_source: xoxRuntimeSource(settings),
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
    },
    workerOptions: {
      workerId: settings.agentWorkerId,
      batchSize: 1,
      pollIntervalMs: settings.agentRunWorkerPollMs,
    },
    materializeResult: (input) => materializeXoxRunResult(db, settings, input),
  }))
}
