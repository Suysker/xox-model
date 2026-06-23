import type { Kysely } from 'kysely'
import {
  applyMmr,
  buildMemoryCitation,
  containsSecretLikeContent,
  decideAgentMemoryCandidate,
  formatMemoryCitation,
  lexicalRelevance,
  normalizeAgentMemoryConfidence,
  normalizeAgentMemoryKey,
  normalizeAgentMemoryKind,
  normalizeAgentMemoryLane,
  normalizeAgentMemoryScopeType,
  normalizeAgentMemorySensitivity,
  normalizeAgentMemoryStatus,
  normalizeAgentMemoryType,
  normalizeAgentMemoryValue,
  rankAgentMemoryRecords,
  redactSecretLikeContent,
  type AgentMemoryRecordLike,
} from '@agentic-os/core'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import type { PlannerContext, ReadDraft, RuntimePlannerStep } from './host-profile/xox-planned-items.js'

export type AgentRuntimeContext = {
  memories: Row<'agent_memories'>[]
  contextSummary: string | null
  recentMessages: Row<'agent_messages'>[]
}

export { redactSecretLikeContent } from '@agentic-os/core'

export type AgentMemoryEventType = 'captured' | 'recalled' | 'injected' | 'promoted' | 'rejected' | 'archived' | 'expired'

