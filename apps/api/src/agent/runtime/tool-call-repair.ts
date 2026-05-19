import { toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'

// OpenClaw-inspired provider output repair boundary. This only normalizes
// provider-emitted tool-call names/arguments after the model selected a tool.
export class ProviderToolCallParseError extends Error {
  constructor(
    message: string,
    readonly toolNames: string[],
    readonly failedToolName?: string,
  ) {
    super(message)
    this.name = 'ProviderToolCallParseError'
  }
}

export type ProviderToolCall = {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: unknown
  }
}

function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function repairToolName(rawName: unknown, allowedToolNames: readonly string[], toolCallId?: unknown) {
  const candidates = [rawName, toolCallId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => {
      const trimmed = value.trim()
      const withoutPrefix = trimmed.replace(/^(?:functions?|tools?)[./:_-]+/i, '')
      return [
        trimmed,
        withoutPrefix,
        withoutPrefix.split(/[./:]/).at(-1) ?? withoutPrefix,
      ]
    })

  for (const candidate of candidates) {
    const exact = allowedToolNames.find((name) => name === candidate)
    if (exact) return exact
  }

  const normalizedAllowed = new Map(allowedToolNames.map((name) => [normalizedName(name), name]))
  for (const candidate of candidates) {
    const match = normalizedAllowed.get(normalizedName(candidate))
    if (match) return match
  }

  for (const candidate of candidates) {
    const compactCandidate = normalizedName(candidate)
    const match = allowedToolNames.find((name) => compactCandidate.includes(normalizedName(name)))
    if (match) return match
  }

  return null
}

function extractBalancedJson(raw: string) {
  const start = raw.search(/[\[{]/)
  if (start < 0) return raw.trim()
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    if (depth === 0) return raw.slice(start, index + 1)
  }
  return raw.slice(start).trim()
}

export function parseToolArguments(raw: unknown) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const parsed = JSON.parse(extractBalancedJson(raw)) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

export function plannerStepsFromProviderToolCalls(input: {
  toolCalls: unknown
  allowedToolNames: readonly string[]
}): AgentToolCallStep[] {
  if (!Array.isArray(input.toolCalls)) return []
  const steps: AgentToolCallStep[] = []
  const observedNames: string[] = []
  for (const toolCall of input.toolCalls as ProviderToolCall[]) {
    const repairedName = repairToolName(
      toolCall?.function?.name,
      input.allowedToolNames,
      toolCall?.id,
    )
    if (!repairedName) continue
    try {
      const args = parseToolArguments(toolCall?.function?.arguments)
      const step = toolCallToPlannerStep(repairedName, args)
      if (step) steps.push(step)
      observedNames.push(repairedName)
    } catch (error) {
      const toolNames = [
        repairedName,
        ...observedNames.filter((name) => name !== repairedName),
      ]
      throw new ProviderToolCallParseError(
        error instanceof Error ? error.message : String(error),
        [...new Set(toolNames)],
        repairedName,
      )
    }
  }
  return steps
}
