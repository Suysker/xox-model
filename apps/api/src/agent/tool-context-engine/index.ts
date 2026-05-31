import type { AgentAutomationLevel } from '@xox/contracts'
import type { AgentToolCapability, AgentToolRegistryEntry, ChatTool } from '../tool-catalog.js'
import { buildDiscoveryTrace, type ToolDiscoveryTrace } from './discovery-trace.js'
import { materializeToolSchemas, type ToolDescriptor } from './schema-materializer.js'
import { buildToolManifests } from './tool-manifest.js'
import { rankToolManifests } from './tool-reranker.js'

export type ToolContextPack = {
  strategy: 'progressive_tool_discovery'
  selectedCapabilities: AgentToolCapability[]
  tools: ChatTool[]
  toolNames: string[]
  toolDescriptors: ToolDescriptor[]
  discoveryTrace: ToolDiscoveryTrace
}

function uniqueCapabilities(values: AgentToolCapability[]) {
  return [...new Set(values)]
}

function materializationBudget(input: {
  selectedCapabilities: AgentToolCapability[]
  automationLevel?: AgentAutomationLevel
}) {
  const count = uniqueCapabilities(input.selectedCapabilities).length
  if (count >= 6) return 8
  if (count >= 3) return 7
  return 6
}

export function buildToolContextPack(input: {
  registry: AgentToolRegistryEntry[]
  selectedCapabilities: AgentToolCapability[]
  message?: string
  routerReason?: string
  automationLevel?: AgentAutomationLevel
}): ToolContextPack {
  const selectedCapabilities = uniqueCapabilities(input.selectedCapabilities)
  const manifests = buildToolManifests(input.registry)
  const ranked = rankToolManifests({
    manifests,
    selectedCapabilities,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.routerReason !== undefined ? { routerReason: input.routerReason } : {}),
  })
  const materialized = materializeToolSchemas({
    ranked,
    maxTools: materializationBudget({
      selectedCapabilities,
      ...(input.automationLevel !== undefined ? { automationLevel: input.automationLevel } : {}),
    }),
  })
  const discoveryTrace = buildDiscoveryTrace({
    selectedCapabilities,
    ranked,
    descriptors: materialized.descriptors,
  })

  return {
    strategy: 'progressive_tool_discovery',
    selectedCapabilities,
    tools: materialized.tools,
    toolNames: materialized.manifests.map((manifest) => manifest.name),
    toolDescriptors: materialized.descriptors,
    discoveryTrace,
  }
}
