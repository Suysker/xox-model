import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import {
  containsSecretLikeContent,
  normalizeSecretSafeText,
  redactSecretLikeContent,
} from '@agentic-os/core'
import {
  applyMmr,
  buildMemoryCitation,
  buildMemoryFlushPlan,
  formatMemoryCitation,
  lexicalRelevance,
  rankShortTermPromotionCandidates,
  type ShortTermRecallSignal,
} from '@xox/agent-memory-core'
import { agentServerRunLifecycleEvents } from '@agentic-os/server'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import type { PlannerContext, ReadDraft, RuntimePlannerStep } from './host-profile/xox-planned-items.js'
import { addRunEvent } from './agentic-os/xox-run-event-store-adapter.js'

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

export type AgentMemoryLane =
  | 'working'
  | 'session'
  | 'semantic'
  | 'procedural'
  | 'episodic'
  | 'diagnostic'
  | 'archived'

export type AgentMemoryStatus =
  | 'candidate'
  | 'active'
  | 'promoted'
  | 'archived'
  | 'rejected'
  | 'expired'
  | 'superseded'

export type AgentMemoryKind =
  | 'preference'
  | 'fact'
  | 'business_fact'
  | 'business_rule'
  | 'workflow'
  | 'episode'
  | 'correction'
  | 'diagnostic'

export type MemoryCandidateDecision =
  | 'store_candidate'
  | 'activate'
  | 'promote'
  | 'archive'
  | 'reject'
  | 'expire'
  | 'merge'
  | 'diagnostic_only'

export type MemoryPolicyInput = {
  kind: AgentMemoryKind
  scopeType: string
  memoryType: string
  lane?: AgentMemoryLane
  status?: AgentMemoryStatus
  injectable?: boolean
  sourceKind?: string | null
  key: string
  value: string
  confidence: number
  evidenceScore?: number | null
  expiresAt?: string | null
}

export type MemoryPolicyDecision = {
  kind: AgentMemoryKind
  lane: AgentMemoryLane
  status: AgentMemoryStatus
  injectable: boolean
  normalizedHash: string
  evidenceScore: number
  sourceKind: string
  expiresAt: string | null
  decision: MemoryCandidateDecision
  reason: string
  scoreBreakdown: {
    usefulness: number
    stability: number
    specificity: number
    safety: number
    evidence: number
    novelty: number
  }
}

export { redactSecretLikeContent } from '@agentic-os/core'

const PROMPT_INJECTABLE_LANES = new Set<AgentMemoryLane>(['working', 'semantic', 'procedural'])
const PROMPT_INJECTABLE_STATUSES = new Set<AgentMemoryStatus>(['active', 'promoted'])
const NON_INJECTABLE_STATUSES = new Set<AgentMemoryStatus>(['candidate', 'archived', 'rejected', 'expired', 'superseded'])

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 40)
}

export function normalizedMemoryHash(input: Pick<MemoryPolicyInput, 'kind' | 'scopeType' | 'key' | 'value'>) {
  const normalized = normalizeSecretSafeText(`${input.kind}:${input.scopeType}:${input.key}:${input.value}`, 800)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  return stableHash(normalized)
}

export function deriveMemoryLane(input: Pick<MemoryPolicyInput, 'kind' | 'memoryType' | 'lane' | 'sourceKind' | 'key' | 'value'>): AgentMemoryLane {
  if (input.lane) return input.lane
  if (input.kind === 'diagnostic' || input.sourceKind === 'evaluator_result' || input.key.startsWith('agent.evaluator.finding.')) return 'diagnostic'
  if (input.key.startsWith('agent.goal.completed.')) return 'episodic'
  if (input.key.startsWith('workspace.recent_related_entity.')) return 'working'
  if (input.memoryType === 'semantic' || input.memoryType === 'procedural' || input.memoryType === 'working' || input.memoryType === 'episodic') return input.memoryType
  if (input.kind === 'preference' || input.kind === 'business_fact' || input.kind === 'business_rule') return 'semantic'
  if (input.kind === 'workflow') return 'procedural'
  if (input.kind === 'episode' || input.kind === 'correction') return 'episodic'
  return 'semantic'
}

