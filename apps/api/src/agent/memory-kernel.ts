import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { addRunEvent } from './run-events.js'
import { compactThreadContextIfNeeded } from './memory.js'
import { memoryCandidatesFromExecutedActions } from './memory-candidate-detector.js'
import { storeMemoryCandidates, type AgentMemoryCandidate } from './memory-consolidator.js'

export async function consolidateAgentMemoryCandidates(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  candidates: AgentMemoryCandidate[]
  title?: string
  message?: string
}) {
  const storedMemories = await storeMemoryCandidates({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
    runId: input.runId,
    candidates: input.candidates,
  })
  if (storedMemories.length === 0) return storedMemories

  await addRunEvent(input.db, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'memory_candidate_stored',
    title: input.title ?? '主动记忆候选已沉淀',
    message: input.message ?? `已从本轮运行沉淀 ${storedMemories.length} 条带证据的记忆候选。`,
    status: 'info',
    data: {
      memoryIds: storedMemories.map((memory) => memory.id),
      memoryCount: storedMemories.length,
      memoryTypes: storedMemories.map((memory) => memory.memory_type),
      statuses: storedMemories.map((memory) => memory.status),
    },
  })
  return storedMemories
}

export async function consolidateExecutedActionMemory(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  actionRows: Row<'agent_action_requests'>[]
  message?: string
}) {
  return consolidateAgentMemoryCandidates({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
    runId: input.runId,
    candidates: memoryCandidatesFromExecutedActions({ runId: input.runId, actionRows: input.actionRows }),
    title: '主动记忆已沉淀',
    ...(input.message ? { message: input.message } : {}),
  })
}

export async function flushThreadContextToMemoryIfNeeded(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
}) {
  const snapshot = await compactThreadContextIfNeeded({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
  })
  if (!snapshot) return null

  await addRunEvent(input.db, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'memory_context_flushed',
    title: '长对话上下文已压缩',
    message: '已把长对话摘要保存为当前线程的上下文快照，并作为带证据的工作记忆候选处理。',
    status: 'info',
    data: { snapshotId: snapshot.id, messageCount: snapshot.message_count },
  })

  await consolidateAgentMemoryCandidates({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
    runId: input.runId,
    candidates: [{
      kind: 'episode',
      scopeType: 'thread',
      memoryType: 'working',
      status: 'candidate',
      key: `thread.context_summary.${snapshot.id}`,
      value: `当前对话长上下文摘要：${snapshot.summary.slice(0, 420)}`,
      confidence: 0.66,
      evidence: { runId: input.runId, snapshotId: snapshot.id, messageCount: snapshot.message_count },
    }],
    title: '上下文摘要已进入记忆候选',
    message: '长对话压缩结果已作为当前线程工作记忆候选保存，后续召回仍受用户/工作区隔离限制。',
  })
  return snapshot
}
