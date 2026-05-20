import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { addMemoryEvent } from './memory-events.js'
import {
  containsSecretLikeContent,
  normalizeMemoryText,
  redactSecretLikeContent,
} from './memory-safety.js'

const COMPACTION_MESSAGE_THRESHOLD = 10
const COMPACTION_MESSAGE_STEP = 6
const MEMORY_VALUE_LIMIT = 500
const MEMORY_KEY_LIMIT = 120
const MEMORY_KINDS = new Set(['preference', 'fact', 'business_rule', 'workflow', 'episode', 'correction'])
const MEMORY_SCOPE_TYPES = new Set(['thread', 'workspace', 'user', 'procedural', 'commitment'])
const MEMORY_TYPES = new Set(['working', 'episodic', 'semantic', 'procedural', 'commitment'])
const MEMORY_STATUSES = new Set(['candidate', 'active', 'promoted', 'archived', 'rejected', 'expired'])
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
  return MEMORY_KINDS.has(kind) ? kind : 'preference'
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
  if (MEMORY_STATUSES.has(status)) return status
  return memoryType === 'semantic' || memoryType === 'procedural' ? 'promoted' : 'active'
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
  threadId: string
  messageId?: string | null
  runId?: string | null
  kind?: string | null
  scopeType?: string | null
  memoryType?: string | null
  status?: string | null
  sensitivity?: string | null
  key?: string | null
  value: string
  confidence?: number | null
  evidence?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}): Promise<RememberAgentMemoryResult> {
  const value = normalizeMemoryValue(input.value)
  if (!value || value.length < 3) return { memory: null, rejectedReason: 'empty' }
  if (containsSecretLikeContent(value)) return { memory: null, rejectedReason: 'secret' }
  const kind = normalizeMemoryKind(input.kind)
  const scopeType = normalizeMemoryScopeType(input.scopeType)
  const memoryType = normalizeMemoryType(input.memoryType)
  const status = normalizeMemoryStatus(input.status, memoryType)
  const sensitivity = normalizeMemorySensitivity(input.sensitivity)
  const key = normalizeMemoryKey(input.key, value, kind)
  const now = utcNow()
  const id = newId()
  await input.db
    .insertInto('agent_memories')
    .values({
      id,
      workspace_id: input.workspace.id,
      user_id: input.user.id,
      thread_id: input.threadId,
      kind,
      scope_type: scopeType,
      memory_type: memoryType,
      status,
      key,
      value,
      confidence: normalizeConfidence(input.confidence),
      sensitivity,
      source_message_id: input.messageId ?? null,
      source_run_id: input.runId ?? null,
      evidence_json: input.evidence ? JSON.stringify(input.evidence) : null,
      last_used_at: null,
      promoted_at: status === 'promoted' ? now : null,
      expires_at: null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .execute()
  await addMemoryEvent(input.db, {
    memoryId: id,
    workspaceId: input.workspace.id,
    userId: input.user.id,
    threadId: input.threadId,
    runId: input.runId ?? null,
    eventType: status === 'rejected' ? 'rejected' : 'captured',
    evidence: input.evidence ?? null,
    metadata: {
      source: input.metadata?.source ?? 'memory_store',
      kind,
      scopeType,
      memoryType,
      status,
      sensitivity,
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
    .where('archived_at', 'is', null)
    .where('status', '!=', 'rejected')
    .where('status', '!=', 'expired')
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
  await db.updateTable('agent_memories').set({ status: 'archived', archived_at: now, updated_at: now }).where('id', '=', memoryId).execute()
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
    status: row.status as never,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sensitivity: row.sensitivity as never,
    evidence: row.evidence_json ? parseJson<Record<string, unknown> | null>(row.evidence_json, null) : null,
    sourceRunId: row.source_run_id,
    lastUsedAt: row.last_used_at,
    promotedAt: row.promoted_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