export async function addMemoryEvent(
  db: Kysely<Database>,
  input: {
    memoryId?: string | null
    workspaceId: string
    userId: string
    threadId?: string | null
    runId?: string | null
    eventType: AgentMemoryEventType
    evidence?: Record<string, unknown> | null
    metadata?: Record<string, unknown> | null
  },
) {
  const id = newId()
  await db
    .insertInto('agent_memory_events')
    .values({
      id,
      memory_id: input.memoryId ?? null,
      workspace_id: input.workspaceId,
      user_id: input.userId,
      thread_id: input.threadId ?? null,
      run_id: input.runId ?? null,
      event_type: input.eventType,
      evidence_json: input.evidence ? jsonString(input.evidence) : null,
      metadata_json: input.metadata ? jsonString(input.metadata) : null,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_memory_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function countMemoryEvents(db: Kysely<Database>, memoryId: string, eventType: AgentMemoryEventType) {
  const row = await db
    .selectFrom('agent_memory_events')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('memory_id', '=', memoryId)
    .where('event_type', '=', eventType)
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

export function serializeMemoryEvent(row: Row<'agent_memory_events'>) {
  return {
    id: row.id,
    memoryId: row.memory_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    threadId: row.thread_id,
    runId: row.run_id,
    eventType: row.event_type,
    evidence: row.evidence_json ? parseJson<Record<string, unknown> | null>(row.evidence_json, null) : null,
    metadata: row.metadata_json ? parseJson<Record<string, unknown> | null>(row.metadata_json, null) : null,
    createdAt: row.created_at,
  }
}

export type RememberAgentMemoryResult =
  | { memory: Row<'agent_memories'>; rejectedReason: null }
  | { memory: null; rejectedReason: 'empty' | 'secret' }

export async function rememberAgentMemory(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId?: string | null
  messageId?: string | null
  runId?: string | null
  kind?: string | null
  scopeType?: string | null
  memoryType?: string | null
  lane?: string | null
  status?: string | null
  injectable?: boolean | null
  sensitivity?: string | null
  key?: string | null
  value: string
  confidence?: number | null
  evidenceScore?: number | null
  sourceKind?: string | null
  expiresAt?: string | null
  supersededBy?: string | null
  lastVerifiedAt?: string | null
  evidence?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}): Promise<RememberAgentMemoryResult> {
  const value = normalizeAgentMemoryValue(input.value)
  if (!value || value.length < 3) return { memory: null, rejectedReason: 'empty' }
  if (containsSecretLikeContent(value)) return { memory: null, rejectedReason: 'secret' }
  const kind = normalizeAgentMemoryKind(input.kind)
  const scopeType = normalizeAgentMemoryScopeType(input.scopeType)
  const memoryType = normalizeAgentMemoryType(input.memoryType)
  const lane = input.lane ? normalizeAgentMemoryLane(input.lane, memoryType) : undefined
  const status = input.status ? normalizeAgentMemoryStatus(input.status, memoryType) : undefined
  const sensitivity = normalizeAgentMemorySensitivity(input.sensitivity)
  const key = normalizeAgentMemoryKey({
    fallbackValue: value,
    kind,
    ...(input.key !== undefined ? { key: input.key } : {}),
  })
  const confidence = normalizeAgentMemoryConfidence(input.confidence)
  const policy = decideAgentMemoryCandidate({
    kind,
    scopeType,
    memoryType,
    key,
    value,
    confidence,
    expiresAt: input.expiresAt ?? null,
    ...(status ? { status } : {}),
    ...(lane ? { lane } : {}),
    ...(input.injectable != null ? { injectable: input.injectable } : {}),
    ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
    ...(input.evidenceScore !== undefined ? { evidenceScore: input.evidenceScore } : {}),
  })
  if (policy.decision === 'reject') return { memory: null, rejectedReason: 'secret' }
  const now = utcNow()
  const id = newId()
  await input.db
    .insertInto('agent_memories')
    .values({
      id,
      workspace_id: input.workspace.id,
      user_id: input.user.id,
      thread_id: input.threadId ?? null,
      kind,
      scope_type: scopeType,
      memory_type: memoryType,
      lane: policy.lane,
      status: policy.status,
      key,
      value,
      confidence,
      evidence_score: policy.evidenceScore,
      sensitivity,
      injectable: policy.injectable ? 1 : 0,
      normalized_hash: policy.normalizedHash,
      source_message_id: input.messageId ?? null,
      source_run_id: input.runId ?? null,
      source_kind: policy.sourceKind,
      evidence_json: input.evidence ? JSON.stringify(input.evidence) : null,
      last_used_at: null,
      last_verified_at: input.lastVerifiedAt ?? null,
      promoted_at: policy.status === 'promoted' ? now : null,
      expires_at: policy.expiresAt,
      superseded_by: input.supersededBy ?? null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: now,
      updated_at: now,
      archived_at: policy.status === 'archived' ? now : null,
    })
    .execute()
  await addMemoryEvent(input.db, {
    memoryId: id,
      workspaceId: input.workspace.id,
      userId: input.user.id,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
    eventType: policy.status === 'rejected' ? 'rejected' : 'captured',
    evidence: input.evidence ?? null,
    metadata: {
      source: input.metadata?.source ?? 'memory_store',
      kind,
      scopeType,
      memoryType,
      lane: policy.lane,
      status: policy.status,
      sensitivity,
      injectable: policy.injectable,
      normalizedHash: policy.normalizedHash,
      evidenceScore: policy.evidenceScore,
      sourceKind: policy.sourceKind,
      decision: policy.decision,
      reason: policy.reason,
    },
  })
  return {
    memory: await input.db.selectFrom('agent_memories').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    rejectedReason: null,
  }
}

export async function listAgentMemories(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser) {
  return db
    .selectFrom('agent_memories')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('user_id', '=', user.id)
    .where('status', '!=', 'rejected')
    .orderBy('updated_at', 'desc')
    .execute()
}

export async function touchAgentMemories(db: Kysely<Database>, memories: Row<'agent_memories'>[]) {
  if (memories.length === 0) return
  await db
    .updateTable('agent_memories')
    .set({ last_used_at: utcNow(), updated_at: utcNow() })
    .where('id', 'in', memories.map((memory) => memory.id))
    .execute()
}

export type AgentMemoryRetrievalResult = {
  memory: Row<'agent_memories'>
  score: number
  reasons: string[]
}

function agentMemoryRecordFromRow(row: Row<'agent_memories'>): AgentMemoryRecordLike {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    kind: row.kind,
    scopeType: row.scope_type,
    memoryType: row.memory_type,
    lane: row.lane,
    status: row.status,
    confidence: row.confidence,
    injectable: Number(row.injectable) === 1,
    threadId: row.thread_id,
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export async function retrieveAgentMemories(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query: string
  limit?: number
  includeCandidates?: boolean
  includeArchived?: boolean
  includeNonInjectable?: boolean
  includeDiagnostics?: boolean
  forPrompt?: boolean
  threadId?: string | null
}): Promise<AgentMemoryRetrievalResult[]> {
  const rows = await input.db
    .selectFrom('agent_memories')
    .selectAll()
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .orderBy('updated_at', 'desc')
    .limit(80)
    .execute()

  const rowsById = new Map(rows.map((row) => [row.id, row]))
  const ranked = rankAgentMemoryRecords({
    records: rows.map(agentMemoryRecordFromRow),
    query: input.query,
    now: utcNow(),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.includeCandidates !== undefined ? { includeCandidates: input.includeCandidates } : {}),
    ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
    ...(input.includeNonInjectable !== undefined ? { includeNonInjectable: input.includeNonInjectable } : {}),
    ...(input.includeDiagnostics !== undefined ? { includeDiagnostics: input.includeDiagnostics } : {}),
    ...(input.forPrompt !== undefined ? { forPrompt: input.forPrompt } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  }).map((result) => ({
    memory: rowsById.get(result.record.id)!,
    score: result.score,
    reasons: result.reasons,
  }))

  return ranked
}

export async function markAgentMemoriesRecalled(input: {
  db: Kysely<Database>
  memories: Row<'agent_memories'>[]
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  query: string
  retrieval?: Array<{ memoryId: string; score: number; reasons: string[] }>
}) {
  if (input.memories.length === 0) return []
  await touchAgentMemories(input.db, input.memories)
  for (const memory of input.memories) {
    await addMemoryEvent(input.db, {
      memoryId: memory.id,
      workspaceId: input.workspace.id,
      userId: input.user.id,
      threadId: input.threadId,
      runId: input.runId,
      eventType: 'recalled',
      evidence: { query: redactSecretLikeContent(input.query).slice(0, 500) },
      metadata: { memoryType: memory.memory_type, status: memory.status },
    })
  }
  return []
}

export async function archiveAgentMemory(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, memoryId: string) {
  const memory = await db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirst()
  if (!memory) throw notFound('Agent memory not found')
  if (memory.workspace_id !== workspace.id || memory.user_id !== user.id) throw forbidden()
  const now = utcNow()
  await db.updateTable('agent_memories').set({ status: 'archived', injectable: 0, archived_at: now, updated_at: now }).where('id', '=', memoryId).execute()
  await addMemoryEvent(db, {
    memoryId,
    workspaceId: workspace.id,
    userId: user.id,
    threadId: memory.thread_id,
    runId: null,
    eventType: 'archived',
    evidence: { memoryId },
  })
}

export async function promoteAgentMemory(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, memoryId: string) {
  const memory = await db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirst()
  if (!memory) throw notFound('Agent memory not found')
  if (memory.workspace_id !== workspace.id || memory.user_id !== user.id) throw forbidden()
  if (memory.lane === 'diagnostic' || memory.kind === 'diagnostic') throw forbidden('Diagnostic memories cannot be promoted into prompt context')
  if (memory.status !== 'candidate') throw forbidden('Only candidate memories can be promoted')
  const lane = memory.lane === 'procedural' || memory.memory_type === 'procedural' ? 'procedural' : 'semantic'
  const now = utcNow()
  await db
    .updateTable('agent_memories')
    .set({
      lane,
      memory_type: lane,
      status: 'promoted',
      injectable: 1,
      promoted_at: now,
      updated_at: now,
      archived_at: null,
      last_verified_at: now,
    })
    .where('id', '=', memoryId)
    .execute()
  await addMemoryEvent(db, {
    memoryId,
    workspaceId: workspace.id,
    userId: user.id,
    threadId: memory.thread_id,
    runId: null,
    eventType: 'promoted',
    evidence: { memoryId, source: 'user_memory_center' },
  })
  return db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirstOrThrow()
}

export async function loadAgentRuntimeContext(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
}): Promise<AgentRuntimeContext> {
  const [snapshot, recentMessagesDesc] = await Promise.all([
    input.db
      .selectFrom('agent_context_snapshots')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where('thread_id', '=', input.threadId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst(),
    input.db
      .selectFrom('agent_messages')
      .selectAll()
      .where('thread_id', '=', input.threadId)
      .orderBy('created_at', 'desc')
      .limit(8)
      .execute(),
  ])
  return {
    memories: [],
    contextSummary: snapshot?.summary ?? null,
    recentMessages: recentMessagesDesc.reverse().map((message) => ({
      ...message,
      content: redactSecretLikeContent(message.content),
    })),
  }
}

export function serializeMemory(row: Row<'agent_memories'>) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    threadId: row.thread_id,
    kind: row.kind,
    scopeType: row.scope_type as never,
    memoryType: row.memory_type as never,
    lane: row.lane as never,
    status: row.status as never,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    evidenceScore: row.evidence_score,
    sensitivity: row.sensitivity as never,
    injectable: Number(row.injectable) === 1,
    normalizedHash: row.normalized_hash,
    sourceKind: row.source_kind,
    evidence: row.evidence_json ? parseJson<Record<string, unknown> | null>(row.evidence_json, null) : null,
    sourceRunId: row.source_run_id,
    lastUsedAt: row.last_used_at,
    lastVerifiedAt: row.last_verified_at,
    promotedAt: row.promoted_at,
    expiresAt: row.expires_at,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function storeDailyMemoryNote(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId?: string | null
  runId?: string | null
  noteDate?: string
  title: string
  content: string
  evidence?: Record<string, unknown> | null
}) {
  const content = redactSecretLikeContent(input.content).replace(/\s+/g, ' ').trim().slice(0, 4000)
  if (!content) return null
  const now = utcNow()
  const id = newId()
  await input.db.insertInto('agent_memory_notes').values({
    id,
    workspace_id: input.workspace.id,
    user_id: input.user.id,
    thread_id: input.threadId ?? null,
    run_id: input.runId ?? null,
    note_date: input.noteDate ?? now.slice(0, 10),
    layer: 'daily',
    title: input.title.slice(0, 180),
    content,
    evidence_json: input.evidence ? JSON.stringify(input.evidence) : null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }).execute()
  return input.db.selectFrom('agent_memory_notes').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function listDailyMemoryNotes(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  limit?: number
}) {
  return input.db
    .selectFrom('agent_memory_notes')
    .selectAll()
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('archived_at', 'is', null)
    .orderBy('updated_at', 'desc')
    .limit(Math.max(1, Math.min(100, input.limit ?? 30)))
    .execute()
}

export type MemoryToolItem = {
  memoryId: string
  layer: 'durable' | 'daily' | 'dream' | 'signal' | 'diagnostic'
  title: string
  snippet: string
  score?: number
  citations: ReturnType<typeof buildMemoryCitation>[]
}

function layerForMemory(memory: Row<'agent_memories'>): MemoryToolItem['layer'] {
  if (memory.lane === 'diagnostic' || memory.kind === 'diagnostic') return 'diagnostic'
  return 'durable'
}

function rowEvidenceRefs(row: Row<'agent_memories'>) {
  const evidence = row.evidence_json ? parseJson<Record<string, unknown> | null>(row.evidence_json, null) : null
  return [
    row.source_run_id ? `run:${row.source_run_id}` : null,
    typeof evidence?.actionRequestId === 'string' ? `action:${evidence.actionRequestId}` : null,
    typeof evidence?.auditLogId === 'string' ? `audit:${evidence.auditLogId}` : null,
  ].filter((item): item is string => Boolean(item))
}

export async function searchTenantMemory(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query: string
  maxResults?: number
  includeDailyNotes?: boolean
  includeDurable?: boolean
}) {
  const maxResults = Math.max(1, Math.min(50, input.maxResults ?? 8))
  const items: Array<MemoryToolItem & { id: string; key: string; value: string; score: number }> = []
  if (input.includeDurable !== false) {
    const memories = await retrieveAgentMemories({
      db: input.db,
      workspace: input.workspace,
      user: input.user,
      query: input.query,
      limit: maxResults,
      includeCandidates: true,
      includeArchived: true,
      includeDiagnostics: false,
      includeNonInjectable: true,
    })
    for (const result of memories) {
      const layer = layerForMemory(result.memory)
      items.push({
        id: result.memory.id,
        key: result.memory.key,
        value: result.memory.value,
        memoryId: result.memory.id,
        layer,
        title: result.memory.key,
        snippet: redactSecretLikeContent(result.memory.value).slice(0, 800),
        score: result.score,
        citations: [buildMemoryCitation({
          memoryId: result.memory.id,
          layer,
          score: result.score,
          evidenceRefs: rowEvidenceRefs(result.memory),
        })],
      })
    }
  }

  if (input.includeDailyNotes !== false) {
    const notes = await input.db
      .selectFrom('agent_memory_notes')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where('archived_at', 'is', null)
      .orderBy('updated_at', 'desc')
      .limit(80)
      .execute()
    for (const note of notes) {
      const relevance = lexicalRelevance(input.query, `${note.title} ${note.content}`)
      if (relevance.score < 0.15 && relevance.reasons.length === 0) continue
      items.push({
        id: note.id,
        key: note.title,
        value: note.content,
        memoryId: note.id,
        layer: 'daily',
        title: note.title,
        snippet: redactSecretLikeContent(note.content).slice(0, 800),
        score: Number(relevance.score.toFixed(4)),
        citations: [buildMemoryCitation({
          memoryId: note.id,
          layer: 'daily',
          score: Number(relevance.score.toFixed(4)),
          evidenceRefs: note.run_id ? [`run:${note.run_id}`] : [],
        })],
      })
    }
  }

  const ranked = applyMmr(items.toSorted((left, right) => right.score - left.score))
    .slice(0, maxResults)
  return {
    items: ranked.map(({ id: _id, key: _key, value: _value, ...item }) => item),
  }
}

export async function getTenantMemory(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  memoryId: string
}) {
  const memory = await input.db
    .selectFrom('agent_memories')
    .selectAll()
    .where('id', '=', input.memoryId)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .executeTakeFirst()
  if (memory) {
    const layer = layerForMemory(memory)
    const score = 1
    return {
      item: {
        memoryId: memory.id,
        layer,
        title: memory.key,
        snippet: redactSecretLikeContent(memory.value).slice(0, 2000),
        score,
        citations: [buildMemoryCitation({ memoryId: memory.id, layer, score, evidenceRefs: rowEvidenceRefs(memory) })],
      },
    }
  }

  const note = await input.db
    .selectFrom('agent_memory_notes')
    .selectAll()
    .where('id', '=', input.memoryId)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!note) return { item: null }
  return {
    item: {
      memoryId: note.id,
      layer: 'daily' as const,
      title: note.title,
      snippet: redactSecretLikeContent(note.content).slice(0, 2000),
      score: 1,
      citations: [buildMemoryCitation({ memoryId: note.id, layer: 'daily', score: 1, evidenceRefs: note.run_id ? [`run:${note.run_id}`] : [] })],
    },
  }
}

