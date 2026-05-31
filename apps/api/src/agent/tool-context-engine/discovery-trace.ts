import type { AgentToolCapability } from '../tool-catalog.js'
import type { ToolDescriptor } from './schema-materializer.js'
import type { RankedToolManifest } from './tool-reranker.js'

export type ToolDiscoveryTrace = {
  strategy: 'progressive_tool_discovery'
  selectedCapabilities: AgentToolCapability[]
  materializedToolNames: string[]
  candidateToolNames: string[]
  prunedToolNames: string[]
  descriptorCount: number
  materializedToolCount: number
  rankedCandidates: Array<{
    name: string
    capability: AgentToolCapability
    score: number
    reasons: string[]
  }>
}

export function buildDiscoveryTrace(input: {
  selectedCapabilities: AgentToolCapability[]
  ranked: RankedToolManifest[]
  descriptors: ToolDescriptor[]
}): ToolDiscoveryTrace {
  const materializedToolNames = input.descriptors.map((descriptor) => descriptor.name)
  const candidateToolNames = input.ranked.map((ranked) => ranked.manifest.name)
  return {
    strategy: 'progressive_tool_discovery',
    selectedCapabilities: input.selectedCapabilities,
    materializedToolNames,
    candidateToolNames,
    prunedToolNames: candidateToolNames.filter((name) => !materializedToolNames.includes(name)),
    descriptorCount: input.descriptors.length,
    materializedToolCount: materializedToolNames.length,
    rankedCandidates: input.ranked.slice(0, 20).map((ranked) => ({
      name: ranked.manifest.name,
      capability: ranked.manifest.capability,
      score: Number(ranked.score.toFixed(3)),
      reasons: ranked.reasons,
    })),
  }
}