export function deriveMemoryStatus(input: Pick<MemoryPolicyInput, 'status' | 'kind' | 'lane' | 'memoryType' | 'sourceKind'> & { lane: AgentMemoryLane }): AgentMemoryStatus {
  if (input.status) return input.status
  if (input.lane === 'diagnostic') return 'active'
  if (input.lane === 'working') return 'active'
  if (input.lane === 'episodic') return 'archived'
  if (input.memoryType === 'semantic' || input.memoryType === 'procedural' || input.lane === 'semantic' || input.lane === 'procedural') return 'promoted'
  return 'candidate'
}

export function isMemoryPromptInjectable(row: Row<'agent_memories'>, options: { threadId?: string | null; now?: string } = {}) {
  const lane = row.lane as AgentMemoryLane
  const status = row.status as AgentMemoryStatus
  if (Number(row.injectable) !== 1) return false
  if (!PROMPT_INJECTABLE_LANES.has(lane)) return false
  if (!PROMPT_INJECTABLE_STATUSES.has(status)) return false
  if (NON_INJECTABLE_STATUSES.has(status)) return false
  if (lane === 'working') {
    if (!options.threadId || row.thread_id !== options.threadId) return false
    if (row.expires_at && Date.parse(row.expires_at) <= Date.parse(options.now ?? utcNow())) return false
  }
  return true
}

export function decideMemoryCandidate(input: MemoryPolicyInput): MemoryPolicyDecision {
  const lane = deriveMemoryLane(input)
  const status = deriveMemoryStatus({ ...input, lane })
  const sourceKind =
    input.sourceKind ??
    (lane === 'diagnostic'
      ? 'evaluator_result'
      : lane === 'episodic'
        ? 'confirmed_action'
        : lane === 'working'
          ? 'working_context'
          : 'manual_memory')
  const safety = containsSecretLikeContent(input.value) ? 0 : 1
  const evidence = clamp01(input.evidenceScore ?? (sourceKind === 'manual_memory' ? 0.9 : sourceKind === 'confirmed_action' ? 0.75 : 0.45))
  const stability =
    lane === 'semantic' || lane === 'procedural'
      ? 0.85
      : lane === 'working'
        ? 0.25
        : lane === 'diagnostic'
          ? 0.1
          : 0.35
  const specificity = normalizeSecretSafeText(input.value, 600).length >= 12 ? 0.8 : 0.35
  const usefulness = lane === 'semantic' || lane === 'procedural' ? 0.8 : lane === 'working' ? 0.55 : 0.35
  const novelty = 0.7
  const injectable =
    input.injectable ??
    (safety === 1 &&
      PROMPT_INJECTABLE_LANES.has(lane) &&
      PROMPT_INJECTABLE_STATUSES.has(status) &&
      sourceKind !== 'evaluator_result')

  let decision: MemoryCandidateDecision = 'store_candidate'
  let reason = 'stored as governed candidate'
  if (safety === 0) {
    decision = 'reject'
    reason = 'secret-like content is not eligible for memory'
  } else if (lane === 'diagnostic') {
    decision = 'diagnostic_only'
    reason = 'diagnostics are retained for audit but never injected into ordinary planning context'
  } else if (lane === 'episodic') {
    decision = 'archive'
    reason = 'episode is searchable evidence but not prompt-injectable by default'
  } else if (lane === 'working') {
    decision = 'activate'
    reason = 'working memory is scoped to the current thread and expiry'
  } else if (status === 'promoted') {
    decision = 'promote'
    reason = 'stable semantic/procedural memory is eligible for relevant recall'
  }

  return {
    kind: input.kind,
    lane,
    status,
    injectable,
    normalizedHash: normalizedMemoryHash(input),
    evidenceScore: evidence,
    sourceKind,
    expiresAt: input.expiresAt ?? null,
    decision,
    reason,
    scoreBreakdown: { usefulness, stability, specificity, safety, evidence, novelty },
  }
}

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

const WORKING_MEMORY_TTL_MS = 6 * 60 * 60 * 1000

function compactMemoryCandidateValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 420)
}

function memoryTtlFromNow(ms: number) {
  return new Date(Date.now() + ms).toISOString()
}

