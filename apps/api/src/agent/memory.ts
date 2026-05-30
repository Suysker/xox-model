import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { addMemoryEvent } from './memory-events.js'
import {
  decideMemoryCandidate,
  type AgentMemoryKind,
  type AgentMemoryLane,
  type AgentMemoryStatus,
} from './memory-promotion-policy.js'
import {
  containsSecretLikeContent,
  normalizeMemoryText,
  redactSecretLikeContent,
} from './memory-safety.js'

const COMPACTION_MESSAGE_THRESHOLD = 10
const COMPACTION_MESSAGE_STEP = 6
const MEMORY_VALUE_LIMIT = 500
const MEMORY_KEY_LIMIT = 120
const MEMORY_KINDS = new Set(['preference', 'fact', 'business_fact', 'business_rule', 'workflow', 'episode', 'correction', 'diagnostic'])
const MEMORY_SCOPE_TYPES = new Set(['thread', 'workspace', 'user', 'procedural', 'commitment'])
const MEMORY_TYPES = new Set(['working', 'episodic', 'semantic', 'procedural', 'commitment'])
const MEMORY_LANES = new Set(['working', 'session', 'semantic', 'procedural', 'episodic', 'diagnostic', 'archived'])
const MEMORY_STATUSES = new Set(['candidate', 'active', 'promoted', 'archived', 'rejected', 'expired', 'superseded'])
const MEMORY_SENSITIVITIES = new Set(['normal', 'private', 'restricted'])

export type AgentRuntimeContext = {
  memories: Row<'agent_memories'>[]
  contextSummary: string | null
  recentMessages: Row<'agent_messages'>[]
}

export { redactSecretLikeContent } from './memory-safety.js'

function normalizeMemoryValue(value: string) {
  return normalizeMemoryText(value, MEMORY_VALUE_LIMIT)
}

function normalizeMemoryKind(value: string | null | undefined) {
  const kind = typeof value === 'string' ? value.trim() : ''
  return (MEMORY_KINDS.has(kind) ? kind : 'preference') as AgentMemoryKind
}

function normalizeMemoryScopeType(value: string | null | undefined) {
  const scopeType = typeof value === 'string' ? value.trim() : ''
  return MEMORY_SCOPE_TYPES.has(scopeType) ? scopeType : 'workspace'
}

function normalizeMemoryType(value: string | null | undefined) {
  const memoryType = typeof value === 'string' ? value.trim() : ''
  return MEMORY_TYPES.has(memoryType) ? memoryType : 'semantic'
}

function normalizeMemoryStatus(value: string | null | undefined, memoryType: string) {
  const status = typeof value === 'string' ? value.trim() : ''
  if (MEMORY_STATUSES.has(status)) return status as AgentMemoryStatus
  return (memoryType === 'semantic' || memoryType === 'procedural' ? 'promoted' : 'active') as AgentMemoryStatus
}

function normalizeMemoryLane(value: string | null | undefined, memoryType: string): AgentMemoryLane | undefined {
  const lane = typeof value === 'string' ? value.trim() : ''
  if (MEMORY_LANES.has(lane)) return lane as AgentMemoryLane
  if (memoryType === 'working' || memoryType === 'episodic' || memoryType === 'semantic' || memoryType === 'procedural') return memoryType as AgentMemoryLane
  return undefined
}

function normalizeMemorySensitivity(value: string | null | undefined) {
  const sensitivity = typeof value === 'string' ? value.trim() : ''
  return MEMORY_SENSITIVITIES.has(sensitivity) ? sensitivity : 'normal'
}

function normalizeMemoryKey(value: string | null | undefined, fallbackValue: string, kind: string) {
  const key = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MEMORY_KEY_LIMIT) : ''
  if (key && !containsSecretLikeContent(key)) return key
  return `user.${kind}.${fallbackValue.slice(0, 32)}`
}

function normalizeConfidence(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.85
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
  const value = normalizeMemoryValue(input.value)
  if (!value || value.length < 3) return { memory: null, rejectedReason: 'empty' }
  if (containsSecretLikeContent(value)) return { memory: null, rejectedReason: 'secret' }
  const kind = normalizeMemoryKind(input.kind)
  const scopeType = normalizeMemoryScopeType(input.scopeType)
  const memoryType = normalizeMemoryType(input.memoryType)
  const lane = input.lane ? normalizeMemoryLane(input.lane, memoryType) : undefined
  const status = input.status ? normalizeMemoryStatus(input.status, memoryType) : undefined
  const sensitivity = normalizeMemorySensitivity(input.sensitivity)
  const key = normalizeMemoryKey(input.key, value, kind)
  const policy = decideMemoryCandidate({
    kind,
    scopeType,
    memoryType,
    key,
    value,
    confidence: normalizeConfidence(input.confidence),
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
      confidence: normalizeConfidence(input.confidence),
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

export async function compactThreadContextIfNeeded(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
}) {
  const [{ count }, latestSnapshot] = await Promise.all([
    input.db
      .selectFrom('agent_messages')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('thread_id', '=', input.threadId)
      .executeTakeFirstOrThrow(),
    input.db
      .selectFrom('agent_context_snapshots')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where('thread_id', '=', input.threadId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst(),
  ])

  const messageCount = Number(count)
  if (messageCount < COMPACTION_MESSAGE_THRESHOLD) return null
  if (latestSnapshot && messageCount - latestSnapshot.message_count < COMPACTION_MESSAGE_STEP) return null

  const messages = await input.db
    .selectFrom('agent_messages')
    .selectAll()
    .where('thread_id', '=', input.threadId)
    .orderBy('created_at', 'desc')
    .limit(12)
    .execute()
  const summary = messages
    .reverse()
    .map((message) => `${message.role}: ${redactSecretLikeContent(message.content).replace(/\s+/g, ' ').slice(0, 220)}`)
    .join('\n')
    .slice(0, 2400)

  const id = newId()
  await input.db
    .insertInto('agent_context_snapshots')
    .values({
      id,
      workspace_id: input.workspace.id,
      user_id: input.user.id,
      thread_id: input.threadId,
      summary,
      message_count: messageCount,
      created_at: utcNow(),
    })
    .execute()
  return input.db.selectFrom('agent_context_snapshots').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
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
