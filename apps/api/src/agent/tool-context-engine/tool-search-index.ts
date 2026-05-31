import type { ToolSearchDocument } from './tool-search-document.js'

export type ToolSearchHit = {
  name: string
  score: number
  lexicalScore: number
  aliasScore: number
  matchedAliases: string[]
}

type IndexedDocument = ToolSearchDocument & {
  tokens: Map<string, number>
  length: number
}

export type ToolSearchIndex = {
  documents: IndexedDocument[]
  averageDocumentLength: number
  documentFrequency: Map<string, number>
}

function isHanSegment(value: string) {
  return /^\p{Script=Han}+$/u.test(value)
}

function grams(value: string, size: number) {
  if (value.length < size) return []
  const result: string[] = []
  for (let index = 0; index <= value.length - size; index += 1) {
    result.push(value.slice(index, index + size))
  }
  return result
}

export function tokenizeToolText(value: string): string[] {
  const text = value.toLowerCase()
  const tokens: string[] = []
  for (const match of text.matchAll(/[\p{Script=Han}]+|[a-z0-9_]+/gu)) {
    const segment = match[0]
    if (!segment) continue
    tokens.push(segment)
    if (isHanSegment(segment)) {
      tokens.push(...Array.from(segment))
      tokens.push(...grams(segment, 2))
      tokens.push(...grams(segment, 3))
      continue
    }
    tokens.push(...segment.split('_').filter(Boolean))
  }
  return tokens.filter((token) => token.length > 0)
}

function tokenCounts(tokens: string[]) {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

export function createToolSearchIndex(documents: ToolSearchDocument[]): ToolSearchIndex {
  const indexed = documents.map((document) => {
    const tokens = tokenCounts(tokenizeToolText(document.text))
    return {
      ...document,
      tokens,
      length: [...tokens.values()].reduce((sum, count) => sum + count, 0),
    }
  })

  const documentFrequency = new Map<string, number>()
  for (const document of indexed) {
    for (const token of document.tokens.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  return {
    documents: indexed,
    averageDocumentLength: indexed.length > 0
      ? indexed.reduce((sum, document) => sum + document.length, 0) / indexed.length
      : 1,
    documentFrequency,
  }
}

function bm25Score(input: {
  queryTokens: string[]
  document: IndexedDocument
  index: ToolSearchIndex
}) {
  const k1 = 1.2
  const b = 0.75
  const totalDocuments = Math.max(input.index.documents.length, 1)
  let score = 0
  for (const token of input.queryTokens) {
    const termFrequency = input.document.tokens.get(token) ?? 0
    if (termFrequency === 0) continue
    const df = input.index.documentFrequency.get(token) ?? 0
    const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5))
    const denominator = termFrequency + k1 * (1 - b + b * (input.document.length / input.index.averageDocumentLength))
    score += idf * ((termFrequency * (k1 + 1)) / denominator)
  }
  return score
}

function aliasMatchScore(query: string, aliases: string[]) {
  const normalized = query.toLowerCase()
  const matchedAliases: string[] = []
  let score = 0
  for (const alias of aliases) {
    const candidate = alias.toLowerCase().trim()
    if (!candidate) continue
    if (normalized.includes(candidate)) {
      matchedAliases.push(alias)
      score += Math.min(6, 1.5 + candidate.length / 4)
    }
  }
  return { score, matchedAliases }
}

export function searchToolIndex(index: ToolSearchIndex, query: string, options: { limit?: number } = {}): ToolSearchHit[] {
  const queryTokens = tokenizeToolText(query)
  const hits = index.documents.map((document) => {
    const lexicalScore = bm25Score({ queryTokens, document, index })
    const alias = aliasMatchScore(query, document.aliases)
    return {
      name: document.name,
      score: lexicalScore + alias.score,
      lexicalScore,
      aliasScore: alias.score,
      matchedAliases: alias.matchedAliases,
    }
  }).filter((hit) => hit.score > 0)

  hits.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
  return typeof options.limit === 'number' ? hits.slice(0, options.limit) : hits
}
