import type { Kysely } from 'kysely'
import { buildMemoryFlushPlan } from '@xox/agent-memory-core'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { addRunEvent } from './run-events.js'
import { compactThreadContextIfNeeded } from './memory.js'
import { memoryCandidatesFromExecutedActions } from './memory-candidate-detector.js'
import { storeMemoryCandidates, type AgentMemoryCandidate } from './memory-consolidator.js'
import { storeDailyMemoryNote } from './memory/daily-notes.js'

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

  const flushPlan = buildMemoryFlushPlan()
  const dailyNote = await storeDailyMemoryNote({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
    runId: input.runId,
    noteDate: flushPlan.noteDate,
    title: `对话压缩摘要 ${flushPlan.noteDate}`,
    content: `当前对话长上下文摘要：${snapshot.summary}`,
    evidence: {
      runId: input.runId,
      snapshotId: snapshot.id,
      messageCount: snapshot.message_count,
      source: 'openclaw_pre_compaction_flush',
    },
  })

  await addRunEvent(input.db, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'memory_context_flushed',
    title: '长对话上下文已压缩',
    message: '已按 OpenClaw-style pre-compaction flush 把长对话摘要保存为当前用户/工作区的日记忆，后续由 dreaming/promotion 决定是否晋升。',
    status: 'info',
    data: {
      snapshotId: snapshot.id,
      dailyNoteId: dailyNote?.id ?? null,
      noteDate: flushPlan.noteDate,
      messageCount: snapshot.message_count,
      source: 'openclaw_pre_compaction_flush',
    },
  })

  return snapshot
}
