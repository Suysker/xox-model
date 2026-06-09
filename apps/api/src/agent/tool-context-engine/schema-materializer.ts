import type { ChatTool } from '../tool-catalog.js'
import type { ToolManifest } from './tool-manifest.js'
import type { RankedToolManifest } from './tool-reranker.js'
import { isKernelToolName } from './tool-reranker.js'

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
  selectedCapabilities: Set<string>
}) {
  const { ranked, index, selectedCapabilities } = input
  if (isKernelToolName(ranked.manifest.name)) return true
  if (ranked.reasons.includes('workflow_prerequisite')) return true
  if (ranked.reasons.includes('required_action_capability')) return true
  if (ranked.reasons.some((reason) => reason.startsWith('required_capability:'))) return true
  if (selectedCapabilities.size === 0) {
    if (!ranked.reasons.includes('retrieval')) return false
    if (ranked.score > 1.25) return true
    return index < 3 && ranked.score > 0
  }
  if (!selectedCapabilities.has(ranked.manifest.capability)) return false
  if (ranked.score > 0.75) return true
  return index < 3 && ranked.score > 0
}

export function materializeToolSchemas(input: {
  ranked: RankedToolManifest[]
  selectedCapabilities?: readonly string[]
  maxTools?: number
}): MaterializedToolContext {
  const maxTools = input.maxTools ?? DEFAULT_MAX_MATERIALIZED_TOOLS
  const selectedCapabilities = new Set(input.selectedCapabilities ?? [])
  const selected: ToolManifest[] = []
  const seen = new Set<string>()
  const kernel = input.ranked.filter((ranked) => isKernelToolName(ranked.manifest.name))
  const nonKernel = input.ranked.filter((ranked) => !isKernelToolName(ranked.manifest.name))
  const prerequisiteTools = nonKernel.filter((ranked) => ranked.reasons.includes('workflow_prerequisite'))
  const remainingTools = nonKernel.filter((ranked) => !ranked.reasons.includes('workflow_prerequisite'))

  for (const ranked of kernel) {
    if (seen.has(ranked.manifest.name)) continue
    selected.push(ranked.manifest)
    seen.add(ranked.manifest.name)
  }

  const nonKernelLimit = Math.max(0, maxTools - selected.length)
  let nonKernelCount = 0

  for (const [index, ranked] of prerequisiteTools.entries()) {
    if (seen.has(ranked.manifest.name)) continue
    if (!shouldKeepTool({ ranked, index, selectedCapabilities })) continue
    if (nonKernelCount >= nonKernelLimit) break
    selected.push(ranked.manifest)
    seen.add(ranked.manifest.name)
    nonKernelCount += 1
  }

  for (const [index, ranked] of remainingTools.entries()) {
    if (seen.has(ranked.manifest.name)) continue
    if (!shouldKeepTool({ ranked, index, selectedCapabilities })) continue
    if (nonKernelCount >= nonKernelLimit) break
    selected.push(ranked.manifest)
    seen.add(ranked.manifest.name)
    nonKernelCount += 1
  }

  return {
    manifests: selected,
    tools: selected.map((manifest) => manifest.providerSchema),
    descriptors: selected.map(descriptorFromManifest),
  }
}
