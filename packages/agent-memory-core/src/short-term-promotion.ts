/**
 * OpenClaw-derived short-term promotion scoring.
 *
 * Source inspiration: C:\Github\openclaw\extensions\memory-core\src\short-term-promotion.ts
 * The xox-model variant scores SaaS recall signals instead of filesystem
 * snippets under memory/.dreams.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14

export const DEFAULT_PROMOTION_MIN_SCORE = 0.75
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = 3
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = 2

export type PromotionWeights = {
  frequency: number
  relevance: number
  diversity: number
  recency: number
  consolidation: number
  conceptual: number
}

export const DEFAULT_PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.3,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  conceptual: 0.06,
}

export type ShortTermRecallSignal = {
  memoryId: string
  snippet: string
  recallCount: number
  totalScore: number
  maxScore: number
  uniqueQueries: number
  recallDays: string[]
  firstRecalledAt: string
  lastRecalledAt: string
  conceptTags?: string[]
  consolidationHits?: number
  promotedAt?: string | null
}

export type PromotionCandidateScore = ShortTermRecallSignal & {
  avgScore: number
  ageDays: number
  score: number
  components: {
    frequency: number
    relevance: number
    diversity: number
    recency: number
    consolidation: number
    conceptual: number
  }
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function recencyScore(lastRecalledAt: string, nowMs: number, halfLifeDays: number) {
  const last = Date.parse(lastRecalledAt)
  if (!Number.isFinite(last)) return 0
  const ageDays = Math.max(0, (nowMs - last) / DAY_MS)
  return Math.exp(-ageDays / Math.max(1, halfLifeDays))
}

export function scorePromotionCandidate(input: {
  signal: ShortTermRecallSignal
  weights?: Partial<PromotionWeights>
  nowMs?: number
  recencyHalfLifeDays?: number
}): PromotionCandidateScore {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs! : Date.now()
  const weights = { ...DEFAULT_PROMOTION_WEIGHTS, ...input.weights }
  const signal = input.signal
  const avgScore = signal.recallCount > 0 ? signal.totalScore / signal.recallCount : 0
  const last = Date.parse(signal.lastRecalledAt)
  const ageDays = Number.isFinite(last) ? Math.max(0, (nowMs - last) / DAY_MS) : Infinity
  const components = {
    frequency: clamp01(signal.recallCount / 6),
    relevance: clamp01((avgScore * 0.55) + (signal.maxScore * 0.45)),
    diversity: clamp01(signal.uniqueQueries / 4),
    recency: clamp01(recencyScore(signal.lastRecalledAt, nowMs, input.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS)),
    consolidation: clamp01((signal.consolidationHits ?? 0) / 3),
    conceptual: clamp01((signal.conceptTags?.length ?? 0) / 4),
  }
  const score =
    components.frequency * weights.frequency +
    components.relevance * weights.relevance +
    components.diversity * weights.diversity +
    components.recency * weights.recency +
    components.consolidation * weights.consolidation +
    components.conceptual * weights.conceptual
  return {
    ...signal,
    avgScore,
    ageDays,
    score: Number(score.toFixed(4)),
    components,
  }
}

export function rankShortTermPromotionCandidates(input: {
  signals: ShortTermRecallSignal[]
  limit?: number
  minScore?: number
  minRecallCount?: number
  minUniqueQueries?: number
  includePromoted?: boolean
  nowMs?: number
}) {
  const minScore = input.minScore ?? DEFAULT_PROMOTION_MIN_SCORE
  const minRecallCount = input.minRecallCount ?? DEFAULT_PROMOTION_MIN_RECALL_COUNT
  const minUniqueQueries = input.minUniqueQueries ?? DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES
  return input.signals
    .filter((signal) => input.includePromoted || !signal.promotedAt)
    .map((signal) => scorePromotionCandidate({ signal, ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}) }))
    .filter((candidate) =>
      candidate.score >= minScore &&
      candidate.recallCount >= minRecallCount &&
      candidate.uniqueQueries >= minUniqueQueries)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, Math.max(1, input.limit ?? 10))
}
