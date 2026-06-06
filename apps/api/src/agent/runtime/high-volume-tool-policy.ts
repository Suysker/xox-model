import type { ChatTool } from '../tool-catalog.js'

export const HIGH_VOLUME_STRUCTURED_TOOL_NAMES = [
  'workspace_configure_operating_model',
  'sandbox_run_code',
] as const
export const HIGH_VOLUME_STRUCTURED_MAX_TOKENS = 48_000
export const HIGH_VOLUME_STRUCTURED_TIMEOUT_MS = 360_000

export function isHighVolumeStructuredToolName(toolName?: string | null) {
  return typeof toolName === 'string' &&
    (HIGH_VOLUME_STRUCTURED_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function highVolumeStructuredToolName(tools: readonly ChatTool[]) {
  const toolNames = new Set(tools.map((tool) => tool.function.name))
  return HIGH_VOLUME_STRUCTURED_TOOL_NAMES.find((name) => toolNames.has(name)) ?? null
}

export function hasHighVolumeStructuredTool(tools: readonly ChatTool[]) {
  return highVolumeStructuredToolName(tools) !== null
}
