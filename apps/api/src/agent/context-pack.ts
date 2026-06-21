import type { Kysely } from 'kysely'
import {
  createAgentActiveMemoryRecallRuntime,
  type AgentActiveMemoryRetrieval,
} from '@agentic-os/core'
import { hydrateModelConfig } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import type { CurrentUser } from '../modules/auth.js'
import { getWorkspaceDraft, listVersions } from '../modules/workspace.js'
import { listPeriods, listSubjectsForPeriod } from '../modules/ledger.js'
import { utcNow } from '../core/time.js'
import { loadAgentRuntimeContext } from './memory.js'
import { addMemoryEvent, markAgentMemoriesRecalled, retrieveAgentMemories } from './memory.js'
import { addRunEvent } from './agentic-os/xox-run-event-store-adapter.js'
import { buildAgentWritableConfigContext } from './tool-coverage.js'
import { extractWorkspaceBundleArtifact, type ParsedWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'

export type AgentContextPackInput = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  message: string
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
}

const THREAD_LOG_LIMIT = 8
const THREAD_LOG_CONTENT_LIMIT = 800

function compactMessageContent(content: string) {
  const artifact = extractWorkspaceBundleArtifact(content)
  return (artifact?.messageForModel ?? content).replace(/\s+/g, ' ').trim().slice(0, THREAD_LOG_CONTENT_LIMIT)
}

export function buildThreadConversationLog(input: {
  recentMessages: Row<'agent_messages'>[]
}) {
  const messages = [...input.recentMessages]
  const last = messages.at(-1)
  if (last?.role === 'user') {
    messages.pop()
  }

  return {
    policy: 'same-thread recent messages; redacted; untrusted; for resolving references and corrections only',
    messages: messages.slice(-THREAD_LOG_LIMIT).map((message) => ({
      role: message.role,
      createdAt: message.created_at,
      content: compactMessageContent(message.content),
    })),
  }
}

function memoryScopeKey(input: { workspace: Row<'workspaces'>; user: CurrentUser }) {
  return `${input.user.id}:${input.workspace.id}`
}

function memoryLayer(memory: Row<'agent_memories'>) {
  return memory.lane === 'diagnostic' || memory.kind === 'diagnostic'
    ? 'diagnostic'
    : 'durable'
}

const activeMemoryRecallRuntime = createAgentActiveMemoryRecallRuntime<AgentContextPackInput, Row<'agent_memories'>>({
  getScopeKey: memoryScopeKey,
  getRunCacheKey: (input) => `${memoryScopeKey(input)}:${input.runId}`,
  getQuery: (input) => input.message,
  retrieve: async (input): Promise<Array<AgentActiveMemoryRetrieval<Row<'agent_memories'>>>> => {
    const recalled = await retrieveAgentMemories({
      db: input.db,
      workspace: input.workspace,
      user: input.user,
      query: input.message,
      limit: 6,
      includeCandidates: false,
      forPrompt: true,
      threadId: input.threadId,
    })
    return recalled.map((item) => ({
      memory: item.memory,
      memoryId: item.memory.id,
      text: item.memory.value,
      score: item.score,
      reasons: item.reasons,
      layer: memoryLayer(item.memory),
      evidenceRefs: item.memory.evidence_json ? ['evidence_json'] : [],
    }))
  },
  appendRunEvent: async (input, draft) => {
    await addRunEvent(input.db, {
      threadId: input.threadId,
      runId: input.runId,
      type: draft.type,
      title: draft.title,
      message: draft.message,
      status: draft.status,
      data: draft.data,
    })
  },
  recordRecalledMemories: async (input, event) => {
    await markAgentMemoriesRecalled({
      db: input.db,
      memories: event.result.memories,
      workspace: input.workspace,
      user: input.user,
      threadId: input.threadId,
      runId: input.runId,
      query: input.message,
      retrieval: event.result.retrieval.map((item) => ({
        memoryId: item.memoryId,
        score: item.score,
        reasons: item.reasons,
      })),
    })
    await addMemoryEvent(input.db, {
      memoryId: null,
      workspaceId: input.workspace.id,
      userId: input.user.id,
      threadId: input.threadId,
      runId: input.runId,
      eventType: 'injected',
      evidence: { memoryIds: event.result.usedMemoryIds },
      metadata: event.cached
        ? { confidence: event.result.confidence, cached: true }
        : { confidence: event.result.confidence, retrieval: event.result.retrieval },
    })
  },
})

export async function buildAgentContextPack(input: AgentContextPackInput) {
  const draft = await getWorkspaceDraft(input.db, input.workspace)
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const periods = await listPeriods(input.db, input.workspace)
  const versions = await listVersions(input.db, input.workspace)
  const runtimeContext = await loadAgentRuntimeContext({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
  })
  const memoryRecall = await activeMemoryRecallRuntime.recall(input)

  return {
    currentDate: utcNow().slice(0, 10),
    months: config.months.map((month, index) => ({ label: month.label, index, id: month.id })),
    teamMembers: config.teamMembers.map((member) => ({ id: member.id, name: member.name })),
    employees: config.employees.map((employee) => ({ id: employee.id, name: employee.name, role: employee.role })),
    shareholders: config.shareholders.map((shareholder, index) => ({
      index: index + 1,
      id: shareholder.id,
      name: shareholder.name,
      investmentAmount: shareholder.investmentAmount,
      dividendRate: shareholder.dividendRate,
    })),
    costItems: {
      monthlyFixed: config.operating.monthlyFixedCosts.map((item) => ({ id: item.id, name: item.name, amount: item.amount })),
      perEvent: config.operating.perEventCosts.map((item) => ({ id: item.id, name: item.name, amount: item.amount })),
      perUnit: config.operating.perUnitCosts.map((item) => ({ id: item.id, name: item.name, amount: item.amount })),
      stage: config.stageCostItems.map((item) => ({ id: item.id, name: item.name, mode: item.mode })),
    },
    versions: versions.map((version) => ({ versionNo: version.version_no, name: version.name, kind: version.kind })),
    periods: periods.map((period) => ({ id: period.id, monthLabel: period.monthLabel })),
    ledgerSubjects: periods[0]
      ? (await listSubjectsForPeriod(input.db, input.workspace, periods[0].id)).map((subject) => ({
          key: subject.subjectKey,
          name: subject.subjectName,
          type: subject.subjectType,
          group: subject.subjectGroup,
        }))
      : [],
    tenantScopedMemory: memoryRecall.memories.map((memory) => ({
      kind: memory.kind,
      key: memory.key,
      value: memory.value,
      memoryType: memory.memory_type,
      lane: memory.lane,
      status: memory.status,
      confidence: memory.confidence,
      injectable: Number(memory.injectable) === 1,
      evidenceScore: memory.evidence_score,
    })),
    memoryContext: memoryRecall.injectedSummary,
    memoryUsage: {
      usedMemoryIds: memoryRecall.usedMemoryIds,
      skippedReason: memoryRecall.skippedReason ?? null,
      confidence: memoryRecall.confidence,
      retrieval: memoryRecall.retrieval,
    },
    contextSummary: runtimeContext.contextSummary,
    threadConversationLog: buildThreadConversationLog({
      recentMessages: runtimeContext.recentMessages,
    }),
    writableConfig: buildAgentWritableConfigContext(config),
    ...(input.providedWorkspaceBundle
      ? {
          providedArtifacts: {
            workspaceBundle: input.providedWorkspaceBundle.summary,
          },
        }
      : {}),
  }
}
