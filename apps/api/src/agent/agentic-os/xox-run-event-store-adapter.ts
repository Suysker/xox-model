import type { Kysely } from 'kysely'
import type { AgentRunEvent as OsRunEvent } from '@agentic-os/contracts'
import type { AgentRunEvent, AgentRunEventStatus, AgentRuntimeChannel } from '@xox/contracts'
import {
  AgentServerSignalBus,
  addAgentServerRuntimeStreamRunEvent,
  createAgentServerSequencedRunEventAppender,
  isAgentServerSqliteUniqueConstraintError,
  type AgentServerSignal,
  type AgentServerRuntimeStreamRunEventCopyInput,
  type AgentServerRuntimeStreamEvent,
} from '@agentic-os/server'
import type { Database, Row } from '../../db/schema.js'
import { jsonString, parseJson } from '../../db/database.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import { redactSecretLikeContent } from '../memory.js'

export type AgentThreadEventReason =
  | 'thread_started'
  | 'plan_ready'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'run_trace'
  | 'action_executed'
  | 'action_cancelled'
  | 'action_updated'
  | 'thread_restored'

export type AgentThreadEventSignal = {
  threadId: string
  sequence: number
  reason: AgentThreadEventReason
}

type AgentThreadEventListener = (event: AgentThreadEventSignal) => void

const threadSignalBus = new AgentServerSignalBus<AgentThreadEventReason>()

function toThreadSignal(signal: AgentServerSignal<AgentThreadEventReason>): AgentThreadEventSignal {
  return {
    threadId: signal.topicId,
    sequence: signal.sequence,
    reason: signal.reason,
  }
}

export const agentThreadEvents = {
  subscribe(threadId: string, listener: AgentThreadEventListener) {
    return threadSignalBus.subscribe(threadId, (signal) => listener(toThreadSignal(signal)))
  },
  publish(threadId: string, reason: AgentThreadEventReason) {
    return toThreadSignal(threadSignalBus.publish(threadId, reason))
  },
  listenerCount(threadId: string) {
    return threadSignalBus.listenerCount(threadId)
  },
}

const runEventAppender = createAgentServerSequencedRunEventAppender({
  maxSequenceRetries: 5,
  isSequenceConflict: (error) => isAgentServerSqliteUniqueConstraintError(error, [
    'agent_run_events.run_id',
    'agent_run_events.sequence_no',
  ]),
})

function runEventStatus(value: string): AgentRunEventStatus {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'info' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  return 'info'
}

function runEventChannel(value: string | null | undefined): AgentRuntimeChannel {
  if (value === 'assistant' || value === 'tool' || value === 'lifecycle') return value
  return 'lifecycle'
}

function inferredRunEventChannel(input: {
  type: string
  data?: Record<string, unknown> | null
}): AgentRuntimeChannel {
  if (input.type === 'assistant_final_message' || input.type === 'final_answer_candidate') return 'assistant'
  if (input.type === 'provider_stream_delta') {
    const kind = input.data?.kind
    if (kind === 'content_delta') return 'assistant'
    if (kind === 'tool_call_delta') return 'tool'
  }
  if (
    input.type === 'provider_tool_call_repaired' ||
    input.type === 'tool_call_started' ||
    input.type === 'tool_call_completed' ||
    input.type === 'tool_call_failed' ||
    input.type === 'action_updated' ||
    input.type === 'action_executed' ||
    input.type === 'action_execution_failed' ||
    input.type === 'action_cancelled'
  ) {
    return 'tool'
  }
  return 'lifecycle'
}

export function serializeRunEvent(row: Row<'agent_run_events'>): AgentRunEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    sequence: row.sequence_no,
    channel: runEventChannel(row.channel),
    type: row.event_type,
    title: row.title,
    message: row.message,
    status: runEventStatus(row.status),
    data: row.data_json ? parseJson<Record<string, unknown> | null>(row.data_json, null) : null,
    createdAt: row.created_at,
  }
}

async function loadRunEventMaxSequence(db: Kysely<Database>, runId: string) {
  const existing = await db
    .selectFrom('agent_run_events')
    .select(({ fn }) => fn.max<number>('sequence_no').as('maxSequence'))
    .where('run_id', '=', runId)
    .executeTakeFirst()
  return Number(existing?.maxSequence ?? 0)
}