export function summarizeMemoryToolItems(items: MemoryToolItem[]) {
  if (items.length === 0) return '没有找到相关记忆。'
  return items.map((item, index) => {
    const citations = item.citations.map(formatMemoryCitation).join(' ')
    return `${index + 1}. ${item.title}: ${item.snippet}${citations ? ` ${citations}` : ''}`
  }).join('\n')
}

function maxResultsFromStep(step: RuntimePlannerStep) {
  const explicit = typeof step.maxResults === 'number'
    ? step.maxResults
    : typeof step.limit === 'number'
      ? step.limit
      : null
  return Math.max(1, Math.min(20, explicit ?? 8))
}

export async function runMemorySearchTool(ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const query = typeof step.query === 'string' && step.query.trim()
    ? step.query.trim()
    : typeof step.question === 'string' && step.question.trim()
      ? step.question.trim()
      : ctx.message
  const result = await searchTenantMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    query,
    maxResults: maxResultsFromStep(step),
    includeDailyNotes: step.includeDailyNotes !== false,
    includeDurable: step.includeDurable !== false,
  })
  return {
    title: '搜索记忆',
    message: summarizeMemoryToolItems(result.items),
    readKind: 'tool_observation',
    displayPreview: result.items.length > 0 ? `找到 ${result.items.length} 条相关记忆。` : '没有找到相关记忆。',
    status: 'executed',
  }
}

