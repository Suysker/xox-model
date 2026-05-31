import type { ChatTool } from '../tool-catalog.js'
import type { ToolManifest } from './tool-manifest.js'
import type { RankedToolManifest } from './tool-reranker.js'

export type ToolDescriptor = {
  name: string
  capability: string
  title: string
  summary: string
  parameterNames: string[]
  riskLevel: string
  confirmationMode: string
  navigationTarget: string | null
}

export type MaterializedToolContext = {
  manifests: ToolManifest[]
  tools: ChatTool[]
  descriptors: ToolDescriptor[]
}

const DEFAULT_MAX_MATERIALIZED_TOOLS = 8

function descriptorFromManifest(manifest: ToolManifest): ToolDescriptor {
  return {
    name: manifest.name,
    capability: manifest.capability,
    title: manifest.title,
    summary: manifest.summary,
    parameterNames: manifest.parameterNames,
    riskLevel: manifest.riskLevel,
    confirmationMode: manifest.confirmationMode,
    navigationTarget: manifest.navigationTarget,
  }
}

function shouldKeepTool(input: {
  ranked: RankedToolManifest
  index: number
  hasBusinessCapability: boolean
}) {
  const { ranked, index, hasBusinessCapability } = input
  const capability = ranked.manifest.capability
  if (capability === 'account' || capability === 'clarification') return hasBusinessCapability || ranked.score > 0.5
  if (ranked.reasons.includes('workflow_prerequisite')) return true
  if (ranked.score > 0.75) return true
  return index < 3 && ranked.score > 0
}

export function materializeToolSchemas(input: {
  ranked: RankedToolManifest[]
  maxTools?: number
}): MaterializedToolContext {
  const maxTools = input.maxTools ?? DEFAULT_MAX_MATERIALIZED_TOOLS
  const hasBusinessCapability = input.ranked.some((ranked) =>
    ranked.manifest.capability !== 'account' &&
    ranked.manifest.capability !== 'clarification',
  )
  const selected: ToolManifest[] = []
  const seen = new Set<string>()
  const essential = input.ranked.filter((ranked) =>
    ranked.manifest.capability === 'account' ||
    ranked.manifest.capability === 'clarification',
  )
  const business = input.ranked.filter((ranked) =>
    ranked.manifest.capability !== 'account' &&
    ranked.manifest.capability !== 'clarification',
  )
  const essentialToKeep = essential.filter((ranked) => shouldKeepTool({
    ranked,
    index: 0,
    hasBusinessCapability,
  }))
  const businessLimit = Math.max(0, maxTools - essentialToKeep.length)

  for (const [index, ranked] of business.entries()) {
    if (seen.has(ranked.manifest.name)) continue
    if (!shouldKeepTool({ ranked, index, hasBusinessCapability })) continue
    if (selected.length >= businessLimit) break
    selected.push(ranked.manifest)
    seen.add(ranked.manifest.name)
  }

  for (const ranked of essentialToKeep) {
    if (seen.has(ranked.manifest.name)) continue
    if (selected.length >= maxTools) break
    selected.push(ranked.manifest)
    seen.add(ranked.manifest.name)
  }

  if (selected.length === 0) {
    for (const ranked of essential) {
      if (seen.has(ranked.manifest.name)) continue
      selected.push(ranked.manifest)
      seen.add(ranked.manifest.name)
    }
  }

  return {
    manifests: selected,
    tools: selected.map((manifest) => manifest.providerSchema),
    descriptors: selected.map(descriptorFromManifest),
  }
}
