import type { ChatTool } from '../tool-catalog.js'
import type { ProviderModelProfile } from './provider-model-profile.js'

// OpenClaw-inspired provider schema boundary. Implementation is project-local and
// keeps xox-model tool metadata/types out of external provider runtimes.
type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOpenAIStrictSchema(schema: unknown, root = true): unknown {
  if (Array.isArray(schema)) return schema.map((item) => normalizeOpenAIStrictSchema(item, false))
  if (!isObject(schema)) return schema

  const next: JsonObject = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      next.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeOpenAIStrictSchema(propertySchema, false),
        ]),
      )
      continue
    }
    if (['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf'].includes(key)) {
      next[key] = normalizeOpenAIStrictSchema(value, false)
      continue
    }
    next[key] = value
  }

  const looksLikeObject =
    root ||
    next.type === 'object' ||
    (isObject(next.properties) && !Array.isArray(next.required))
  if (looksLikeObject) {
    next.type = next.type ?? 'object'
    next.properties = isObject(next.properties) ? next.properties : {}
    if (!Array.isArray(next.required)) next.required = []
    if (!Object.hasOwn(next, 'additionalProperties')) next.additionalProperties = false
  }
  return next
}

function stripUnsupportedKeywords(schema: unknown, unsupported: ReadonlySet<string>): unknown {
  if (Array.isArray(schema)) return schema.map((item) => stripUnsupportedKeywords(item, unsupported))
  if (!isObject(schema)) return schema
  const next: JsonObject = {}
  for (const [key, value] of Object.entries(schema)) {
    if (unsupported.has(key)) continue
    next[key] = stripUnsupportedKeywords(value, unsupported)
  }
  return next
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  'additionalProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'pattern',
  'format',
])

export function normalizeProviderToolSchemas(
  tools: ChatTool[],
  profile: ProviderModelProfile,
): ChatTool[] {
  if (profile.schemaProfile !== 'openai-strict' && profile.schemaProfile !== 'gemini') return tools
  return tools.map((tool) => {
    const parameters = tool.function.parameters
    if (!parameters || typeof parameters !== 'object') return tool
    const normalizedParameters = profile.schemaProfile === 'gemini'
      ? stripUnsupportedKeywords(parameters, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS)
      : normalizeOpenAIStrictSchema(parameters)
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: normalizedParameters as ChatTool['function']['parameters'],
      },
    }
  })
}