export async function runMemoryGetTool(ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const memoryId = typeof step.memoryId === 'string'
    ? step.memoryId
    : typeof step.id === 'string'
      ? step.id
      : ''
  if (!memoryId) {
    return {
      title: '读取记忆',
      message: '缺少 memoryId，无法读取记忆。',
      readKind: 'tool_observation',
      status: 'info',
    }
  }
  const result = await getTenantMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    memoryId,
  })
  return {
    title: '读取记忆',
    message: result.item ? summarizeMemoryToolItems([result.item]) : '没有找到这条记忆，或当前用户/工作区无权读取。',
    readKind: 'tool_observation',
    displayPreview: result.item ? result.item.title : '未找到记忆。',
    status: result.item ? 'executed' : 'info',
  }
}

function textMatches(value: string, query: string) {
  if (!query) return true
  return value.toLowerCase().includes(query.toLowerCase())
}

function serializeDailyNote(note: Row<'agent_memory_notes'>) {
  return {
    id: note.id,
    workspaceId: note.workspace_id,
    userId: note.user_id,
    threadId: note.thread_id,
    runId: note.run_id,
    noteDate: note.note_date,
    layer: note.layer,
    title: note.title,
    content: note.content,
    evidence: note.evidence_json ? parseJson<Record<string, unknown> | null>(note.evidence_json, null) : null,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    archivedAt: note.archived_at,
  }
}

