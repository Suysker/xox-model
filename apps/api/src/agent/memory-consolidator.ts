import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { rememberAgentMemory } from './memory.js'

export type AgentMemoryCandidate = {
  kind: 'preference' | 'fact' | 'business_rule' | 'workflow' | 'episode' | 'correction'
  scopeType: 'thread' | 'workspace' | 'user' | 'procedural' | 'commitment'
  memoryType: 'working' | 'episodic' | 'semantic' | 'procedural' | 'commitment'
  status?: 'candidate' | 'active' | 'promoted'
  sensitivity?: 'normal' | 'private' | 'restricted'
  key: string
  value: string
  confidence: number
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
    const existing = await input.db
      .selectFrom('agent_memories')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where('key', '=', candidate.key)
      .where('archived_at', 'is', null)
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
      status: candidate.status ?? 'candidate',
      sensitivity: candidate.sensitivity ?? 'normal',
      key: candidate.key,
      value: candidate.value,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      metadata: { source: 'active_memory_consolidator' },
    })
    if (result.memory) stored.push(result.memory)
  }
  return stored
}
