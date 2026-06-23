import type { Kysely } from 'kysely'
import type { AgentRunResult } from '@agentic-os/contracts'
import {
  createAgentServerRunScheduler,
  projectAgentServerRunCompletion,
  type AgentServerRunScheduler,
} from '@agentic-os/server'
import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
import type { Settings } from '../../core/settings.js'
import { utcNow } from '../../core/time.js'
import type { CurrentUser } from '../../modules/auth.js'
import { redactSecretLikeContent } from '../memory.js'
import { resolveAgentRuntimeSettings } from '../provider-settings.js'
import type { PlannerContext } from '../host-profile/xox-planned-items.js'
import { executeXoxAgenticOsRun } from '../host-profile/xox-agent-run-profile.js'
import {
  AgentRunLeaseLostError,
  claimAgentRunLease,
  claimRecoverableAgentRuns,
  refreshAgentRunLease,
  startAgentRunLeaseHeartbeat,
} from './xox-run-lease-store-adapter.js'
import { addRunEvent, agentThreadEvents } from './xox-run-event-store-adapter.js'
import { addMessage, touchThreadAfterRun } from './xox-thread-store-adapter.js'
import { normalizeAgentAutomationLevel } from '../tool-policy.js'

const agentRunSchedulers = new WeakMap<Kysely<Database>, AgentServerRunScheduler>()

export type CompletedAgentRun = {
  agenticOsResult: AgentRunResult
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus | null
}

async function executeAgentRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<CompletedAgentRun | null> {
  return executeXoxAgenticOsRun(ctx, options)
}

function getExistingAgentRunScheduler(db: Kysely<Database>) {
  return agentRunSchedulers.get(db)
}

function getAgentRunScheduler(db: Kysely<Database>, settings: Settings) {
  let scheduler = agentRunSchedulers.get(db)
  if (!scheduler) {
    scheduler = createAgentServerRunScheduler({
      pollIntervalMs: settings.agentRunWorkerPollMs,
    })
    agentRunSchedulers.set(db, scheduler)
  }
  return scheduler
}

export function createAgentRunController(db: Kysely<Database>, settings: Settings, runId: string) {
  const controller = getAgentRunScheduler(db, settings).claimRunController(runId)
  if (!controller) throw new Error(`Agent run is already active: ${runId}`)
  return controller
}

export function safeRunErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || 'Agent run failed'
}

async function failAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  error: unknown,
) {
  const message = safeRunErrorMessage(error)
  const projected = projectAgentServerRunCompletion({
    result: {
      status: 'failed',
      runId,
      threadId: thread.id,
      reason: message,
      evidence: [],
      observations: [],
    },
  })
  if (projected.assistantMessage) {
    await addMessage(db, thread.id, 'assistant', projected.assistantMessage).catch(() => undefined)
  }
  await db.updateTable('agent_runs').set({ status: 'failed', goal_status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
  await db
    .updateTable('agent_goals')
    .set({ status: 'failed', updated_at: utcNow(), completed_at: utcNow(), blocked_reason: message })
    .where('run_id', '=', runId)
    .execute()
    .catch(() => undefined)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute().catch(() => undefined)
  await addRunEvent(db, projected.event).catch(() => undefined)
  agentThreadEvents.publish(thread.id, projected.signal)
}

async function failInterruptedAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
) {
  const now = utcNow()
  await db
    .updateTable('agent_action_requests')
    .set({ status: 'cancelled', error_message: message })
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'failed', updated_at: now })
    .where('run_id', '=', runId)
    .where('status', '!=', 'executed')
    .execute()
  await failAgentRun(db, thread, runId, new Error(message))
}

export async function cancelRunningAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
) {
  getExistingAgentRunScheduler(db)?.cancelRun(runId, message)
  const now = utcNow()
  await db
    .updateTable('agent_action_requests')
    .set({ status: 'cancelled', error_message: message })
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'cancelled', updated_at: now })
    .where('run_id', '=', runId)
    .where('status', '!=', 'executed')
    .execute()
  await db
    .updateTable('agent_runs')
    .set({ status: 'cancelled', goal_status: 'cancelled', completed_at: now, lease_expires_at: null })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .execute()
  await db
    .updateTable('agent_goals')
    .set({ status: 'cancelled', updated_at: now, completed_at: now, blocked_reason: message })
    .where('run_id', '=', runId)
    .execute()
  const projected = projectAgentServerRunCompletion({
    result: {
      status: 'cancelled',
      runId,
      threadId: thread.id,
      reason: message,
      observations: [],
    },
  })
  if (projected.assistantMessage) await addMessage(db, thread.id, 'assistant', projected.assistantMessage)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute()
  await addRunEvent(db, projected.event).catch(() => undefined)
  agentThreadEvents.publish(thread.id, projected.signal)
}

