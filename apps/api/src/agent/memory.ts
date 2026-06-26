import type { Kysely } from 'kysely'
import type { AgentRunEventStatus } from '@xox/contracts'
import {
  createAgentServerTenantMemoryCaptureRuntime,
  projectAgentServerTenantMemoryArchive,
  projectAgentServerTenantMemoryGet,
  projectAgentServerTenantMemoryPromotion,
  projectAgentServerTenantMemorySearch,
  rankAgentServerTenantMemoryRecords,
  type AgentServerTenantMemoryRecordLike,
  type AgentServerTenantMemoryToolItem,
} from '@agentic-os/server'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'

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

export type CaptureTenantMemoryResult =
  | { memory: Row<'agent_memories'>; rejectedReason: null }
  | { memory: null; rejectedReason: 'empty' | 'secret' }

export type CaptureTenantMemoryInput = {
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
}

const tenantMemoryCaptureRuntime = createAgentServerTenantMemoryCaptureRuntime<CaptureTenantMemoryInput, Row<'agent_memories'>>({
  persist: async ({ ctx: input, original, prepared }) => {
    const now = utcNow()
    const id = newId()
    await input.db
      .insertInto('agent_memories')
      .values({
        id,
        workspace_id: input.workspace.id,
        user_id: input.user.id,
        thread_id: input.threadId ?? null,
        kind: prepared.kind,
        scope_type: prepared.scopeType,
        memory_type: prepared.memoryType,
        lane: prepared.lane,
        status: prepared.status,
        key: prepared.key,
        value: prepared.value,
        confidence: prepared.confidence,
        evidence_score: prepared.evidenceScore,
        sensitivity: prepared.sensitivity,
        injectable: prepared.injectable ? 1 : 0,
        normalized_hash: prepared.normalizedHash,
        source_message_id: input.messageId ?? null,
        source_run_id: input.runId ?? null,
        source_kind: prepared.sourceKind,
        evidence_json: original.evidence ? JSON.stringify(original.evidence) : null,
        last_used_at: null,
        last_verified_at: prepared.lastVerifiedAt ?? null,
        promoted_at: prepared.promoted ? now : null,
        expires_at: prepared.expiresAt ?? null,
        superseded_by: prepared.supersededBy ?? null,
        metadata_json: original.metadata ? JSON.stringify(original.metadata) : null,
        created_at: now,
        updated_at: now,
        archived_at: prepared.archived ? now : null,
      })
      .execute()
    await addMemoryEvent(input.db, {
      memoryId: id,
      workspaceId: input.workspace.id,
      userId: input.user.id,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      eventType: prepared.status === 'rejected' ? 'rejected' : 'captured',
      evidence: original.evidence ?? null,
      metadata: {
        source: original.metadata?.source ?? 'memory_store',
        kind: prepared.kind,
        scopeType: prepared.scopeType,
        memoryType: prepared.memoryType,
        lane: prepared.lane,
        status: prepared.status,
        sensitivity: prepared.sensitivity,
        injectable: prepared.injectable,
        normalizedHash: prepared.normalizedHash,
        evidenceScore: prepared.evidenceScore,
        sourceKind: prepared.sourceKind,
        decision: prepared.decision,
        reason: prepared.reason,
      },
    })
    return input.db.selectFrom('agent_memories').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  },
})

export async function captureTenantMemory(input: CaptureTenantMemoryInput): Promise<CaptureTenantMemoryResult> {
  const result = await tenantMemoryCaptureRuntime.capture(input, input)
  return result.memory
    ? { memory: result.memory, rejectedReason: null }
    : { memory: null, rejectedReason: result.rejectedReason }
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

export type AgentMemoryRetrievalResult = {
  memory: Row<'agent_memories'>
  score: number
  reasons: string[]
}

function agentMemoryRecordFromRow(row: Row<'agent_memories'>): AgentServerTenantMemoryRecordLike {
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

  const ranked = rankAgentServerTenantMemoryRecords({
    records: rows,
    toRecordLike: agentMemoryRecordFromRow,
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
    memory: result.record,
    score: result.score,
    reasons: result.reasons,
  }))

  return ranked
}

export async function archiveAgentMemory(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, memoryId: string) {
  const memory = await db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirst()
  if (!memory) throw notFound('Agent memory not found')
  if (memory.workspace_id !== workspace.id || memory.user_id !== user.id) throw forbidden()
  const projected = projectAgentServerTenantMemoryArchive()
  const now = utcNow()
  await db.updateTable('agent_memories').set({
    status: projected.status,
    injectable: projected.injectable ? 1 : 0,
    archived_at: now,
    updated_at: now,
  }).where('id', '=', memoryId).execute()
  await addMemoryEvent(db, {
    memoryId,
    workspaceId: workspace.id,
    userId: user.id,
    threadId: memory.thread_id,
    runId: null,
    eventType: projected.eventType,
    evidence: { memoryId },
  })
}

