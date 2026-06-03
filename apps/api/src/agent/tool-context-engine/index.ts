import type { AgentAutomationLevel } from '@xox/contracts'
import type { AgentToolCapability, AgentToolRegistryEntry, ChatTool } from '../tool-catalog.js'
import { buildDiscoveryTrace, type ToolDiscoveryTrace } from './discovery-trace.js'
import { materializeToolSchemas, type ToolDescriptor } from './schema-materializer.js'
import { buildToolManifests, type ToolManifest } from './tool-manifest.js'
import { rankToolManifests } from './tool-reranker.js'

export type ToolContextPack = {
  strategy: 'progressive_tool_discovery'
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities: AgentToolCapability[]
  effectiveCatalog: ToolManifest[]
  visibleTools: ChatTool[]
  visibleToolNames: string[]
  deferredCatalog: ToolManifest[]
  replayAllowedToolNames: string[]
  autoAddedControlNames: string[]
  emptySurfaceStatus:
    | 'has_callable_tools'
    | 'direct_answer_only'
    | 'needs_clarification'
    | 'needs_retrieval'
    | 'fail_closed'
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
  requiredActionCapabilities?: AgentToolCapability[]
  automationLevel?: AgentAutomationLevel
}) {
  const count = uniqueCapabilities(input.selectedCapabilities).length
  const requiredWriteCount = uniqueCapabilities(input.requiredActionCapabilities ?? []).length
  const base = count >= 6 ? 8 : count >= 3 ? 7 : 6
  return Math.min(12, base + requiredWriteCount * 3)
}

export function buildToolContextPack(input: {
  registry: AgentToolRegistryEntry[]
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities?: AgentToolCapability[]
  message?: string
  routerReason?: string
  automationLevel?: AgentAutomationLevel
}): ToolContextPack {
  const selectedCapabilities = uniqueCapabilities(input.selectedCapabilities)
  const requiredActionCapabilities = uniqueCapabilities(input.requiredActionCapabilities ?? [])
  const manifests = buildToolManifests(input.registry)
  const ranked = rankToolManifests({
    manifests,
    selectedCapabilities,
    requiredActionCapabilities,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.routerReason !== undefined ? { routerReason: input.routerReason } : {}),
  })
  const materialized = materializeToolSchemas({
    ranked,
    maxTools: materializationBudget({
      selectedCapabilities,
      requiredActionCapabilities,
      ...(input.automationLevel !== undefined ? { automationLevel: input.automationLevel } : {}),
    }),
  })
  const discoveryTrace = buildDiscoveryTrace({
    selectedCapabilities,
    ranked,
    descriptors: materialized.descriptors,
  })
  const visibleToolNames = materialized.manifests.map((manifest) => manifest.name)
  const visibleToolNameSet = new Set(visibleToolNames)
  const effectiveCatalog = ranked.map((item) => item.manifest)
  const deferredCatalog = effectiveCatalog.filter((manifest) => !visibleToolNameSet.has(manifest.name))
  const autoAddedControlNames = visibleToolNames.filter((name) => {
    const manifest = materialized.manifests.find((item) => item.name === name)
    return manifest?.capability === 'account' || manifest?.capability === 'clarification'
  })
  const emptySurfaceStatus: ToolContextPack['emptySurfaceStatus'] =
    materialized.manifests.length > 0
      ? 'has_callable_tools'
      : selectedCapabilities.length === 0
        ? 'direct_answer_only'
        : ranked.length > 0
          ? 'needs_retrieval'
          : 'fail_closed'

  return {
    strategy: 'progressive_tool_discovery',
    selectedCapabilities,
    requiredActionCapabilities,
    effectiveCatalog,
    visibleTools: materialized.tools,
    visibleToolNames,
    deferredCatalog,
    replayAllowedToolNames: visibleToolNames,
    autoAddedControlNames,
    emptySurfaceStatus,
    tools: materialized.tools,
    toolNames: visibleToolNames,
    toolDescriptors: materialized.descriptors,
    discoveryTrace,
  }
}
