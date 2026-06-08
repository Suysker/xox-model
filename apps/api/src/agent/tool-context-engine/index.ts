import type { AgentAutomationLevel, AgentToolSurfacePlan } from '@xox/contracts'
import type { AgentToolCapability, AgentToolRegistryEntry, ChatTool } from '../tool-catalog.js'
import { buildDiscoveryTrace, type ToolDiscoveryTrace } from './discovery-trace.js'
import { materializeToolSchemas, type ToolDescriptor } from './schema-materializer.js'
import { buildToolManifests, type ToolManifest } from './tool-manifest.js'
import { KERNEL_TOOL_NAMES, rankToolManifests } from './tool-reranker.js'

export type ToolContextPack = {
  strategy: 'progressive_tool_discovery'
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities: AgentToolCapability[]
  effectiveCatalog: ToolManifest[]
  visibleTools: ChatTool[]
  visibleToolNames: string[]
  kernelToolNames: string[]
  materializableToolNames: string[]
  deferredCatalog: ToolManifest[]
  replayAllowedToolNames: string[]
  autoAddedControlNames: string[]
  emptySurfaceStatus:
    | 'has_callable_tools'
    | 'direct_answer_only'
    | 'needs_clarification'
    | 'needs_tool_search'
    | 'fail_closed'
  budget: AgentToolSurfacePlan['budget']
  surfacePlan: AgentToolSurfacePlan
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
  const base = count === 0 ? 8 : count >= 6 ? 8 : count >= 3 ? 7 : 6
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
    selectedCapabilities,
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
  const materializableToolNames = deferredCatalog.map((manifest) => manifest.name)
  const kernelToolNames = KERNEL_TOOL_NAMES.filter((name) => visibleToolNameSet.has(name))
  const autoAddedControlNames = visibleToolNames.filter((name) => {
    const manifest = materialized.manifests.find((item) => item.name === name)
    return manifest?.capability === 'account' || manifest?.capability === 'clarification' || manifest?.capability === 'tooling'
  })
  const emptySurfaceStatus: ToolContextPack['emptySurfaceStatus'] =
    materialized.manifests.length > 0
      ? 'has_callable_tools'
      : selectedCapabilities.length === 0
        ? 'direct_answer_only'
        : ranked.length > 0
          ? 'needs_tool_search'
          : 'fail_closed'
  const visibleSchemaTokenEstimate = materialized.manifests.reduce((total, manifest) => total + manifest.schemaTokenEstimate, 0)
  const deferredSchemaTokenEstimate = deferredCatalog.reduce((total, manifest) => total + manifest.schemaTokenEstimate, 0)
  const budget: ToolContextPack['budget'] = {
    providerContextTokens: null,
    visibleSchemaTokenEstimate,
    deferredSchemaTokenEstimate,
    toolSearchActivated: deferredCatalog.length > 0,
  }
  const surfacePlan: AgentToolSurfacePlan = {
    schemaVersion: 'xox.tool_surface.v2',
    turnLane: 'agent_goal',
    effectiveCatalog: effectiveCatalog.map((manifest) => manifest.name),
    kernelToolNames,
    visibleToolNames,
    materializableToolNames,
    deferredToolNames: materializableToolNames,
    replayAllowedToolNames: visibleToolNames,
    autoAddedControlNames,
    capabilityHints: {
      selectedCapabilities,
      requiredActionCapabilities,
      confidence: selectedCapabilities.length > 0 ? 0.8 : 0.2,
      reason: input.routerReason ?? '',
    },
    budget,
    emptySurfaceStatus,
    discoveryTraceId: `trace:${visibleToolNames.join(',')}:${materializableToolNames.length}`,
  }

  return {
    strategy: 'progressive_tool_discovery',
    selectedCapabilities,
    requiredActionCapabilities,
    effectiveCatalog,
    visibleTools: materialized.tools,
    visibleToolNames,
    kernelToolNames,
    materializableToolNames,
    deferredCatalog,
    replayAllowedToolNames: visibleToolNames,
    autoAddedControlNames,
    emptySurfaceStatus,
    budget,
    surfacePlan,
    tools: materialized.tools,
    toolNames: visibleToolNames,
    toolDescriptors: materialized.descriptors,
    discoveryTrace,
  }
}
