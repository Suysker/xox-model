import type { ChatTool } from '../tool-catalog.js'

export const HIGH_VOLUME_STRUCTURED_TOOL_NAME = 'workspace_configure_operating_model'
export const HIGH_VOLUME_STRUCTURED_MAX_TOKENS = 48_000
export const HIGH_VOLUME_STRUCTURED_TIMEOUT_MS = 360_000

export function isHighVolumeStructuredToolName(toolName?: string | null) {
  return toolName === HIGH_VOLUME_STRUCTURED_TOOL_NAME
}

export function hasHighVolumeStructuredTool(tools: readonly ChatTool[]) {
  return tools.some((tool) => isHighVolumeStructuredToolName(tool.function.name))
}
