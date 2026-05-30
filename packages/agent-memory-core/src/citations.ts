/**
 * OpenClaw-inspired memory citation helpers.
 *
 * Source inspiration: C:\Github\openclaw\extensions\memory-core\src\tools.citations.ts
 * xox-model citations point at tenant-scoped memory/evidence ids instead of
 * local file paths and line ranges.
 */

export type MemoryCitation = {
  memoryId: string
  layer: 'durable' | 'daily' | 'dream' | 'signal' | 'diagnostic'
  evidenceRefs: string[]
  score?: number
  usedAt?: string
}

export function formatMemoryCitation(citation: MemoryCitation) {
  const evidence = citation.evidenceRefs.length > 0 ? ` evidence=${citation.evidenceRefs.join(',')}` : ''
  const score = typeof citation.score === 'number' ? ` score=${citation.score.toFixed(3)}` : ''
  return `[memory:${citation.memoryId} layer=${citation.layer}${score}${evidence}]`
}

export function buildMemoryCitation(input: {
  memoryId: string
  layer?: MemoryCitation['layer']
  evidenceRefs?: string[]
  score?: number
  usedAt?: string
}): MemoryCitation {
  return {
    memoryId: input.memoryId,
    layer: input.layer ?? 'durable',
    evidenceRefs: input.evidenceRefs ?? [],
    ...(typeof input.score === 'number' ? { score: input.score } : {}),
    ...(input.usedAt ? { usedAt: input.usedAt } : {}),
  }
}
