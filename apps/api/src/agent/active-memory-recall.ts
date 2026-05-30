import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { addRunEvent } from './run-events.js'
import { addMemoryEvent } from './memory-events.js'
import {
  markAgentMemoriesRecalled,
  retrieveAgentMemories,
  type AgentMemoryRetrievalResult,
} from './memory-retriever.js'
import { redactSecretLikeContent } from './memory-safety.js'

const ACTIVE_RECALL_TIMEOUT_MS = 1200
const ACTIVE_RECALL_CACHE_TTL_MS = 10_000
const ACTIVE_RECALL_RUN_CACHE_TTL_MS = 2 * 60 * 60 * 1000
const ACTIVE_RECALL_CIRCUIT_TIMEOUTS = 3
const ACTIVE_RECALL_CIRCUIT_COOLDOWN_MS = 60_000

type CacheEntry = {
  expiresAt: number
  result: ActiveMemoryRecallResult
}

const recallCache = new Map<string, CacheEntry>()
const recallCacheByRun = new Map<string, CacheEntry>()
const circuitByScope = new Map<string, { timeoutCount: number; openedAt: number | null }>()

export type ActiveMemoryRecallResult = {
  injectedSummary: string | null
  memories: Row<'agent_memories'>[]
  usedMemoryIds: string[]
  skippedReason?: 'disabled' | 'timeout' | 'circuit_open' | 'no_relevant_memory' | 'no_provider'
  confidence: number
  retrieval: Array<{ memoryId: string; score: number; reasons: string[] }>
}

function scopeKey(input: { workspace: Row<'workspaces'>; user: CurrentUser }) {
  return `${input.user.id}:${input.workspace.id}`
}

function cacheKey(input: { workspace: Row<'workspaces'>; user: CurrentUser; message: string }) {
  return `${scopeKey(input)}:${redactSecretLikeContent(input.message).slice(0, 240)}`
}

function runCacheKey(input: { workspace: Row<'workspaces'>; user: CurrentUser; runId: string }) {
  return `${scopeKey(input)}:${input.runId}`
}

function cacheRecallForRun(input: { workspace: Row<'workspaces'>; user: CurrentUser; runId: string }, result: ActiveMemoryRecallResult) {
  recallCacheByRun.set(runCacheKey(input), { expiresAt: Date.now() + ACTIVE_RECALL_RUN_CACHE_TTL_MS, result })
}

function circuitOpen(key: string) {
  const circuit = circuitByScope.get(key)
  if (!circuit?.openedAt) return false
  if (Date.now() - circuit.openedAt > ACTIVE_RECALL_CIRCUIT_COOLDOWN_MS) {
    circuitByScope.delete(key)
    return false
  }
  return true
}

function recordTimeout(key: string) {
  const current = circuitByScope.get(key) ?? { timeoutCount: 0, openedAt: null }
  const timeoutCount = current.timeoutCount + 1
  circuitByScope.set(key, {
    timeoutCount,
    openedAt: timeoutCount >= ACTIVE_RECALL_CIRCUIT_TIMEOUTS ? Date.now() : null,
  })
}

function recordSuccess(key: string) {
  circuitByScope.delete(key)
}

