import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { redactSecretLikeContent } from './memory.js'
import { resolveAgentRuntimeSettings } from './provider-settings.js'
import type { PlannerContext } from './planning-context.js'
import { executeAgentKernelRun, type AgentKernelRunResult } from './agent-kernel.js'
import {
  AgentRunLeaseLostError,
  claimAgentRunLease,
  claimRecoverableAgentRuns,
  refreshAgentRunLease,
  startAgentRunLeaseHeartbeat,
} from './run-lease.js'
import { addRunEvent } from './run-events.js'
import { agentThreadEvents } from './thread-events.js'
import { addMessage, touchThreadAfterRun } from './thread-store.js'
import { normalizeAgentAutomationLevel } from './tool-policy.js'

const activeRunControllers = new Map<string, AbortController>()

export function createAgentRunController(runId: string) {
  const controller = new AbortController()
  activeRunControllers.set(runId, controller)
  return controller
}

type AgentRunQueueState = {
  draining: boolean
  scheduled: boolean
  stopped: boolean
  interval: NodeJS.Timeout | null
}

const agentRunQueueStates = new WeakMap<Kysely<Database>, AgentRunQueueState>()

export type CompletedAgentRun = AgentKernelRunResult

function getAgentRunQueueState(db: Kysely<Database>) {
  let state = agentRunQueueStates.get(db)
  if (!state) {
    state = { draining: false, scheduled: false, stopped: false, interval: null }
    agentRunQueueStates.set(db, state)
  }
  return state
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
  await addMessage(db, thread.id, 'assistant', `运行失败：${message}`).catch(() => undefined)
  await db.updateTable('agent_runs').set({ status: 'failed', goal_status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
  await db
    .updateTable('agent_goals')
    .set({ status: 'failed', updated_at: utcNow(), completed_at: utcNow(), blocked_reason: message })
    .where('run_id', '=', runId)
    .execute()
    .catch(() => undefined)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute().catch(() => undefined)
  await addRunEvent(db, {
    threadId: thread.id,
    runId,
    type: 'run_failed',
    title: '运行失败',
    message,
    status: 'failed',
  }).catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_failed')
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
  addAssistantMessage: boolean,
) {
  activeRunControllers.get(runId)?.abort()
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
  if (addAssistantMessage) await addMessage(db, thread.id, 'assistant', message)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute()
  await addRunEvent(db, {
    threadId: thread.id,
    runId,
    type: 'run_cancelled',
    title: '运行已取消',
    message,
    status: 'cancelled',
  }).catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_cancelled')
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
    const kernelResult = await executeAgentKernelRun(runtimeCtx, {
      beforeStateWrite: () => refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId),
    })
    if (!kernelResult) return null
    const goalFailed = kernelResult.goalStatus === 'failed' || kernelResult.goalStatus === 'blocked'
    await ctx.db
      .updateTable('agent_runs')
      .set({ status: goalFailed ? 'failed' : 'completed', planner_source: kernelResult.plannerSource, completed_at: utcNow(), lease_expires_at: null })
      .where('id', '=', ctx.runId)
      .where('status', '=', 'running')
      .where('worker_id', '=', runtimeSettings.agentWorkerId)
      .execute()
    await touchThreadAfterRun(ctx.db, ctx.thread, ctx.message)
    const pendingActionCount = kernelResult.actionRows.filter((row) => row.status === 'pending').length
    const executedActionCount = kernelResult.actionRows.filter((row) => row.status === 'executed').length
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: goalFailed ? 'run_failed' : 'run_completed',
      title: goalFailed ? '运行未完成' : '运行完成',
      message: goalFailed
        ? '目标循环未能完成所有要求，请查看失败步骤或补充信息后重试。'
        : pendingActionCount > 0
          ? '模型规划已完成，等待用户处理确认卡。'
          : executedActionCount > 0
            ? '模型规划和自动执行已完成。'
            : '模型规划和只读回答已完成。',
      status: goalFailed ? 'failed' : 'completed',
      data: { actionCount: kernelResult.actionRows.length, pendingActionCount, executedActionCount, planStepCount: kernelResult.planRows.length },
    })
    agentThreadEvents.publish(ctx.thread.id, goalFailed ? 'run_failed' : 'run_completed')
    return kernelResult
  } catch (error) {
    if (error instanceof AgentRunLeaseLostError) return null
    if (!(await refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId).catch(() => false))) {
      return null
    }
    await failAgentRun(ctx.db, ctx.thread, ctx.runId, error)
    throw error
  } finally {
    stopHeartbeat?.()
    activeRunControllers.delete(ctx.runId)
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
  const queueState = getAgentRunQueueState(db)
  if (queueState.draining || queueState.stopped) return 0
  queueState.draining = true
  let started = 0
  try {
    const runs = await claimRecoverableAgentRuns(db, settings)

    for (const run of runs) {
      if (activeRunControllers.has(run.id)) continue
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
      const controller = createAgentRunController(run.id)
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
  } finally {
    queueState.draining = false
  }
}

export function scheduleAgentRunQueueDrain(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  if (queueState.scheduled || queueState.stopped) return
  queueState.scheduled = true
  const timer = setTimeout(() => {
    queueState.scheduled = false
    void recoverRunningAgentRuns(db, settings).catch(() => undefined)
  }, 0)
  timer.unref?.()
}

export function startAgentRunQueueWorker(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  queueState.stopped = false
  if (queueState.interval) return () => undefined

  scheduleAgentRunQueueDrain(db, settings)
  queueState.interval = setInterval(() => {
    void recoverRunningAgentRuns(db, settings).catch(() => undefined)
  }, settings.agentRunWorkerPollMs)
  queueState.interval.unref?.()

  return () => {
    queueState.stopped = true
    queueState.scheduled = false
    if (queueState.interval) clearInterval(queueState.interval)
    queueState.interval = null
  }
}
