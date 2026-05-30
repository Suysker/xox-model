import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { rememberAgentMemory } from './memory.js'
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
