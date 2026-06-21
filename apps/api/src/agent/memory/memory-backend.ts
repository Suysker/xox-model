import { applyMmr, buildMemoryCitation, formatMemoryCitation, lexicalRelevance } from '@xox/agent-memory-core'
import type { Kysely } from 'kysely'
import { parseJson } from '../../db/database.js'
import type { Database, Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { retrieveAgentMemories } from '../memory.js'
import { redactSecretLikeContent } from '@agentic-os/core'

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
