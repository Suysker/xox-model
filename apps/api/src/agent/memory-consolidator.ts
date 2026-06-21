import type { Kysely } from 'kysely'
import { buildMemoryFlushPlan } from '@xox/agent-memory-core'
import { agentServerRunLifecycleEvents } from '@agentic-os/server'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { compactThreadContextIfNeeded, rememberAgentMemory } from './memory.js'
import { addRunEvent } from './agentic-os/xox-run-event-store-adapter.js'
import { memoryCandidatesFromExecutedActions } from './memory-candidate-detector.js'
import { storeDailyMemoryNote } from './memory/daily-notes.js'
import {
  decideMemoryCandidate,
  type AgentMemoryKind,
  type AgentMemoryLane,
  type AgentMemoryStatus,
} from './memory-promotion-policy.js'

export type AgentMemoryCandidate = {
  kind: AgentMemoryKind
  scopeType: 'thread' | 'workspace' | 'user' | 'procedural' | 'commitment'
  memoryType: 'working' | 'episodic' | 'semantic' | 'procedural' | 'commitment'
  lane?: AgentMemoryLane
  status?: AgentMemoryStatus
  injectable?: boolean
  sensitivity?: 'normal' | 'private' | 'restricted'
  key: string
  value: string
  confidence: number
  evidenceScore?: number
  sourceKind?: string
  expiresAt?: string | null
  evidence: Record<string, unknown>
}

export async function storeMemoryCandidates(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  candidates: AgentMemoryCandidate[]
}) {
  const stored: Row<'agent_memories'>[] = []
  for (const candidate of input.candidates) {
    const decision = decideMemoryCandidate({
      kind: candidate.kind,
      scopeType: candidate.scopeType,
      memoryType: candidate.memoryType,
      key: candidate.key,
      value: candidate.value,
      confidence: candidate.confidence,
      expiresAt: candidate.expiresAt ?? null,
      ...(candidate.lane ? { lane: candidate.lane } : {}),
      ...(candidate.status ? { status: candidate.status } : {}),
      ...(candidate.injectable !== undefined ? { injectable: candidate.injectable } : {}),
      ...(candidate.sourceKind ? { sourceKind: candidate.sourceKind } : {}),
      ...(candidate.evidenceScore !== undefined ? { evidenceScore: candidate.evidenceScore } : {}),
    })
    if (decision.decision === 'reject') continue
    const existing = await input.db
      .selectFrom('agent_memories')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where((eb) => eb.or([
        eb('key', '=', candidate.key),
        eb('normalized_hash', '=', decision.normalizedHash),
      ]))
      .where('status', '!=', 'rejected')
      .where('status', '!=', 'expired')
      .executeTakeFirst()
    if (existing) continue
    const result = await rememberAgentMemory({
      db: input.db,
      workspace: input.workspace,
      user: input.user,
      threadId: input.threadId,
      runId: input.runId,
      kind: candidate.kind,
      scopeType: candidate.scopeType,
      memoryType: candidate.memoryType,
      lane: decision.lane,
      status: decision.status,
      injectable: decision.injectable,
      sensitivity: candidate.sensitivity ?? 'normal',
      key: candidate.key,
      value: candidate.value,
      confidence: candidate.confidence,
      evidenceScore: decision.evidenceScore,
      sourceKind: decision.sourceKind,
      expiresAt: decision.expiresAt,
      evidence: candidate.evidence,
      metadata: { source: 'active_memory_consolidator', decision: decision.decision, reason: decision.reason, scoreBreakdown: decision.scoreBreakdown },
    })
    if (result.memory) stored.push(result.memory)
  }
  return stored
}

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

  await addRunEvent(input.db, agentServerRunLifecycleEvents.memoryCandidateStored({
    threadId: input.threadId,
    runId: input.runId,
    memoryIds: storedMemories.map((memory) => memory.id),
    memoryCount: storedMemories.length,
    memoryTypes: storedMemories.map((memory) => memory.memory_type),
    statuses: storedMemories.map((memory) => memory.status),
    copy: {
      title: input.title ?? '主动记忆候选已沉淀',
      message: input.message ?? `已从本轮运行沉淀 ${storedMemories.length} 条带证据的记忆候选。`,
    },
  }))
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

  await addRunEvent(input.db, agentServerRunLifecycleEvents.memoryContextFlushed({
    threadId: input.threadId,
    runId: input.runId,
    snapshotId: snapshot.id,
    dailyNoteId: dailyNote?.id ?? null,
    noteDate: flushPlan.noteDate,
    messageCount: snapshot.message_count,
    source: 'openclaw_pre_compaction_flush',
    copy: {
      title: '长对话上下文已压缩',
      message: '已按 OpenClaw-style pre-compaction flush 把长对话摘要保存为当前用户/工作区的日记忆，后续由 dreaming/promotion 决定是否晋升。',
    },
  }))

  return snapshot
}
