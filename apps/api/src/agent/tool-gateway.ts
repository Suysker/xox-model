import type { Kysely } from 'kysely'
import type { AgentGoalFacts, AgentToolInventorySnapshot } from '@xox/contracts'
import {
  buildOpenAICompatibleEffectiveToolInventorySnapshot,
  type OpenAICompatibleEffectiveToolInventoryToolInput,
} from '@agentic-os/runtime-openai-compatible'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { Database } from '../db/schema.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'
import { mergeAgentGoalFacts, sanitizeAgentGoalFacts } from './runtime-goal-facts.js'
import {
  buildToolContextPack,
  canonicalToolNamesForCapabilities,
  type ToolContextPack,
} from './tool-surface-manifest.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  type AgentToolCapability,
  type AgentToolMetadata,
  type AgentToolNavigationTarget,
  type ChatTool,
} from './tool-catalog.js'
import type { AgentLoopObligationPlan } from './loop-obligation-ledger.js'
import type { AgentToolObservation } from './tool-observation-continuation.js'

type ToolGatewayContext = {
  db: Kysely<Database>
  threadId: string
  runId: string
  settings?: Settings
  message?: string
  context?: unknown
  abortSignal?: AbortSignal
  userId?: string
  workspaceId?: string
  automationLevel?: 'manual' | 'low' | 'medium' | 'high'
  loopObligationPlan?: AgentLoopObligationPlan
  goalFacts?: AgentGoalFacts
  priorObservations?: AgentToolObservation[]
}

export type ToolCatalogProjectionStrategy =
  | 'full_registry'
  | 'model_selected_capabilities'
  | 'progressive_tool_discovery'

export type RuntimeToolCatalogProjection = {
  strategy: ToolCatalogProjectionStrategy
  tools: ChatTool[]
  toolCount: number
  toolNames: string[]
  toolCapabilities: AgentToolMetadata[]
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities: AgentToolCapability[]
  goalFacts: AgentGoalFacts
  inventorySnapshot: AgentToolInventorySnapshot
  effectiveCatalog: ToolContextPack['effectiveCatalog']
  visibleTools: ToolContextPack['visibleTools']
  visibleToolNames: ToolContextPack['visibleToolNames']
  kernelToolNames: ToolContextPack['kernelToolNames']
  materializableToolNames: ToolContextPack['materializableToolNames']
  deferredCatalog: ToolContextPack['deferredCatalog']
  replayAllowedToolNames: ToolContextPack['replayAllowedToolNames']
  autoAddedControlNames: ToolContextPack['autoAddedControlNames']
  emptySurfaceStatus: ToolContextPack['emptySurfaceStatus'] | null
  budget: ToolContextPack['budget'] | null
  surfacePlan: ToolContextPack['surfacePlan'] | null
  toolDescriptors: ToolContextPack['toolDescriptors']
  discoveryTrace: ToolContextPack['discoveryTrace'] | null
  routerReason?: string
}

const ESSENTIAL_CAPABILITIES: AgentToolCapability[] = ['account', 'clarification', 'tooling']
const ROUTABLE_CAPABILITIES: AgentToolCapability[] = ['data', 'draft', 'import_export', 'ledger', 'memory', 'navigation', 'sandbox', 'share', 'version']
const ALL_CAPABILITIES = new Set<AgentToolCapability>([...ESSENTIAL_CAPABILITIES, ...ROUTABLE_CAPABILITIES])
const OBLIGATION_CONTROL_TOOL_NAMES = new Set([
  'tool_discover',
  'rg',
  'ask_user_clarification',
  'account_forbidden',
])

function safeCapabilities(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const selected: AgentToolCapability[] = []
  for (const item of values) {
    if (typeof item !== 'string') continue
    if (!ALL_CAPABILITIES.has(item as AgentToolCapability)) continue
    if (!selected.includes(item as AgentToolCapability)) selected.push(item as AgentToolCapability)
  }
  return selected
}