async function insertRunEvent(
  db: Kysely<Database>,
  input: {
    threadId: string
    runId: string
    type: string
    title: string
    message: string
    status: AgentRunEventStatus
    channel?: AgentRuntimeChannel | undefined
    data?: Record<string, unknown> | null
  },
  sequence: number,
) {
  const id = newId()
  await db
    .insertInto('agent_run_events')
    .values({
      id,
      thread_id: input.threadId,
      run_id: input.runId,
      sequence_no: sequence,
      channel: input.channel ?? inferredRunEventChannel(input),
      event_type: input.type,
      title: input.title.slice(0, 180),
      message: input.message,
      status: input.status,
      data_json: input.data ? jsonString(input.data) : null,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_run_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function addRunEvent(
  db: Kysely<Database>,
  input: {
    threadId: string
    runId: string
    type: string
    title: string
    message: string
    status: AgentRunEventStatus
    channel?: AgentRuntimeChannel | undefined
    data?: Record<string, unknown> | null
  },
) {
  const row = await runEventAppender.append({
    runId: input.runId,
    loadMaxSequence: () => loadRunEventMaxSequence(db, input.runId),
    insert: ({ sequence }) => insertRunEvent(db, input, sequence),
  })
  agentThreadEvents.publish(input.threadId, 'run_trace')
  return row
}

export async function addAgenticOsActionRunEvent(
  db: Kysely<Database>,
  input: {
    threadId: string
    runId: string
    event: OsRunEvent
  },
) {
  const payload = input.event.payload as Record<string, unknown>
  if (input.event.type === 'action.previewed') {
    const actionTitle = actionEventTitle(payload, '待确认动作')
    await addRunEvent(db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'tool_plan_ready',
      title: '模型工具调用已解析',
      message: '模型规划生成 1 个待确认写入动作。',
      status: 'blocked',
      channel: 'tool',
      data: {
        ...payload,
        pendingActionCount: 1,
        harness: 'agentic-os',
      },
    })
    await addRunEvent(db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'confirmation_ready',
      title: '确认卡已生成',
      message: `已生成待确认动作卡：${actionTitle}`,
      status: 'blocked',
      channel: 'tool',
      data: {
        ...payload,
        harness: 'agentic-os',
      },
    })
    return
  }
  if (input.event.type === 'action.executed') {
    const actionTitle = actionEventTitle(payload, 'Agent 动作')
    const failed = payload.status === 'failed'
    await addRunEvent(db, {
      threadId: input.threadId,
      runId: input.runId,
      type: failed ? 'action_execution_failed' : 'action_executed',
      title: failed ? '动作执行失败' : '动作已执行',
      message: failed ? `${actionTitle}：执行失败` : `已执行：${actionTitle}`,
      status: failed ? 'failed' : 'completed',
      channel: 'tool',
      data: {
        ...payload,
        harness: 'agentic-os',
      },
    })
    return
  }
  if (input.event.type === 'action.edited') {
    const actionTitle = actionEventTitle(payload, '确认卡')
    await addRunEvent(db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'action_updated',
      title: '确认卡已更新',
      message: `已更新：${actionTitle}`,
      status: 'info',
      channel: 'tool',
      data: {
        ...payload,
        harness: 'agentic-os',
      },
    })
    return
  }
  if (input.event.type === 'action.rejected') {
    const actionTitle = actionEventTitle(payload, '确认卡')
    await addRunEvent(db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'action_cancelled',
      title: '确认卡已取消',
      message: `已取消：${actionTitle}`,
      status: 'cancelled',
      channel: 'tool',
      data: {
        ...payload,
        harness: 'agentic-os',
      },
    })
  }
}

function actionEventTitle(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.actionTitle === 'string' && payload.actionTitle.length > 0) return payload.actionTitle
  if (typeof payload.toolName === 'string' && payload.toolName.length > 0) return payload.toolName
  return fallback
}

export async function listSerializedRunEvents(db: Kysely<Database>, runId: string): Promise<AgentRunEvent[]> {
  const rows = await db.selectFrom('agent_run_events').selectAll().where('run_id', '=', runId).orderBy('sequence_no', 'asc').execute()
  return rows.map(serializeRunEvent)
}

function safeProviderStreamValue(value: string, maxLength: number) {
  return redactSecretLikeContent(value).slice(0, maxLength)
}

function xoxRuntimeStreamCopy(input: AgentServerRuntimeStreamRunEventCopyInput) {
  const { event, data } = input
  if (event.kind === 'stream_started') {
    return {
      title: 'Provider 流已打开',
      message: `正在接收 ${data.provider} / ${data.model} 的流式输出。`,
    }
  }
  if (event.kind === 'content_delta') {
    const delta = typeof data.delta === 'string' && data.delta.trim().length > 0 ? data.delta : '正在输出回答内容。'
    return {
      title: '模型输出片段',
      message: delta,
    }
  }
  if (event.kind === 'tool_call_delta') {
    const toolName = typeof data.toolName === 'string' && data.toolName.length > 0 ? data.toolName : 'unknown_tool'
    const preview = typeof data.argumentsPreview === 'string' ? data.argumentsPreview : ''
    return {
      title: '工具调用片段',
      message: `${toolName}: ${preview}`,
    }
  }
  if (event.kind === 'tool_call_repaired') {
    return {
      title: '工具调用参数已修复',
      message: `${data.toolName} 的流式参数包含 provider 污染片段，已在有界范围内提取完整 JSON。`,
    }
  }
  if (event.kind === 'tool_call_damage') {
    const toolName = typeof data.toolName === 'string' && data.toolName.length > 0 ? data.toolName : 'unknown_tool'
    return {
      title: '工具调用帧不可执行',
      message: `${toolName}: ${data.message}`,
    }
  }
  return {
    title: 'Provider 流已结束',
    message: `模型流已结束，累计内容 ${event.contentLength} 字符，工具调用 ${event.toolCallCount} 个。`,
  }
}

export async function addRuntimeStreamRunEvent(
  ctx: { db: Kysely<Database>; threadId: string; runId: string; phase?: 'planning' | 'final_answer' },
  event: AgentServerRuntimeStreamEvent,
) {
  await addAgentServerRuntimeStreamRunEvent({
    threadId: ctx.threadId,
    runId: ctx.runId,
    event,
    ...(ctx.phase ? { phase: ctx.phase } : {}),
    redact: safeProviderStreamValue,
    copy: xoxRuntimeStreamCopy,
    appendRunEvent: (draft) => addRunEvent(ctx.db, draft),
  })
}