function serializeRecallSignal(signal: Row<'agent_memory_recall_signals'>) {
  const queryHashes = parseJson<string[]>(signal.query_hashes_json, [])
  const recallDays = parseJson<string[]>(signal.recall_days_json, [])
  return {
    id: signal.id,
    memoryId: signal.memory_id,
    workspaceId: signal.workspace_id,
    userId: signal.user_id,
    recallCount: signal.recall_count,
    totalScore: signal.total_score,
    maxScore: signal.max_score,
    queryCount: queryHashes.length,
    recallDayCount: recallDays.length,
    firstRecalledAt: signal.first_recalled_at,
    lastRecalledAt: signal.last_recalled_at,
    promotedAt: signal.promoted_at,
    metadata: signal.metadata_json ? parseJson<Record<string, unknown> | null>(signal.metadata_json, null) : null,
  }
}

function serializeDreamReport(report: Row<'agent_memory_dream_reports'>) {
  return {
    id: report.id,
    workspaceId: report.workspace_id,
    userId: report.user_id,
    threadId: report.thread_id,
    runId: report.run_id,
    status: report.status,
    title: report.title,
    summary: report.summary,
    candidateIds: parseJson<string[]>(report.candidate_ids_json, []),
    promotedIds: parseJson<string[]>(report.promoted_ids_json, []),
    score: parseJson<unknown[]>(report.score_json, []),
    createdAt: report.created_at,
    updatedAt: report.updated_at,
  }
}

