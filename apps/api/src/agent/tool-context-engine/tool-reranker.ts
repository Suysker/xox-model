import type { AgentToolCapability } from '../tool-catalog.js'
import type { ToolManifest } from './tool-manifest.js'
import { createToolSearchIndex, searchToolIndex, type ToolSearchHit } from './tool-search-index.js'
import { toolSearchDocumentsFromManifests } from './tool-search-document.js'

export type RankedToolManifest = {
  manifest: ToolManifest
  score: number
  reasons: string[]
  searchHit?: ToolSearchHit
}

const FACT_DEPENDENT_CAPABILITIES = new Set<AgentToolCapability>([
  'draft',
  'ledger',
  'share',
  'version',
])

const CANONICAL_TOOLS_BY_CAPABILITY: Partial<Record<AgentToolCapability, string[]>> = {
  data: ['data_query_workspace'],
  draft: ['workspace_patch_config', 'workspace_configure_operating_model', 'workspace_rename'],
  import_export: ['workspace_export_bundle', 'workspace_import_bundle'],
  ledger: ['ledger_create_member_income', 'ledger_create_entry'],
  memory: ['memory_search', 'memory_remember'],
  navigation: ['ui_navigate'],
  sandbox: ['sandbox_run_code'],
  share: ['share_create', 'share_revoke'],
  version: ['workspace_save_snapshot', 'workspace_publish_release', 'workspace_rollback_version'],
}

export function canonicalToolNamesForCapabilities(capabilities: AgentToolCapability[]) {
  return [...new Set(capabilities.flatMap((capability) => CANONICAL_TOOLS_BY_CAPABILITY[capability] ?? []))]
}

function uniqueCapabilities(values: AgentToolCapability[]) {
  return [...new Set(values)]
}

function selectedCapabilitySet(selectedCapabilities: AgentToolCapability[]) {
  return new Set<AgentToolCapability>(uniqueCapabilities(selectedCapabilities))
}

function isAllowedByCapability(manifest: ToolManifest, selectedCapabilities: AgentToolCapability[]) {
  if (manifest.capability === 'account' || manifest.capability === 'clarification') return true
  const selected = selectedCapabilitySet(selectedCapabilities)
  if (selected.size === 0) return false
  if (selected.has(manifest.capability)) return true
  return manifest.name === 'data_query_workspace' && [...selected].some((capability) => FACT_DEPENDENT_CAPABILITIES.has(capability))
}

function workflowPrerequisiteNames(manifests: ToolManifest[], selectedCapabilities: AgentToolCapability[]) {
  const selected = selectedCapabilitySet(selectedCapabilities)
  const prerequisites = new Set<string>()
  for (const manifest of manifests) {
    if (!selected.has(manifest.capability)) continue
    for (const toolName of manifest.prerequisiteTools) prerequisites.add(toolName)
  }
  if ([...selected].some((capability) => FACT_DEPENDENT_CAPABILITIES.has(capability))) {
    prerequisites.add('data_query_workspace')
  }
  return prerequisites
}

export function rankToolManifests(input: {
  manifests: ToolManifest[]
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities?: AgentToolCapability[]
  message?: string
  routerReason?: string
}): RankedToolManifest[] {
  const allowed = input.manifests.filter((manifest) => isAllowedByCapability(manifest, input.selectedCapabilities))
  const requiredCanonicalTools = new Set(canonicalToolNamesForCapabilities(input.requiredActionCapabilities ?? []))
  const searchQuery = [
    input.message ?? '',
    input.routerReason ?? '',
    ...input.selectedCapabilities,
    ...(input.requiredActionCapabilities ?? []),
  ].join(' ')
  const index = createToolSearchIndex(toolSearchDocumentsFromManifests(allowed))
  const searchHits = new Map(searchToolIndex(index, searchQuery).map((hit) => [hit.name, hit]))
  const prerequisites = workflowPrerequisiteNames(input.manifests, input.selectedCapabilities)

  const ranked = allowed.map((manifest) => {
    const hit = searchHits.get(manifest.name)
    const reasons: string[] = []
    let score = hit?.score ?? 0

    if (hit) {
      reasons.push('retrieval')
    }
    if (input.selectedCapabilities.includes(manifest.capability)) {
      score += 0.75
      reasons.push(`capability:${manifest.capability}`)
    }
    if ((CANONICAL_TOOLS_BY_CAPABILITY[manifest.capability] ?? []).includes(manifest.name)) {
      score += 2
      reasons.push('canonical_capability_tool')
    }
    if (requiredCanonicalTools.has(manifest.name)) {
      score += 120
      reasons.push('required_action_capability')
    }
    if (prerequisites.has(manifest.name)) {
      score += 5
      reasons.push('workflow_prerequisite')
    }
    if (manifest.capability === 'clarification') {
      score += 0.2
      reasons.push('clarification_available')
    }
    if (manifest.capability === 'account') {
      score += 0.1
      reasons.push('account_guardrail')
    }
    if (manifest.riskLevel === 'read') {
      score += 0.25
      reasons.push('read_first')
    }

    return {
      manifest,
      score,
      reasons,
      ...(hit ? { searchHit: hit } : {}),
    }
  })

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.manifest.riskLevel === 'read' && right.manifest.riskLevel !== 'read') return -1
    if (right.manifest.riskLevel === 'read' && left.manifest.riskLevel !== 'read') return 1
    return left.manifest.name.localeCompare(right.manifest.name)
  })

  return ranked
}
