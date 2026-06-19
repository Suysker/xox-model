import type {
  AgentNextStep,
  AgentToolCall,
  JsonObject,
  RuntimeTurnOutput,
} from '@agentic-os/contracts'
import { TurnResolver } from '@agentic-os/core'
import type { RuntimePlanResult } from '../runtime/runtime-adapter.js'

function toJsonObject(value: unknown): JsonObject {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function xoxStepToAgentToolCall(input: {
  step: RuntimePlanResult['steps'][number]
  index: number
}): AgentToolCall {
  const name = input.step.providerToolName ?? input.step.intent ?? `xox_unknown_tool_${input.index + 1}`
  return {
    toolCallId: input.step.providerToolCallId ?? `xox_step_${input.index + 1}`,
    name,
    input: toJsonObject(input.step.providerToolArguments ?? input.step),
  }
}

export function runtimePlanResultToAgenticOsTurnOutput(result: RuntimePlanResult | null): RuntimeTurnOutput {
  if (!result) {
    return {
      error: 'Runtime adapter returned no plan result.',
    }
  }

  if (result.error) {
    return {
      error: result.error.message ?? result.error.kind,
    }
  }

  const output: RuntimeTurnOutput = {}
  if (result.assistantText?.trim()) {
    output.assistantText = result.assistantText
  }

  const toolCalls = result.steps.map((step, index) => xoxStepToAgentToolCall({ step, index }))
  if (toolCalls.length > 0) {
    output.toolCalls = toolCalls
  }

  return output
}

export function resolveRuntimePlanWithAgenticOs(result: RuntimePlanResult | null): AgentNextStep {
  return new TurnResolver().resolve(runtimePlanResultToAgenticOsTurnOutput(result))
}
