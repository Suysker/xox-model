import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'

const COMPACTION_MESSAGE_THRESHOLD = 10
const COMPACTION_MESSAGE_STEP = 6
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /((?:api\s*key|apikey|token|secret|密码|验证码)\s*[:：=]?\s*)[^\s,，。；;]{4,}/gi,
]
const MEMORY_VALUE_LIMIT = 500
const MEMORY_KEY_LIMIT = 120
const MEMORY_KINDS = new Set(['preference', 'fact', 'business_rule', 'workflow'])

export type AgentRuntimeContext = {
  memories: Row<'agent_memories'>[]
  contextSummary: string | null
  recentMessages: Row<'agent_messages'>[]
}

export function redactSecretLikeContent(value: string) {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (match, label?: string) => (typeof label === 'string' ? `${label}[redacted-secret]` : '[redacted-api-key]')),
    value,
  )
}

function containsSecretLikeContent(value: string) {
  return redactSecretLikeContent(value) !== value || /(api\s*key|apikey|token|密码|验证码|secret)/i.test(value)
}

function normalizeMemoryValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, MEMORY_VALUE_LIMIT)
}

function normalizeMemoryKind(value: string | null | undefined) {
  const kind = typeof value === 'string' ? value.trim() : ''
  return MEMORY_KINDS.has(kind) ? kind : 'preference'
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
  kind?: string | null
  key?: string | null
  value: string
  confidence?: number | null
}): Promise<RememberAgentMemoryResult> {
  const value = normalizeMemoryValue(input.value)
  if (!value || value.length < 3) return { memory: null, rejectedReason: 'empty' }
  if (containsSecretLikeContent(value)) return { memory: null, rejectedReason: 'secret' }
  const kind = normalizeMemoryKind(input.kind)
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
      key,
      value,
      confidence: normalizeConfidence(input.confidence),
      source_message_id: input.messageId ?? null,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .execute()
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
    .orderBy('updated_at', 'desc')
    .execute()
}

export async function archiveAgentMemory(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, memoryId: string) {
  const memory = await db.selectFrom('agent_memories').selectAll().where('id', '=', memoryId).executeTakeFirst()
  if (!memory) throw notFound('Agent memory not found')
  if (memory.workspace_id !== workspace.id || memory.user_id !== user.id) throw forbidden()
  await db.updateTable('agent_memories').set({ archived_at: utcNow(), updated_at: utcNow() }).where('id', '=', memoryId).execute()
}

export async function loadAgentRuntimeContext(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
}): Promise<AgentRuntimeContext> {
  const [memories, snapshot, recentMessagesDesc] = await Promise.all([
    listAgentMemories(input.db, input.workspace, input.user),
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
    memories,
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
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
