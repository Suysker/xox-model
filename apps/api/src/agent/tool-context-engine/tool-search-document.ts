import type { AgentToolCapability } from '../tool-catalog.js'
import type { ToolManifest } from './tool-manifest.js'

export type ToolSearchDocument = {
  name: string
  capability: AgentToolCapability
  text: string
  searchHints: string[]
  parameterNames: string[]
  entityTags: string[]
}

export function toolSearchDocumentFromManifest(manifest: ToolManifest): ToolSearchDocument {
  return {
    name: manifest.name,
    capability: manifest.capability,
    text: [
      manifest.name,
      manifest.title,
      manifest.summary,
      ...manifest.searchHints,
      ...manifest.entityTags,
      ...manifest.parameterNames,
      ...manifest.requiredFacts,
      ...manifest.resolvesFacts,
    ].join(' '),
    searchHints: manifest.searchHints,
    parameterNames: manifest.parameterNames,
    entityTags: manifest.entityTags,
  }
}

export function toolSearchDocumentsFromManifests(manifests: ToolManifest[]): ToolSearchDocument[] {
  return manifests.map(toolSearchDocumentFromManifest)
}