export function memoryCandidatesFromExecutedActions(input: {
  runId: string
  actionRows: Row<'agent_action_requests'>[]
}): AgentMemoryCandidate[] {
  const candidates: AgentMemoryCandidate[] = []
  for (const action of input.actionRows) {
    if (action.status !== 'executed') continue
    const payload = parseJson<any>(action.payload_json, {})
    if (action.kind === 'workspace.update_draft') {
      const config = payload?.config
      const memberCount = Array.isArray(config?.teamMembers) ? config.teamMembers.length : null
      const monthCount = Array.isArray(config?.months) ? config.months.length : null
      const shareholderCount = Array.isArray(config?.shareholders) ? config.shareholders.length : null
      const workspaceName = typeof payload?.workspaceName === 'string' ? payload.workspaceName : action.target_label
      candidates.push({
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        lane: 'episodic',
        status: 'archived',
        injectable: false,
        sourceKind: 'confirmed_action',
        key: `workspace.episode.${action.id}`,
        value: compactMemoryCandidateValue(`已通过 Agent 更新草稿：${workspaceName}，成员 ${memberCount ?? '未知'} 个，股东 ${shareholderCount ?? '未知'} 个，预测 ${monthCount ?? '未知'} 个月。`),
        confidence: 0.78,
        evidenceScore: 0.75,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
      if (payload?.source === 'workspace_configure_operating_model' && memberCount && monthCount) {
        candidates.push({
          kind: 'workflow',
          scopeType: 'procedural',
          memoryType: 'procedural',
          lane: 'procedural',
          status: 'promoted',
          injectable: true,
          sourceKind: 'confirmed_action',
          key: 'agent.workflow.operating_model_configured_by_high_level_tool',
          value: '完整经营简报应优先使用 workspace_configure_operating_model 生成一张可编辑草稿确认卡，再由 evaluator 检查成员、股东、成本和月份节奏。',
          confidence: 0.82,
          evidenceScore: 0.86,
          evidence: { runId: input.runId, actionRequestId: action.id, memberCount, monthCount },
        })
      }
      continue
    }

    if (action.kind.startsWith('ledger.')) {
      const relatedName = typeof payload?.relatedEntityName === 'string' ? payload.relatedEntityName : null
      const monthLabel = typeof payload?.monthLabel === 'string' ? payload.monthLabel : null
      const amount = typeof payload?.amount === 'number' ? payload.amount : null
      candidates.push({
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        lane: 'episodic',
        status: 'archived',
        injectable: false,
        sourceKind: 'confirmed_action',
        key: `ledger.episode.${action.id}`,
        value: compactMemoryCandidateValue(`已通过 Agent 执行账本动作：${action.title}${monthLabel ? `，账期 ${monthLabel}` : ''}${relatedName ? `，对象 ${relatedName}` : ''}${amount ? `，金额 ${amount}` : ''}。`),
        confidence: 0.72,
        evidenceScore: 0.75,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
      if (relatedName) {
        candidates.push({
          kind: 'fact',
          scopeType: 'thread',
          memoryType: 'working',
          lane: 'working',
          status: 'active',
          injectable: true,
          sourceKind: 'working_context',
          key: `workspace.recent_related_entity.${relatedName}`,
          value: compactMemoryCandidateValue(`最近一次 Agent 账本动作关联对象是 ${relatedName}。这只是短期情节记忆，不等于默认成员。`),
          confidence: 0.58,
          evidenceScore: 0.5,
          expiresAt: memoryTtlFromNow(WORKING_MEMORY_TTL_MS),
          evidence: { runId: input.runId, actionRequestId: action.id, relatedName },
        })
      }
      continue
    }

    if (action.kind.startsWith('workspace.') || action.kind.startsWith('share.')) {
      candidates.push({
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        lane: 'episodic',
        status: 'archived',
        injectable: false,
        sourceKind: 'confirmed_action',
        key: `workspace.episode.${action.id}`,
        value: compactMemoryCandidateValue(`已通过 Agent 执行业务动作：${action.title}。`),
        confidence: 0.7,
        evidenceScore: 0.75,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
    }
  }
  return candidates
}

export function memoryCandidateFromEditedAction(input: {
  runId: string
  action: Row<'agent_action_requests'>
}): AgentMemoryCandidate {
  return {
    kind: 'correction',
    scopeType: 'workspace',
    memoryType: 'procedural',
    lane: 'procedural',
    status: 'candidate',
    injectable: false,
    sourceKind: 'edited_confirmation',
    key: `agent.correction.action_edit.${input.action.id}`,
    value: compactMemoryCandidateValue(`用户编辑了 Agent 确认卡：${input.action.title}。后续相似动作应参考用户编辑后的确认卡内容，并继续通过确认卡执行。`),
    confidence: 0.68,
    evidenceScore: 0.72,
    evidence: { runId: input.runId, actionRequestId: input.action.id, actionKind: input.action.kind, lifecycle: 'edited' },
  }
}

export function memoryCandidateFromCancelledAction(input: {
  runId: string
  action: Row<'agent_action_requests'>
}): AgentMemoryCandidate {
  return {
    kind: 'correction',
    scopeType: 'workspace',
    memoryType: 'episodic',
    lane: 'diagnostic',
    status: 'active',
    injectable: false,
    sourceKind: 'cancelled_confirmation',
    key: `agent.correction.action_cancel.${input.action.id}`,
    value: compactMemoryCandidateValue(`用户取消了 Agent 确认卡：${input.action.title}。这表示该动作在当时上下文中不应继续自动推进。`),
    confidence: 0.62,
    evidenceScore: 0.62,
    evidence: { runId: input.runId, actionRequestId: input.action.id, actionKind: input.action.kind, lifecycle: 'cancelled' },
  }
}

export function memoryCandidateFromEvaluatorFinding(input: {
  runId: string
  evaluation: Row<'agent_evaluations'>
}): AgentMemoryCandidate | null {
  if (input.evaluation.status === 'pass') return null
  const unsatisfied = parseJson<Array<{ message?: string }>>(input.evaluation.unsatisfied_json, [])
  const firstFinding = unsatisfied.map((item) => item.message).find((message): message is string => Boolean(message))
  if (!firstFinding) return null
  return {
    kind: 'diagnostic',
    scopeType: 'procedural',
    memoryType: 'episodic',
    lane: 'diagnostic',
    status: 'active',
    injectable: false,
    sourceKind: 'evaluator_result',
    key: `agent.evaluator.finding.${input.evaluation.id}`,
    value: compactMemoryCandidateValue(`Loop Readiness Check 诊断：${firstFinding}`),
    confidence: 0.7,
    evidenceScore: 0.45,
    evidence: {
      runId: input.runId,
      evaluationId: input.evaluation.id,
      evaluationStatus: input.evaluation.status,
      iteration: input.evaluation.iteration_no,
    },
  }
}

export function memoryCandidateFromCompletedGoal(input: {
  goal: Row<'agent_goals'>
}): AgentMemoryCandidate | null {
  void input
  return null
}

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

function normalizeMemoryValue(value: string) {
  return normalizeSecretSafeText(value, MEMORY_VALUE_LIMIT)
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

type SearchableMemoryStatus = AgentMemoryStatus

const SEARCHABLE_MEMORY_STATUSES = new Set<SearchableMemoryStatus>(['candidate', 'active', 'promoted', 'archived', 'expired', 'superseded'])
const DEFAULT_PROMPT_LANE_LIMITS: Record<string, number> = {
  working: 3,
  semantic: 4,
  procedural: 3,
  episodic: 0,
  diagnostic: 0,
  archived: 0,
}

function normalizeMemorySearchText(value: string) {
  return redactSecretLikeContent(value).toLowerCase().replace(/\s+/g, ' ').trim()
}

function memoryAgeBoost(row: Row<'agent_memories'>) {
  const anchor = Date.parse(row.last_used_at ?? row.updated_at ?? row.created_at)
  if (!Number.isFinite(anchor)) return 0
  const days = Math.max(0, (Date.parse(utcNow()) - anchor) / 86_400_000)
  if (days <= 1) return 0.08
  if (days <= 7) return 0.04
  if (days <= 30) return 0.02
  return 0
}

function memoryStatusBoost(row: Row<'agent_memories'>) {
  if (row.status === 'promoted') return 0.16
  if (row.status === 'active') return 0.1
  return 0
}

function memoryTypeBoost(row: Row<'agent_memories'>) {
  if (row.lane === 'semantic' || row.lane === 'procedural') return 0.14
  if (row.lane === 'working') return 0.1
  if (row.lane === 'episodic') return 0.02
  return 0
}

function memoryScopeBoost(row: Row<'agent_memories'>) {
  if (row.scope_type === 'workspace') return 0.08
  if (row.scope_type === 'user' || row.scope_type === 'procedural') return 0.04
  if (row.scope_type === 'thread') return 0.02
  return 0
}

function scoreMemory(row: Row<'agent_memories'>, query: string): AgentMemoryRetrievalResult {
  const relevance = lexicalRelevance(query, `${row.key} ${row.kind} ${row.scope_type} ${row.memory_type} ${row.lane} ${row.value}`)
  const keyHit = normalizeMemorySearchText(row.key).includes(normalizeMemorySearchText(query)) && query.trim().length >= 3 ? 0.12 : 0
  const confidence = Math.max(0, Math.min(1, row.confidence)) * 0.18
  const score = relevance.score + keyHit + confidence + memoryStatusBoost(row) + memoryTypeBoost(row) + memoryScopeBoost(row) + memoryAgeBoost(row)
  const reasons = [
    ...relevance.reasons,
    keyHit > 0 ? 'key_match' : null,
    row.status === 'candidate' ? 'candidate_memory' : `${row.status}_memory`,
    row.injectable ? 'injectable' : 'non_injectable',
    row.lane,
    row.memory_type,
  ].filter((item): item is string => Boolean(item))
  return { memory: row, score: Number(score.toFixed(4)), reasons }
}

function applyPromptLaneBudgets(results: AgentMemoryRetrievalResult[]) {
  const counts = new Map<string, number>()
  return results.filter((result) => {
    const lane = result.memory.lane as AgentMemoryLane
    const limit = DEFAULT_PROMPT_LANE_LIMITS[lane] ?? 0
    const current = counts.get(lane) ?? 0
    if (current >= limit) return false
    counts.set(lane, current + 1)
    return true
  })
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

  const scored = rows
    .filter((row) => SEARCHABLE_MEMORY_STATUSES.has(row.status as SearchableMemoryStatus))
    .filter((row) => input.includeCandidates === true || row.status !== 'candidate')
    .filter((row) => input.includeArchived === true || !['archived', 'expired', 'superseded'].includes(row.status))
    .filter((row) => input.includeDiagnostics === true || row.lane !== 'diagnostic')
    .filter((row) => input.includeNonInjectable === true || input.forPrompt === true || Number(row.injectable) === 1)
    .filter((row) => !input.forPrompt || isMemoryPromptInjectable(row, { now: utcNow(), ...(input.threadId !== undefined ? { threadId: input.threadId } : {}) }))
    .map((row) => scoreMemory(row, input.query))
    .filter((result) => result.score >= 0.32 || result.reasons.some((reason) => reason.startsWith('token_overlap:')))
    .sort((left, right) => right.score - left.score)
  const ranked = applyMmr(
    (input.forPrompt ? applyPromptLaneBudgets(scored) : scored).map((result) => ({
      ...result,
      id: result.memory.id,
      key: result.memory.key,
      value: result.memory.value,
    })),
  )
    .map(({ id: _id, key: _key, value: _value, ...result }) => result)
    .slice(0, Math.max(1, Math.min(50, input.limit ?? 6)))

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
  const retrievalByMemoryId = new Map((input.retrieval ?? []).map((item) => [item.memoryId, item]))
  await recordMemoryRecallSignals({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    query: input.query,
    retrieval: input.memories.map((memory) => {
      const retrieval = retrievalByMemoryId.get(memory.id)
      return {
        memory,
        score: retrieval?.score ?? 0.5,
        reasons: retrieval?.reasons ?? ['recalled'],
      }
    }),
  })
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

function queryHash(query: string) {
  return createHash('sha256').update(query.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 32)
}

function uniqueLimited(values: string[], limit: number) {
  return [...new Set(values)].slice(-limit)
}

export async function recordMemoryRecallSignals(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query: string
  retrieval: Array<{ memory: Row<'agent_memories'>; score: number; reasons: string[] }>
}) {
  const now = utcNow()
  const day = now.slice(0, 10)
  const hash = queryHash(input.query)
  for (const item of input.retrieval) {
    const memory = item.memory
    if (memory.workspace_id !== input.workspace.id || memory.user_id !== input.user.id) continue
    if (memory.lane === 'diagnostic' || memory.status === 'archived' || memory.status === 'expired') continue

    const existing = await input.db
      .selectFrom('agent_memory_recall_signals')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where('memory_id', '=', memory.id)
      .executeTakeFirst()
    if (!existing) {
      await input.db.insertInto('agent_memory_recall_signals').values({
        id: newId(),
        memory_id: memory.id,
        workspace_id: input.workspace.id,
        user_id: input.user.id,
        recall_count: 1,
        total_score: item.score,
        max_score: item.score,
        query_hashes_json: JSON.stringify([hash]),
        recall_days_json: JSON.stringify([day]),
        first_recalled_at: now,
        last_recalled_at: now,
        promoted_at: null,
        metadata_json: JSON.stringify({ lastReasons: item.reasons }),
      }).execute()
      continue
    }

    const queryHashes = uniqueLimited([...parseJson<string[]>(existing.query_hashes_json, []), hash], 32)
    const recallDays = uniqueLimited([...parseJson<string[]>(existing.recall_days_json, []), day], 32)
    await input.db
      .updateTable('agent_memory_recall_signals')
      .set({
        recall_count: existing.recall_count + 1,
        total_score: existing.total_score + item.score,
        max_score: Math.max(existing.max_score, item.score),
        query_hashes_json: JSON.stringify(queryHashes),
        recall_days_json: JSON.stringify(recallDays),
        last_recalled_at: now,
        metadata_json: JSON.stringify({ lastReasons: item.reasons }),
      })
      .where('id', '=', existing.id)
      .execute()
  }
}

export async function listPromotionCandidatesFromSignals(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  limit?: number
}) {
  const rows = await input.db
    .selectFrom('agent_memory_recall_signals')
    .innerJoin('agent_memories', 'agent_memories.id', 'agent_memory_recall_signals.memory_id')
    .select([
      'agent_memory_recall_signals.id as signal_id',
      'agent_memory_recall_signals.memory_id as memory_id',
      'agent_memory_recall_signals.recall_count as recall_count',
      'agent_memory_recall_signals.total_score as total_score',
      'agent_memory_recall_signals.max_score as max_score',
      'agent_memory_recall_signals.query_hashes_json as query_hashes_json',
      'agent_memory_recall_signals.recall_days_json as recall_days_json',
      'agent_memory_recall_signals.first_recalled_at as first_recalled_at',
      'agent_memory_recall_signals.last_recalled_at as last_recalled_at',
      'agent_memory_recall_signals.promoted_at as signal_promoted_at',
      'agent_memories.value as value',
    ])
    .where('agent_memory_recall_signals.workspace_id', '=', input.workspace.id)
    .where('agent_memory_recall_signals.user_id', '=', input.user.id)
    .where('agent_memories.injectable', '=', 1)
    .where('agent_memories.lane', '!=', 'diagnostic')
    .execute()

  const signals: ShortTermRecallSignal[] = rows.map((row) => ({
    memoryId: row.memory_id,
    snippet: row.value,
    recallCount: row.recall_count,
    totalScore: row.total_score,
    maxScore: row.max_score,
    uniqueQueries: parseJson<string[]>(row.query_hashes_json, []).length,
    recallDays: parseJson<string[]>(row.recall_days_json, []),
    firstRecalledAt: row.first_recalled_at,
    lastRecalledAt: row.last_recalled_at,
    promotedAt: row.signal_promoted_at,
  }))
  return rankShortTermPromotionCandidates({ signals, limit: input.limit ?? 20 })
}

export async function runMemoryDreamingSweep(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId?: string | null
  runId?: string | null
  limit?: number
}) {
  const candidates = await listPromotionCandidatesFromSignals({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    limit: input.limit ?? 20,
  })
  const now = utcNow()
  const id = newId()
  const candidateIds = candidates.map((candidate) => candidate.memoryId)
  if (candidateIds.length === 0) return null
  await input.db.insertInto('agent_memory_dream_reports').values({
    id,
    workspace_id: input.workspace.id,
    user_id: input.user.id,
    thread_id: input.threadId ?? null,
    run_id: input.runId ?? null,
    status: 'review',
    title: 'OpenClaw-style memory dreaming sweep',
    summary: `发现 ${candidateIds.length} 条达到 OpenClaw-style recall/promotion 信号阈值的记忆候选，等待人工或策略复核。`,
    candidate_ids_json: JSON.stringify(candidateIds),
    promoted_ids_json: JSON.stringify([]),
    score_json: JSON.stringify(candidates.map((candidate) => ({
      memoryId: candidate.memoryId,
      score: candidate.score,
      components: candidate.components,
      recallCount: candidate.recallCount,
      uniqueQueries: candidate.uniqueQueries,
    }))),
    created_at: now,
    updated_at: now,
  }).execute()
  return input.db.selectFrom('agent_memory_dream_reports').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
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
