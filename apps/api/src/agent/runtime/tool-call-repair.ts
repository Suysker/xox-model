import { toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'
import {
  normalizeProviderToolCallsForExecution,
  parseToolArguments as parseProviderToolArguments,
  ProviderToolCallBoundaryError,
  repairToolName,
  type ToolArgumentRepairPolicy,
} from '@agentic-os/runtime-openai-compatible'
import type {
  RuntimeToolCallBoundaryViolation,
  ToolCallBoundaryViolationCode,
} from './runtime-adapter.js'

export { repairToolName }

const TOOL_CALL_BOUNDARY_CODES = new Set<ToolCallBoundaryViolationCode>([
  'tool_call_registered_but_deferred',
  'tool_call_not_in_effective_inventory',
  'tool_call_without_registered_handler',
  'tool_call_arguments_truncated',
  'tool_call_arguments_invalid',
  'tool_call_stream_interrupted',
])

function xoxBoundaryCode(value: string): ToolCallBoundaryViolationCode | null {
  return TOOL_CALL_BOUNDARY_CODES.has(value as ToolCallBoundaryViolationCode)
    ? value as ToolCallBoundaryViolationCode
    : null
}

export class ProviderToolCallParseError extends ProviderToolCallBoundaryError {
  constructor(
    message: string,
    toolNames: string[],
    failedToolName?: string,
    boundaryCode?: ToolCallBoundaryViolationCode,
    effectiveToolNames: readonly string[] = [],
  ) {
    super(message, toolNames, failedToolName, boundaryCode, effectiveToolNames)
    this.name = 'ProviderToolCallParseError'
  }

  static from(error: ProviderToolCallBoundaryError): ProviderToolCallParseError {
    const code = error.boundaryCode ? xoxBoundaryCode(error.boundaryCode) : null
    return new ProviderToolCallParseError(
      error.message,
      error.toolNames,
      error.failedToolName,
      code ?? undefined,
      error.effectiveToolNames,
    )
  }

  override boundaryViolation(): RuntimeToolCallBoundaryViolation | undefined {
    const boundary = super.boundaryViolation()
    if (!boundary) return undefined
    const code = xoxBoundaryCode(boundary.code)
    if (!code) return undefined
    return {
      code,
      ...(boundary.toolName ? { toolName: boundary.toolName } : {}),
      toolNames: [...(boundary.toolNames ?? [])],
      effectiveToolNames: [...(boundary.effectiveToolNames ?? [])],
    }
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

export function parseToolArguments(raw: unknown, policy?: ToolArgumentRepairPolicy) {
  return parseProviderToolArguments(raw, policy)
}

export function plannerStepsFromProviderToolCalls(input: {
  toolCalls: unknown
  allowedToolNames: readonly string[]
  materializableToolNames?: readonly string[]
  options?: ProviderToolCallParseOptions
}): AgentToolCallStep[] {
  let calls: ReturnType<typeof normalizeProviderToolCallsForExecution>
  try {
    calls = normalizeProviderToolCallsForExecution({
      toolCalls: input.toolCalls,
      allowedToolNames: input.allowedToolNames,
      materializableToolNames: input.materializableToolNames ?? [],
      ...(input.options?.argumentRepair ? { argumentRepair: input.options.argumentRepair } : {}),
      ...(input.options?.onArgumentRepaired ? { onArgumentRepaired: input.options.onArgumentRepaired } : {}),
    })
  } catch (error) {
    if (error instanceof ProviderToolCallBoundaryError) throw ProviderToolCallParseError.from(error)
    throw error
  }

  const steps: AgentToolCallStep[] = []
  const observedNames: string[] = []
  for (const call of calls) {
    const step = toolCallToPlannerStep(call.toolName, call.arguments)
    if (!step) {
      throw new ProviderToolCallParseError(
        `Provider emitted tool call "${call.toolName}" but no planner handler is registered for it.`,
        [call.toolName, ...observedNames.filter((name) => name !== call.toolName)],
        call.toolName,
        'tool_call_without_registered_handler',
        input.allowedToolNames,
      )
    }
    step.providerToolName = call.toolName
    step.providerToolArguments = call.arguments
    step.providerToolCallIndex = call.providerToolCallIndex
    if (call.providerToolCallId) step.providerToolCallId = call.providerToolCallId
    steps.push(step)
    observedNames.push(call.toolName)
  }
  return steps
}