export async function completeAgentRun(ctx: PlannerContext & { thread: Row<'agent_threads'> }): Promise<CompletedAgentRun | null> {
  let stopHeartbeat: (() => void) | null = null
  let runtimeSettings = ctx.settings
  try {
    runtimeSettings = await resolveAgentRuntimeSettings(ctx.db, ctx.settings, ctx.workspace, ctx.user)
    const runtimeCtx: PlannerContext & { thread: Row<'agent_threads'> } = { ...ctx, settings: runtimeSettings }
    const claimed = await claimAgentRunLease(ctx.db, runtimeSettings, ctx.runId)
    if (!claimed) return null
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'worker_claimed',
      title: 'Worker 已认领',
      message: '后台 worker 已取得 run lease，开始执行。同步调用也会经过同一套 lease guard。',
      status: 'running',
    })
    stopHeartbeat = startAgentRunLeaseHeartbeat(ctx.db, runtimeSettings, ctx.runId)
    const runResult = await executeAgentRun(runtimeCtx, {
      beforeStateWrite: () => refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId),
    })
    if (!runResult) return null
    const projected = projectAgentServerRunCompletion({
      result: runResult.agenticOsResult,
      data: {
        actionCount: runResult.actionRows.length,
        planStepCount: runResult.planRows.length,
      },
    })
    await ctx.db
      .updateTable('agent_runs')
      .set({ status: projected.durableStatus, planner_source: runResult.plannerSource, completed_at: utcNow(), lease_expires_at: null })
      .where('id', '=', ctx.runId)
      .where('status', '=', 'running')
      .where('worker_id', '=', runtimeSettings.agentWorkerId)
      .execute()
    await touchThreadAfterRun(ctx.db, ctx.thread, ctx.message)
    await addRunEvent(ctx.db, projected.event)
    agentThreadEvents.publish(ctx.thread.id, projected.signal)
    return runResult
  } catch (error) {
    if (error instanceof AgentRunLeaseLostError) return null
    if (!(await refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId).catch(() => false))) {
      return null
    }
    await failAgentRun(ctx.db, ctx.thread, ctx.runId, error)
    throw error
  } finally {
    stopHeartbeat?.()
    getExistingAgentRunScheduler(ctx.db)?.releaseRunController(ctx.runId)
  }
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

export async function recoverRunningAgentRuns(db: Kysely<Database>, settings: Settings) {
  const scheduler = getAgentRunScheduler(db, settings)
  return scheduler.runExclusiveDrain({
    skipped: () => 0,
    drain: async () => {
      let started = 0
      const runs = await claimRecoverableAgentRuns(db, settings)

      for (const run of runs) {
        if (scheduler.isRunActive(run.id)) continue
        const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', run.thread_id).executeTakeFirst()
        if (!thread) {
          await db.updateTable('agent_runs').set({ status: 'failed', goal_status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', run.id).execute()
          continue
        }
        const [workspace, user, planStepCount, actionCount] = await Promise.all([
          db.selectFrom('workspaces').selectAll().where('id', '=', thread.workspace_id).executeTakeFirst(),
          db.selectFrom('users').selectAll().where('id', '=', run.user_id).executeTakeFirst(),
          countRunRows(db, 'agent_plan_steps', run.id),
          countRunRows(db, 'agent_action_requests', run.id),
        ])
        if (!workspace || !user || thread.user_id !== run.user_id) {
          await failInterruptedAgentRun(db, thread, run.id, 'Agent run 无法恢复：用户或工作区已不存在。')
          continue
        }
        if (planStepCount > 0 || actionCount > 0) {
          await failInterruptedAgentRun(db, thread, run.id, 'Agent run 在服务重启时已有部分运行产物，系统已取消未执行确认卡以避免重复执行。请重新发送这条指令。')
          continue
        }
        const message = await recoverRunMessage(db, run)
        if (!message) {
          await failInterruptedAgentRun(db, thread, run.id, 'Agent run 无法恢复：缺少原始用户指令。请重新发送这条指令。')
          continue
        }
        agentThreadEvents.publish(thread.id, 'thread_restored')
        const controller = scheduler.claimRunController(run.id)
        if (!controller) continue
        void completeAgentRun({
          db,
          settings,
          user,
          workspace,
          thread,
          threadId: thread.id,
          runId: run.id,
          message,
          automationLevel: normalizeAgentAutomationLevel(run.automation_level),
          abortSignal: controller.signal,
        }).catch(() => undefined)
        started += 1
      }
      return started
    },
  })
}

export function scheduleAgentRunQueueDrain(db: Kysely<Database>, settings: Settings) {
  getAgentRunScheduler(db, settings).scheduleDrain(() => recoverRunningAgentRuns(db, settings))
}

export function startAgentRunQueueWorker(db: Kysely<Database>, settings: Settings) {
  return getAgentRunScheduler(db, settings).start(
    () => recoverRunningAgentRuns(db, settings),
    settings.agentRunWorkerPollMs,
  )
}
