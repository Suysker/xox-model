import { toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'
import {
  extractBalancedJson,
  parseToolArgumentsWithRepair,
  repairToolName,
  type ToolArgumentRepairPolicy,
} from '@agentic-os/runtime-openai-compatible'
import type { RuntimeToolCallBoundaryViolation, ToolCallBoundaryViolationCode } from './runtime-adapter.js'

// OpenClaw-inspired provider output repair boundary. This only normalizes
// provider-emitted tool-call names/arguments after the model selected a tool.
export class ProviderToolCallParseError extends Error {
  constructor(
    message: string,
    readonly toolNames: string[],
    readonly failedToolName?: string,
    readonly boundaryCode?: ToolCallBoundaryViolationCode,
    readonly effectiveToolNames: readonly string[] = [],
  ) {
    super(message)
    this.name = 'ProviderToolCallParseError'
  }

  boundaryViolation(): RuntimeToolCallBoundaryViolation | undefined {
    if (!this.boundaryCode) return undefined
    return {
      code: this.boundaryCode,
      ...(this.failedToolName ? { toolName: this.failedToolName } : {}),
      toolNames: this.toolNames,
      effectiveToolNames: [...this.effectiveToolNames],
    }
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

export type ProviderToolCallParseOptions = {
  argumentRepair?: ToolArgumentRepairPolicy
  onArgumentRepaired?: (event: {
    toolName: string
    toolCallId?: string
    leadingChars: number
    trailingChars: number
  }) => void
}

export { repairToolName }

export function parseToolArguments(raw: unknown, policy?: ToolArgumentRepairPolicy) {
  return parseToolArgumentsWithRepair(raw, policy).args
}

function argumentBoundaryCode(raw: unknown): ToolCallBoundaryViolationCode {
  if (typeof raw !== 'string' || !raw.trim()) return 'tool_call_arguments_invalid'
  const extracted = extractBalancedJson(raw)
  return extracted && !extracted.complete
    ? 'tool_call_arguments_truncated'
    : 'tool_call_arguments_invalid'
}

export function plannerStepsFromProviderToolCalls(input: {
  toolCalls: unknown
  allowedToolNames: readonly string[]
  materializableToolNames?: readonly string[]
  options?: ProviderToolCallParseOptions
}): AgentToolCallStep[] {
  if (!Array.isArray(input.toolCalls)) return []
  const steps: AgentToolCallStep[] = []
  const observedNames: string[] = []
  for (const [index, toolCall] of (input.toolCalls as ProviderToolCall[]).entries()) {
    const rawToolName = typeof toolCall?.function?.name === 'string' && toolCall.function.name.trim()
      ? toolCall.function.name.trim()
      : typeof toolCall?.id === 'string' && toolCall.id.trim()
        ? toolCall.id.trim()
        : `tool_call_${index}`
    const repairedName = repairToolName(
      toolCall?.function?.name,
      input.allowedToolNames,
      toolCall?.id,
    )
    if (!repairedName) {
      const materializableName = repairToolName(
        toolCall?.function?.name,
        input.materializableToolNames ?? [],
        toolCall?.id,
      )
      if (materializableName) {
        throw new ProviderToolCallParseError(
          `Provider emitted deferred tool call "${materializableName}" before the tool schema was materialized.`,
          [materializableName],
          materializableName,
          'tool_call_registered_but_deferred',
          input.allowedToolNames,
        )
      }
      throw new ProviderToolCallParseError(
        `Provider emitted tool call "${rawToolName}" outside the current effective tool inventory.`,
        [rawToolName],
        rawToolName,
        'tool_call_not_in_effective_inventory',
        input.allowedToolNames,
      )
    }
    try {
      const parsedArguments = parseToolArgumentsWithRepair(toolCall?.function?.arguments, input.options?.argumentRepair)
      if (parsedArguments.repaired) {
        input.options?.onArgumentRepaired?.({
          toolName: repairedName,
          ...(typeof toolCall?.id === 'string' ? { toolCallId: toolCall.id } : {}),
          leadingChars: parsedArguments.leadingChars,
          trailingChars: parsedArguments.trailingChars,
        })
      }
      const args = parsedArguments.args
      const step = toolCallToPlannerStep(repairedName, args)
      if (step) {
        step.providerToolName = repairedName
        step.providerToolArguments = args
        step.providerToolCallIndex = index
        if (typeof toolCall?.id === 'string' && toolCall.id.trim()) step.providerToolCallId = toolCall.id
        steps.push(step)
      } else {
        throw new ProviderToolCallParseError(
          `Provider emitted tool call "${repairedName}" but no planner handler is registered for it.`,
          [repairedName, ...observedNames.filter((name) => name !== repairedName)],
          repairedName,
          'tool_call_without_registered_handler',
          input.allowedToolNames,
        )
      }
      observedNames.push(repairedName)
    } catch (error) {
      if (error instanceof ProviderToolCallParseError) throw error
      const toolNames = [
        repairedName,
        ...observedNames.filter((name) => name !== repairedName),
      ]
      throw new ProviderToolCallParseError(
        error instanceof Error ? error.message : String(error),
        [...new Set(toolNames)],
        repairedName,
        argumentBoundaryCode(toolCall?.function?.arguments),
        input.allowedToolNames,
      )
    }
  }
  return steps
}
