import type {
  AgentAutomationLevel,
  AgentToolInventorySnapshot,
} from '@xox/contracts'
import { inferToolAuthorityClass } from '@agentic-os/core'
import type { Settings } from '../../core/settings.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import {
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  type AgentToolCapability,
  type AgentToolMetadata,
} from '../tool-catalog.js'
import {
  providerCompatibilityFlags,
  resolveProviderModelProfile,
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
      authorityClass: inferToolAuthorityClass({
        capability: tool.capability,
        riskLevel: tool.riskLevel,
        confirmationMode: tool.confirmationMode,
        manualBoundaryNotice: isManualBoundaryNoticeToolName(tool.name),
        harnessManagedObservation: isHarnessManagedObservationToolName(tool.name),
      }),
      providerCompatibility: compatibility,
      provenance: 'xox',
    })),
    ...(input.routerReason ? { routerReason: input.routerReason } : {}),
    createdAt: input.createdAt ?? utcNow(),
  }
}