function toolMetadata(entry: (typeof AGENT_TOOL_REGISTRY)[number]): AgentToolMetadata {
  return {
    name: entry.name,
    capability: entry.capability,
    riskLevel: entry.riskLevel,
    confirmationMode: entry.confirmationMode,
    navigationTarget: entry.navigationTarget,
  }
}

function toolMetadataFromManifest(manifest: ToolContextPack['effectiveCatalog'][number]): AgentToolMetadata {
  return {
    name: manifest.name,
    capability: manifest.capability,
    riskLevel: manifest.riskLevel,
    confirmationMode: manifest.confirmationMode,
    navigationTarget: manifest.navigationTarget,
  }
}

function agenticOsInventoryToolInput(
  tool: AgentToolMetadata,
): OpenAICompatibleEffectiveToolInventoryToolInput<'xox', AgentToolNavigationTarget> {
  return {
    name: tool.name,
    capability: tool.capability,
    riskLevel: tool.riskLevel,
    confirmationMode: tool.confirmationMode,
    navigationTarget: tool.navigationTarget,
    manualBoundaryNotice: isManualBoundaryNoticeToolName(tool.name),
    harnessManagedObservation: isHarnessManagedObservationToolName(tool.name),
  }
}

export function materializedToolInventorySnapshot(
  projection: RuntimeToolCatalogProjection,
  toolNames: readonly string[],
) {
  const metadataByName = new Map<string, AgentToolMetadata>()
  for (const metadata of projection.toolCapabilities) metadataByName.set(metadata.name, metadata)
  for (const manifest of projection.effectiveCatalog) {
    if (!metadataByName.has(manifest.name)) metadataByName.set(manifest.name, toolMetadataFromManifest(manifest))
  }
  const toolCapabilities = toolNames
    .map((name) => metadataByName.get(name))
    .filter((metadata): metadata is AgentToolMetadata => Boolean(metadata))

  return buildOpenAICompatibleEffectiveToolInventorySnapshot({
    snapshotId: newId(),
    userId: projection.inventorySnapshot.userId,
    workspaceId: projection.inventorySnapshot.workspaceId,
    automationLevel: projection.inventorySnapshot.automationLevel,
    provider: projection.inventorySnapshot.provider,
    model: projection.inventorySnapshot.model,
    source: projection.strategy,
    tools: toolCapabilities.map(agenticOsInventoryToolInput),
    provenance: 'xox',
    ...(projection.routerReason ? { routerReason: projection.routerReason } : {}),
    createdAt: utcNow(),
  })
}

