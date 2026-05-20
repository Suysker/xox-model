import type { AgentToolCallStep } from '../tool-catalog.js'
import {
  plannerStepsFromProviderToolCalls,
  type ProviderToolCallParseOptions,
} from './tool-call-repair.js'

export function validateProviderToolCallsForExecution(input: {
  toolCalls: unknown
  allowedToolNames: readonly string[]
  options?: ProviderToolCallParseOptions
}): AgentToolCallStep[] {
  const base = {
    toolCalls: input.toolCalls,
    allowedToolNames: input.allowedToolNames,
  }
  return plannerStepsFromProviderToolCalls(input.options ? { ...base, options: input.options } : base)
}
