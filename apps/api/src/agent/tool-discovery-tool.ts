import type { ReadDraft, RuntimePlannerStep } from './action-draft-builder.js'
import type { PlannerContext } from './planning-context.js'
import { AGENT_TOOL_REGISTRY } from './tool-catalog.js'
import { buildToolManifests } from './tool-context-engine/tool-manifest.js'
import { createToolSearchIndex, searchToolIndex } from './tool-context-engine/tool-search-index.js'
import { toolSearchDocumentsFromManifests } from './tool-context-engine/tool-search-document.js'

function clampMaxResults(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(12, Math.floor(value)))
    : 8
}

function requestedToolNames(step: RuntimePlannerStep) {
  return Array.isArray(step.toolNames)
    ? step.toolNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : []
}

function descriptor(manifest: ReturnType<typeof buildToolManifests>[number]) {
  return {
    name: manifest.name,
    title: manifest.title,
    summary: manifest.summary,
    capability: manifest.capability,
    riskLevel: manifest.riskLevel,
    confirmationMode: manifest.confirmationMode,
    navigationTarget: manifest.navigationTarget,
    parameterNames: manifest.parameterNames,
  }
}

export async function runToolDiscovery(_ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const query = typeof step.query === 'string' && step.query.trim()
    ? step.query.trim()
    : typeof step.question === 'string' && step.question.trim()
      ? step.question.trim()
      : ''
  const maxResults = clampMaxResults(step.maxResults ?? step.limit)
  const manifests = buildToolManifests(AGENT_TOOL_REGISTRY)
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]))
  const exactNames = requestedToolNames(step)
  const exactMatches = exactNames
    .map((name) => byName.get(name))
    .filter((manifest): manifest is ReturnType<typeof buildToolManifests>[number] => Boolean(manifest))
  const exactNameSet = new Set(exactMatches.map((manifest) => manifest.name))
  const index = createToolSearchIndex(toolSearchDocumentsFromManifests(manifests))
  const searchMatches = query
    ? searchToolIndex(index, query, { limit: maxResults * 2 })
      .map((hit) => byName.get(hit.name))
      .filter((manifest): manifest is ReturnType<typeof buildToolManifests>[number] => Boolean(manifest))
      .filter((manifest) => !exactNameSet.has(manifest.name))
    : []
  const matched = [...exactMatches, ...searchMatches].slice(0, maxResults)
  const matchedToolNames = matched.map((manifest) => manifest.name)
  const descriptors = matched.map(descriptor)
  const displayPreview = matchedToolNames.length > 0
    ? `找到 ${matchedToolNames.length} 个可物化工具：${matchedToolNames.join('、')}`
    : '没有找到匹配的可物化工具。'

  return {
    title: '查找可用工具',
    message: displayPreview,
    readKind: 'tool_observation',
    status: 'executed',
    displayPreview,
    modelContent: JSON.stringify({
      observationType: 'tool_discovery',
      query,
      matchedToolNames,
      descriptors,
      instruction: matchedToolNames.length > 0
        ? 'If one of these tools is needed, continue the objective. The next runner turn can materialize the real provider schema for matchedToolNames.'
        : 'No matching deferred tools were found in the current scoped inventory.',
    }),
    observationStatus: 'completed',
    observationOutcome: 'completed_valid',
  }
}