export function buildRuntimeToolCatalogProjection(input?: {
  selectedCapabilities?: AgentToolCapability[] | null
  requiredActionCapabilities?: AgentToolCapability[] | null
  requiredToolNames?: string[] | null
  goalFacts?: AgentGoalFacts | null
  strategy?: ToolCatalogProjectionStrategy
  routerReason?: string
  message?: string
  settings?: Settings
  userId?: string
  workspaceId?: string
  automationLevel?: 'manual' | 'low' | 'medium' | 'high'
}): RuntimeToolCatalogProjection {
  const selectedCapabilities = safeCapabilities(input?.selectedCapabilities)
  const requiredActionCapabilities = safeCapabilities(input?.requiredActionCapabilities)
  const requiredToolNames = [...new Set((input?.requiredToolNames ?? []).filter((name): name is string =>
    typeof name === 'string' && name.trim().length > 0,
  ))]
  const goalFacts = sanitizeAgentGoalFacts(input?.goalFacts)
  const hasModelSelection = input?.selectedCapabilities !== undefined && input.selectedCapabilities !== null
  const requestedStrategy: ToolCatalogProjectionStrategy = input?.strategy ?? (hasModelSelection ? 'model_selected_capabilities' : 'full_registry')
  const toolContext = requestedStrategy === 'full_registry'
    ? null
    : buildToolContextPack({
        registry: AGENT_TOOL_REGISTRY,
        selectedCapabilities,
        requiredActionCapabilities,
        ...(input?.message !== undefined ? { message: input.message } : {}),
        ...(input?.routerReason !== undefined ? { routerReason: input.routerReason } : {}),
        ...(input?.automationLevel !== undefined ? { automationLevel: input.automationLevel } : {}),
      })
  const byName = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))
  const baseEntries = toolContext
    ? toolContext.toolNames.map((name) => byName.get(name)).filter((entry): entry is (typeof AGENT_TOOL_REGISTRY)[number] => Boolean(entry))
    : AGENT_TOOL_REGISTRY
  const strictObligationTools = input?.routerReason === 'runner-obligation-plan' && requiredToolNames.length > 0
  const allowedObligationToolNames = new Set([
    ...requiredToolNames,
    ...canonicalToolNamesForCapabilities(selectedCapabilities),
    ...OBLIGATION_CONTROL_TOOL_NAMES,
  ])
  const entries = strictObligationTools
    ? baseEntries.filter((entry) => allowedObligationToolNames.has(entry.name))
    : [...baseEntries]
  for (const name of requiredToolNames) {
    const entry = byName.get(name)
    if (!entry || entries.some((item) => item.name === entry.name)) continue
    entries.push(entry)
  }
  const strategy: ToolCatalogProjectionStrategy = toolContext ? 'progressive_tool_discovery' : requestedStrategy
  const visibleToolNames = entries.map((entry) => entry.name)
  const visibleToolNameSet = new Set(visibleToolNames)

  const toolCapabilities = entries.map(toolMetadata)
  const settings = input?.settings
  const inventorySnapshot = buildOpenAICompatibleEffectiveToolInventorySnapshot({
    snapshotId: newId(),
    userId: input?.userId ?? 'unknown_user',
    workspaceId: input?.workspaceId ?? 'unknown_workspace',
    automationLevel: input?.automationLevel ?? 'manual',
    provider: settings?.openaiCompatibleProvider ?? 'unknown',
    model: settings?.openaiCompatibleModel ?? 'unknown',
    source: strategy,
    tools: toolCapabilities.map(agenticOsInventoryToolInput),
    provenance: 'xox',
    ...(input?.routerReason ? { routerReason: redactSecretLikeContent(input.routerReason).slice(0, 300) } : {}),
    createdAt: utcNow(),
  })

  return {
    strategy,
    tools: entries.map((entry) => entry.tool),
    toolCount: entries.length,
    toolNames: visibleToolNames,
    toolCapabilities,
    selectedCapabilities,
    requiredActionCapabilities,
    goalFacts,
    inventorySnapshot,
    effectiveCatalog: toolContext?.effectiveCatalog ?? [],
    visibleTools: entries.map((entry) => entry.tool),
    visibleToolNames,
    kernelToolNames: (toolContext?.kernelToolNames ?? []).filter((name) => visibleToolNameSet.has(name)),
    materializableToolNames: (toolContext?.materializableToolNames ?? []).filter((name) => !visibleToolNameSet.has(name)),
    deferredCatalog: (toolContext?.deferredCatalog ?? []).filter((manifest) => !visibleToolNameSet.has(manifest.name)),
    replayAllowedToolNames: visibleToolNames,
    autoAddedControlNames: toolContext?.autoAddedControlNames ?? [],
    emptySurfaceStatus: toolContext?.emptySurfaceStatus ?? null,
    budget: toolContext?.budget ?? null,
    surfacePlan: toolContext?.surfacePlan ?? null,
    toolDescriptors: toolContext?.toolDescriptors ?? [],
    discoveryTrace: toolContext?.discoveryTrace ?? null,
    ...(input?.routerReason ? { routerReason: redactSecretLikeContent(input.routerReason).slice(0, 300) } : {}),
  }
}

