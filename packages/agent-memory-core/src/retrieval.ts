/**
 * OpenClaw-inspired retrieval helpers.
 *
 * Source inspiration: OpenClaw memory search/reranking and MMR utilities.
 * This file is pure TypeScript and does not know about xox-model tenants,
 * databases, or business state.
 */

const CJK_CHAR = /[\u3400-\u9fff]/
const WORD_OR_CJK = /[a-z0-9_]+|[\u3400-\u9fff]/gi

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

export function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function tokenizeMemoryText(value: string) {
  const normalized = normalizeSearchText(value)
  const raw = normalized.match(WORD_OR_CJK) ?? []
  const words = raw.filter((token) => !CJK_CHAR.test(token) && token.length >= 2)
  const cjkChars = raw.filter((token) => CJK_CHAR.test(token))
  const cjkBigrams = cjkChars.slice(0, -1).map((char, index) => `${char}${cjkChars[index + 1]}`)
  return unique([...words, ...cjkChars, ...cjkBigrams])
}

export function jaccard(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

export type RankedMemoryLike = {
  id: string
  key: string
  value: string
  score: number
}

export function applyMmr<T extends RankedMemoryLike>(results: T[], lambda = 0.72): T[] {
  if (results.length <= 2) return results
  const remaining = [...results]
  const selected: T[] = []
  const tokens = new Map<string, Set<string>>()
  for (const result of results) tokens.set(result.id, new Set(tokenizeMemoryText(`${result.key} ${result.value}`)))

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!
      const candidateTokens = tokens.get(candidate.id) ?? new Set<string>()
      const maxSimilarity = selected.reduce((max, item) => Math.max(max, jaccard(candidateTokens, tokens.get(item.id) ?? new Set<string>())), 0)
      const score = lambda * candidate.score - (1 - lambda) * maxSimilarity
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!)
  }
  return selected
}

export function lexicalRelevance(query: string, text: string) {
  const queryTokens = tokenizeMemoryText(query)
  const memoryTokens = new Set(tokenizeMemoryText(text))
  const overlap = queryTokens.filter((token) => memoryTokens.has(token))
  const lexical = queryTokens.length > 0 ? overlap.length / queryTokens.length : 0
  const phrase = normalizeSearchText(text).includes(normalizeSearchText(query)) && query.trim().length >= 3 ? 0.18 : 0
  return {
    score: lexical * 0.5 + phrase,
    overlap,
    reasons: [
      overlap.length > 0 ? `token_overlap:${overlap.slice(0, 6).join(',')}` : null,
      phrase > 0 ? 'phrase_match' : null,
    ].filter((item): item is string => Boolean(item)),
  }
}
