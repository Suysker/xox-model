import { parseJson } from '../../db/database.js'
import type { Database, Row } from '../../db/schema.js'
import type { Kysely } from 'kysely'
import type { CurrentUser } from '../../modules/auth.js'
import { listAgentMemories, serializeMemory } from '../memory.js'
import { retrieveAgentMemories } from '../memory-retriever.js'
import { listDailyMemoryNotes } from './daily-notes.js'

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