function localToolDiscoverySelection() {
  return {
    selectedCapabilities: [],
    requiredActionCapabilities: [],
    goalFacts: {},
    routerReason: 'local-progressive-discovery',
  } satisfies {
    selectedCapabilities: AgentToolCapability[]
    requiredActionCapabilities: AgentToolCapability[]
    goalFacts: AgentGoalFacts
    routerReason: string
  }
}

function parseObservationContent(observation: AgentToolObservation) {
  try {
    const parsed = JSON.parse(observation.modelContent)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function discoveredToolNamesFromObservations(observations: readonly AgentToolObservation[] | undefined) {
  const names: string[] = []
  for (const observation of observations ?? []) {
    if (observation.toolName !== 'tool_discover' || observation.status !== 'completed') continue
    const content = parseObservationContent(observation)
    if (content?.observationType !== 'tool_discovery') continue
    const matched = Array.isArray(content.matchedToolNames) ? content.matchedToolNames : []
    for (const name of matched) {
      if (typeof name === 'string' && name.trim().length > 0) names.push(name.trim())
    }
  }
  return [...new Set(names)]
}

export async function provideRuntimeToolCatalog(ctx: ToolGatewayContext) {
  const baseGoalFacts = sanitizeAgentGoalFacts(ctx.goalFacts)
  const selection = ctx.loopObligationPlan
    ? {
        selectedCapabilities: ctx.loopObligationPlan.selectedCapabilities,
        requiredActionCapabilities: [
          ...ctx.loopObligationPlan.requiredActionCapabilities,
          ...(baseGoalFacts.requiredActionCapabilities ?? []),
        ],
        requiredToolNames: ctx.loopObligationPlan.requiredToolNames,
        goalFacts: mergeAgentGoalFacts(baseGoalFacts, ctx.loopObligationPlan.goalFacts),
        routerReason: 'runner-obligation-plan',
      }
    : {
        ...localToolDiscoverySelection(),
        requiredActionCapabilities: baseGoalFacts.requiredActionCapabilities ?? [],
        goalFacts: baseGoalFacts,
        requiredToolNames: discoveredToolNamesFromObservations(ctx.priorObservations),
      }
  const projection = buildRuntimeToolCatalogProjection({
    ...selection,
    ...(ctx.settings ? { settings: ctx.settings } : {}),
    ...(ctx.message ? { message: ctx.message } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx.automationLevel ? { automationLevel: ctx.automationLevel } : {}),
  })
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_catalog_ready',
    title: '工具目录已提供',
    message: `本轮向模型提供 ${projection.toolCount} 个 provider-native 工具，由模型通过 tool_calls 选择。`,
    status: 'running',
    data: {
      projectionStrategy: projection.strategy,
      toolCount: projection.toolCount,
      toolNames: projection.toolNames,
      toolCapabilities: projection.toolCapabilities,
      selectedCapabilities: projection.selectedCapabilities,
      requiredActionCapabilities: projection.requiredActionCapabilities,
      requiredToolNames: ctx.loopObligationPlan?.requiredToolNames ?? [],
      goalFacts: projection.goalFacts,
      inventorySnapshot: projection.inventorySnapshot,
      visibleToolNames: projection.visibleToolNames,
      kernelToolNames: projection.kernelToolNames,
      materializableToolNames: projection.materializableToolNames,
      deferredToolNames: projection.deferredCatalog.map((manifest) => manifest.name),
      replayAllowedToolNames: projection.replayAllowedToolNames,
      autoAddedControlNames: projection.autoAddedControlNames,
      emptySurfaceStatus: projection.emptySurfaceStatus,
      budget: projection.budget,
      surfacePlan: projection.surfacePlan,
      toolDescriptors: projection.toolDescriptors,
      discoveryTrace: projection.discoveryTrace,
      routerReason: projection.routerReason ?? null,
    },
  })
  return projection
}