export async function promoteAgentMemory(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, memoryId: string) {
  const memory = await db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirst()
  if (!memory) throw notFound('Agent memory not found')
  if (memory.workspace_id !== workspace.id || memory.user_id !== user.id) throw forbidden()
  const projected = projectAgentServerTenantMemoryPromotion({
    status: memory.status,
    lane: memory.lane,
    kind: memory.kind,
    memoryType: memory.memory_type,
  })
  if (!projected.ok) throw forbidden(projected.message)
  const now = utcNow()
  await db
    .updateTable('agent_memories')
    .set({
      lane: projected.lane,
      memory_type: projected.lane,
      status: projected.status,
      injectable: projected.injectable ? 1 : 0,
      promoted_at: now,
      updated_at: now,
      archived_at: projected.archivedAt,
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
    eventType: projected.eventType,
    evidence: { memoryId, source: 'user_memory_center' },
  })
  return db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirstOrThrow()
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

export type MemoryToolItem = AgentServerTenantMemoryToolItem

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

export function createXoxActiveMemoryProfileInput(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  appendRunEvent: (draft: {
    type: string
    title: string
    message: string
    status: AgentRunEventStatus
    data?: Record<string, unknown>
  }) => Promise<void>
}) {
  return {
    activeMemory: {
      getScopeKey: () => `${input.user.id}:${input.workspace.id}`,
      getRunCacheKey: (context: { run: { runId: string } }) => `${input.user.id}:${input.workspace.id}:${context.run.runId}`,
      getQuery: (context: { request: { userMessage: string } }) => context.request.userMessage,
      scope: () => ({
        tenantId: input.user.id,
        workspaceId: input.workspace.id,
        userId: input.user.id,
      }),
      retrieve: async (context: { request: { userMessage: string } }) => {
        const recalled = await retrieveAgentMemories({
          db: input.db,
          workspace: input.workspace,
          user: input.user,
          query: context.request.userMessage,
          limit: 6,
          forPrompt: true,
          includeCandidates: false,
          includeArchived: false,
          includeNonInjectable: false,
        })
        return recalled.map((item) => ({
          memory: {
            id: item.memory.id,
            key: item.memory.key,
            value: item.memory.value,
            kind: item.memory.kind,
            lane: item.memory.lane,
            status: item.memory.status,
          },
          memoryId: item.memory.id,
          text: `${item.memory.key}: ${item.memory.value}`,
          score: item.score,
          reasons: item.reasons,
          layer: layerForMemory(item.memory),
          evidenceRefs: rowEvidenceRefs(item.memory),
        }))
      },
      appendRunEvent: async (_context: unknown, draft: {
        type: string
        title: string
        message: string
        status: AgentRunEventStatus
        data?: Record<string, unknown>
      }) => {
        await input.appendRunEvent(draft)
      },
    },
  }
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
  const [durable, dailyNotes] = await Promise.all([
    input.includeDurable === false
      ? []
      : retrieveAgentMemories({
          db: input.db,
          workspace: input.workspace,
          user: input.user,
          query: input.query,
          limit: maxResults,
          includeCandidates: true,
          includeArchived: true,
          includeDiagnostics: false,
          includeNonInjectable: true,
        }),
    input.includeDailyNotes === false
      ? []
      : input.db
          .selectFrom('agent_memory_notes')
          .selectAll()
          .where('workspace_id', '=', input.workspace.id)
          .where('user_id', '=', input.user.id)
          .where('archived_at', 'is', null)
          .orderBy('updated_at', 'desc')
          .limit(80)
          .execute(),
  ])

  return projectAgentServerTenantMemorySearch({
    query: input.query,
    maxResults,
    durable: {
      records: durable.map((item) => ({
        record: item.memory,
        score: item.score,
        reasons: item.reasons,
      })),
      id: (memory) => memory.id,
      key: (memory) => memory.key,
      value: (memory) => memory.value,
      layer: layerForMemory,
      evidenceRefs: rowEvidenceRefs,
    },
    daily: {
      notes: dailyNotes,
      id: (note) => note.id,
      title: (note) => note.title,
      content: (note) => note.content,
      evidenceRefs: (note) => note.run_id ? [`run:${note.run_id}`] : [],
    },
  })
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
    return projectAgentServerTenantMemoryGet({
      durable: {
        record: memory,
        id: (row) => row.id,
        key: (row) => row.key,
        value: (row) => row.value,
        layer: layerForMemory,
        evidenceRefs: rowEvidenceRefs,
      },
    })
  }

  const note = await input.db
    .selectFrom('agent_memory_notes')
    .selectAll()
    .where('id', '=', input.memoryId)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  return projectAgentServerTenantMemoryGet({
    daily: {
      note,
      id: (row) => row.id,
      title: (row) => row.title,
      content: (row) => row.content,
      evidenceRefs: (row) => row.run_id ? [`run:${row.run_id}`] : [],
    },
  })
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
