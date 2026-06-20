import { buildMemoryCitation, formatMemoryCitation, takeBudgetedMemoryItems } from '@xox/agent-memory-core'
import type { Row } from '../../db/schema.js'
import { redactSecretLikeContent } from '@agentic-os/core'
import type { AgentMemoryRetrievalResult } from '../memory-retriever.js'

export type ActiveMemoryPromptPack = {
  injectedSummary: string | null
  usedMemoryIds: string[]
  citations: ReturnType<typeof buildMemoryCitation>[]
  budget: {
    maxItems: number
    maxChars: number
    usedChars: number
  }
}

function layerForMemory(memory: Row<'agent_memories'>) {
  return memory.lane === 'diagnostic' || memory.kind === 'diagnostic'
    ? 'diagnostic'
    : 'durable'
}

export function buildOpenClawActiveMemoryPromptPack(input: {
  recalled: AgentMemoryRetrievalResult[]
  maxItems?: number
  maxChars?: number
}): ActiveMemoryPromptPack {
  const maxItems = Math.max(1, Math.min(12, input.maxItems ?? 6))
  const maxChars = Math.max(200, Math.min(4000, input.maxChars ?? 1600))
  const budgeted = takeBudgetedMemoryItems(
    input.recalled.slice(0, maxItems).map((result, index) => {
      const memory = result.memory
      const value = redactSecretLikeContent(memory.value).replace(/\s+/g, ' ').trim()
      const citation = buildMemoryCitation({
        memoryId: memory.id,
        layer: layerForMemory(memory),
        score: result.score,
        evidenceRefs: memory.evidence_json ? ['evidence_json'] : [],
      })
      return {
        result,
        citation,
        text: `${index + 1}. ${formatMemoryCitation(citation)} ${value}`,
      }
    }),
    maxChars,
  )
  const lines = budgeted.items.map((item) => item.text)
  if (lines.length === 0) {
    return {
      injectedSummary: null,
      usedMemoryIds: [],
      citations: [],
      budget: { maxItems, maxChars, usedChars: 0 },
    }
  }
  return {
    injectedSummary: [
      '<memory_context trust="untrusted" scope="current_user_current_workspace">',
      ...lines,
      '</memory_context>',
    ].join('\n'),
    usedMemoryIds: budgeted.items.map((item) => item.result.memory.id),
    citations: budgeted.items.map((item) => item.citation),
    budget: { maxItems, maxChars, usedChars: budgeted.usedChars },
  }
}
