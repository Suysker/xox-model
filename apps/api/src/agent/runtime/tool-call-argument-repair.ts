import { extractBalancedJson } from './balanced-json.js'

export type ToolArgumentRepairPolicy = {
  enabled: boolean
  maxBufferChars?: number
  maxLeadingChars?: number
  maxTrailingChars?: number
}

export type ToolArgumentParseResult = {
  args: Record<string, unknown>
  repaired: boolean
  leadingChars: number
  trailingChars: number
}

export const DEFAULT_TOOL_ARGUMENT_REPAIR_POLICY: Required<ToolArgumentRepairPolicy> = {
  enabled: true,
  maxBufferChars: 64_000,
  maxLeadingChars: 160,
  maxTrailingChars: 16,
}

function normalizePolicy(policy?: ToolArgumentRepairPolicy): Required<ToolArgumentRepairPolicy> {
  return {
    enabled: policy?.enabled ?? DEFAULT_TOOL_ARGUMENT_REPAIR_POLICY.enabled,
    maxBufferChars: policy?.maxBufferChars ?? DEFAULT_TOOL_ARGUMENT_REPAIR_POLICY.maxBufferChars,
    maxLeadingChars: policy?.maxLeadingChars ?? DEFAULT_TOOL_ARGUMENT_REPAIR_POLICY.maxLeadingChars,
    maxTrailingChars: policy?.maxTrailingChars ?? DEFAULT_TOOL_ARGUMENT_REPAIR_POLICY.maxTrailingChars,
  }
}

function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseJsonObject(jsonText: string) {
  return objectRecord(JSON.parse(jsonText) as unknown)
}

export function parseToolArgumentsWithRepair(
  raw: unknown,
  policy?: ToolArgumentRepairPolicy,
): ToolArgumentParseResult {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, repaired: false, leadingChars: 0, trailingChars: 0 }
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { args: {}, repaired: false, leadingChars: 0, trailingChars: 0 }
  }

  const normalized = normalizePolicy(policy)
  const trimmed = raw.trim()
  if (trimmed.length > normalized.maxBufferChars) {
    throw new SyntaxError(`Tool arguments exceed repair buffer limit ${normalized.maxBufferChars}`)
  }

  try {
    return { args: parseJsonObject(trimmed), repaired: false, leadingChars: 0, trailingChars: 0 }
  } catch (error) {
    if (!normalized.enabled) throw error
  }

  const extracted = extractBalancedJson(raw)
  if (!extracted?.complete) {
    throw new SyntaxError('Tool arguments did not contain a complete balanced JSON object')
  }

  const leadingChars = extracted.leadingText.trim().length
  const trailingChars = extracted.trailingText.trim().length
  if (leadingChars > normalized.maxLeadingChars || trailingChars > normalized.maxTrailingChars) {
    throw new SyntaxError(
      `Tool arguments pollution exceeded bounds: leading=${leadingChars}, trailing=${trailingChars}`,
    )
  }

  return {
    args: parseJsonObject(extracted.jsonText),
    repaired: true,
    leadingChars,
    trailingChars,
  }
}
