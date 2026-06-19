import type {
  AgentAutomationLevel,
  AgentToolAuthorityClass,
  AgentToolInventorySnapshot,
} from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { AgentToolCapability, AgentToolMetadata } from '../tool-catalog.js'
import {
  resolveProviderModelProfile,
  type ProviderModelProfile,
} from '@agentic-os/runtime-openai-compatible'

// Inspired by OpenClaw's effective tool inventory boundary, adapted for xox-model's SaaS authority model.

export type EffectiveToolInventoryInput = {
  userId: string
  workspaceId: string
  automationLevel: AgentAutomationLevel
  settings?: Settings
  provider?: string
  model?: string
  strategy: 'full_registry' | 'model_selected_capabilities' | 'progressive_tool_discovery'
  toolCapabilities: AgentToolMetadata[]
  selectedCapabilities: AgentToolCapability[]
  routerReason?: string
  snapshotId?: string
  createdAt?: string
}

export function authorityClassForTool(tool: AgentToolMetadata): AgentToolAuthorityClass {
  if (tool.capability === 'account') return 'manual_only'
  if (tool.capability === 'sandbox') return 'sandbox_compute'
  if (tool.confirmationMode !== 'never' || tool.riskLevel !== 'read' || tool.capability === 'memory') {
    return 'confirmation_write'
  }
  return 'read'
}

export function providerCompatibilityFlags(profile: ProviderModelProfile) {
  const flags: string[] = [profile.apiFamily]
  flags.push(profile.supportsTools ? 'tools' : 'no_tools')
  flags.push(profile.supportsStreaming ? 'streaming' : 'no_streaming')
  flags.push(profile.supportsParallelToolCalls ? 'parallel_tool_calls' : 'serial_tool_calls')
  flags.push(`tool_choice_${profile.toolChoicePolicy}`)
  flags.push(`schema_${profile.schemaProfile ?? 'generic'}`)
  if (profile.streamArgumentRepair !== 'off') flags.push(`stream_repair_${profile.streamArgumentRepair}`)
  if (profile.replayPolicy) flags.push(`replay_${profile.replayPolicy}`)
  return flags
}

export function buildEffectiveToolInventorySnapshot(input: EffectiveToolInventoryInput): AgentToolInventorySnapshot {
  const profile = resolveProviderModelProfile({
    provider: input.settings?.openaiCompatibleProvider ?? input.provider ?? 'unknown',
    model: input.settings?.openaiCompatibleModel ?? input.model ?? 'unknown',
  })
  const compatibility = providerCompatibilityFlags(profile)
  const capabilities = [...new Set(input.toolCapabilities.map((tool) => tool.capability))]

  return {
    snapshotId: input.snapshotId ?? newId(),
    userId: input.userId,
    workspaceId: input.workspaceId,
    provider: profile.provider,
    model: profile.requestModel,
    automationLevel: input.automationLevel,
    source: input.strategy,
    freshness: 'fresh',
    capabilities,
    tools: input.toolCapabilities.map((tool) => ({
      name: tool.name,
      capability: tool.capability,
      risk: tool.riskLevel,
      confirmationMode: tool.confirmationMode,
      navigationTarget: tool.navigationTarget,
      authorityClass: authorityClassForTool(tool),
      providerCompatibility: compatibility,
      provenance: 'xox',
    })),
    ...(input.routerReason ? { routerReason: input.routerReason } : {}),
    createdAt: input.createdAt ?? utcNow(),
  }
}