export async function buildTenantMemoryCenterState(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query?: string
  lane?: string
  status?: string
}) {
  const search = input.query?.trim() ?? ''
  const memories = search
    ? (await retrieveAgentMemories({
        db: input.db,
        workspace: input.workspace,
        user: input.user,
        query: search,
        limit: 50,
        includeCandidates: true,
        includeArchived: true,
        includeDiagnostics: true,
        includeNonInjectable: true,
      })).map((result) => result.memory)
    : await listAgentMemories(input.db, input.workspace, input.user)
  const filteredMemories = memories
    .filter((memory) => !input.lane || memory.lane === input.lane)
    .filter((memory) => !input.status || memory.status === input.status)

  const [dailyNotes, recallSignals, dreamReports] = await Promise.all([
    listDailyMemoryNotes({
      db: input.db,
      workspace: input.workspace,
      user: input.user,
      limit: 100,
    }),
    input.db
      .selectFrom('agent_memory_recall_signals')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .orderBy('last_recalled_at', 'desc')
      .limit(100)
      .execute(),
    input.db
      .selectFrom('agent_memory_dream_reports')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute(),
  ])

  const visibleDailyNotes = dailyNotes
    .filter((note) => textMatches(`${note.title} ${note.content}`, search))

  return {
    memories: filteredMemories.map(serializeMemory),
    dailyNotes: visibleDailyNotes.map(serializeDailyNote),
    recallSignals: recallSignals.map(serializeRecallSignal),
    dreamReports: dreamReports.map(serializeDreamReport),
  }
}