function buildSummary(results: AgentMemoryRetrievalResult[]) {
  if (results.length === 0) return null
  const lines = results.slice(0, 6).map((result, index) => {
    const memory = result.memory
    const value = redactSecretLikeContent(memory.value).replace(/\s+/g, ' ').trim()
    return `${index + 1}. [memory:${memory.id} lane=${memory.lane} kind=${memory.kind} status=${memory.status} evidence=${memory.evidence_json ? 'present' : 'none'}] ${value}`
  })
  return [
    '<memory_context trust="untrusted" scope="current_user_current_workspace">',
    ...lines,
    '</memory_context>',
  ].join('\n')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function recallActiveAgentMemory(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  message: string
}): Promise<ActiveMemoryRecallResult> {
  const cachedForRun = recallCacheByRun.get(runCacheKey(input))
  if (cachedForRun && cachedForRun.expiresAt > Date.now()) return cachedForRun.result

  const scopedKey = scopeKey(input)
  if (circuitOpen(scopedKey)) {
    await addRunEvent(input.db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'memory_recall_skipped',
      title: '主动记忆召回已跳过',
      message: '主动记忆召回熔断器处于冷却期，本轮不注入记忆。',
      status: 'info',
      data: { skippedReason: 'circuit_open' },
    })
    const result: ActiveMemoryRecallResult = { injectedSummary: null, memories: [], usedMemoryIds: [], skippedReason: 'circuit_open', confidence: 0, retrieval: [] }
    cacheRecallForRun(input, result)
    return result
  }

  const key = cacheKey(input)
  const cached = recallCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.result.memories.length > 0) {
      await markAgentMemoriesRecalled({
        db: input.db,
        memories: cached.result.memories,
        workspace: input.workspace,
        user: input.user,
        threadId: input.threadId,
        runId: input.runId,
        query: input.message,
      })
      await addMemoryEvent(input.db, {
        memoryId: null,
        workspaceId: input.workspace.id,
        userId: input.user.id,
        threadId: input.threadId,
        runId: input.runId,
        eventType: 'injected',
        evidence: { memoryIds: cached.result.usedMemoryIds },
        metadata: { confidence: cached.result.confidence, cached: true },
      })
      await addRunEvent(input.db, {
        threadId: input.threadId,
        runId: input.runId,
        type: 'memory_injected',
        title: '主动记忆已注入',
        message: `已从短期召回缓存注入 ${cached.result.memories.length} 条当前用户/工作区相关记忆。`,
        status: 'info',
        data: {
          memoryIds: cached.result.usedMemoryIds,
          memoryCount: cached.result.memories.length,
          confidence: cached.result.confidence,
          cached: true,
          retrieval: cached.result.retrieval,
        },
      })
    }
    cacheRecallForRun(input, cached.result)
    return cached.result
  }

  await addRunEvent(input.db, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'memory_recall_started',
    title: '主动记忆召回中',
    message: '正在按当前用户和当前工作区检索与本轮目标相关的记忆。',
    status: 'running',
    data: { scope: 'current_user_current_workspace' },
  })

  const recalled = await withTimeout(
    retrieveAgentMemories({
      db: input.db,
      workspace: input.workspace,
      user: input.user,
      query: input.message,
      limit: 6,
      includeCandidates: false,
      forPrompt: true,
      threadId: input.threadId,
    }),
    ACTIVE_RECALL_TIMEOUT_MS,
  )

  if (recalled === 'timeout') {
    recordTimeout(scopedKey)
    await addRunEvent(input.db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'memory_recall_completed',
      title: '主动记忆召回超时',
      message: '主动记忆召回超过预算，本轮不注入记忆。',
      status: 'info',
      data: { skippedReason: 'timeout', timeoutMs: ACTIVE_RECALL_TIMEOUT_MS },
    })
    const result: ActiveMemoryRecallResult = { injectedSummary: null, memories: [], usedMemoryIds: [], skippedReason: 'timeout', confidence: 0, retrieval: [] }
    cacheRecallForRun(input, result)
    return result
  }

  recordSuccess(scopedKey)
  const memories = recalled.map((item) => item.memory)
  const usedMemoryIds = memories.map((memory) => memory.id)
  const injectedSummary = buildSummary(recalled)
  const confidence = recalled.length > 0 ? Math.max(...recalled.map((item) => item.score)) : 0
  const retrieval = recalled.map((item) => ({ memoryId: item.memory.id, score: item.score, reasons: item.reasons }))

  if (memories.length === 0) {
    await addRunEvent(input.db, {
      threadId: input.threadId,
      runId: input.runId,
      type: 'memory_recall_completed',
      title: '主动记忆召回完成',
      message: '未找到与本轮目标足够相关的当前工作区记忆。',
      status: 'info',
      data: { skippedReason: 'no_relevant_memory', memoryCount: 0 },
    })
    const result: ActiveMemoryRecallResult = { injectedSummary: null, memories: [], usedMemoryIds: [], skippedReason: 'no_relevant_memory', confidence: 0, retrieval: [] }
    recallCache.set(key, { expiresAt: Date.now() + ACTIVE_RECALL_CACHE_TTL_MS, result })
    cacheRecallForRun(input, result)
    return result
  }

  await markAgentMemoriesRecalled({
    db: input.db,
    memories,
    workspace: input.workspace,
    user: input.user,
    threadId: input.threadId,
    runId: input.runId,
    query: input.message,
  })

  await addMemoryEvent(input.db, {
    memoryId: null,
    workspaceId: input.workspace.id,
    userId: input.user.id,
    threadId: input.threadId,
    runId: input.runId,
    eventType: 'injected',
    evidence: { memoryIds: usedMemoryIds },
    metadata: { confidence, retrieval },
  })
  await addRunEvent(input.db, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'memory_recall_completed',
    title: '主动记忆召回完成',
    message: `找到 ${memories.length} 条相关记忆，已准备注入为非指令上下文。`,
    status: 'info',
    data: {
      memoryIds: usedMemoryIds,
      memoryCount: memories.length,
      confidence,
      retrieval,
      citations: recalled.map((item) => ({
        memoryId: item.memory.id,
        lane: item.memory.lane,
        score: item.score,
        evidenceRefs: item.memory.evidence_json ? ['evidence_json'] : [],
      })),
    },
  })
  await addRunEvent(input.db, {
    threadId: input.threadId,
    runId: input.runId,
    type: 'memory_injected',
    title: '主动记忆已注入',
    message: `已注入 ${memories.length} 条当前用户/工作区相关记忆，作为非指令上下文供模型参考。`,
    status: 'info',
    data: {
      memoryIds: usedMemoryIds,
      memoryCount: memories.length,
      confidence,
      retrieval,
      citations: recalled.map((item) => ({
        memoryId: item.memory.id,
        lane: item.memory.lane,
        score: item.score,
        evidenceRefs: item.memory.evidence_json ? ['evidence_json'] : [],
      })),
    },
  })

  const result: ActiveMemoryRecallResult = { injectedSummary, memories, usedMemoryIds, confidence, retrieval }
  recallCache.set(key, { expiresAt: Date.now() + ACTIVE_RECALL_CACHE_TTL_MS, result })
  cacheRecallForRun(input, result)
  return result
}
