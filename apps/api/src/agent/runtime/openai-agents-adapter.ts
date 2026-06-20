import type {
  AgentToolCall,
  JsonObject,
  RuntimeToolDescriptor,
} from '@agentic-os/contracts'
import {
  inferToolAuthorityClass,
} from '@agentic-os/core'
import {
  runOpenAIAgentsTurn,
  type OpenAIAgentsRuntimeEvent,
} from '@agentic-os/runtime-openai-agents'
import { plannerSystemPrompt } from '../prompt-registry.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCallStep,
  type ChatTool,
} from '../tool-catalog.js'
import type { RuntimeAdapter, RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'

const SOURCE = 'openai_agents' as const
const toolRegistryByName = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))

function promptFromMessages(input: RuntimePlanningInput) {
  if (!input.messages || input.messages.length === 0) {
    return `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`
  }
  return input.messages
    .map((message) => {
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        return `assistant tool_calls: ${JSON.stringify(message.tool_calls)}`
      }
      if (message.role === 'tool') return `tool ${message.name ?? message.tool_call_id}: ${message.content}`
      return `${message.role}: ${message.content ?? ''}`
    })
    .join('\n')
}

function toRuntimeToolDescriptor(tool: ChatTool): RuntimeToolDescriptor {
  const name = tool.function.name
  const metadata = toolRegistryByName.get(name)
  const riskLevel = metadata?.riskLevel ?? 'read'
  const confirmationMode = metadata?.confirmationMode ?? 'never'
  const capability = metadata?.capability ?? 'tooling'
  return {
    name,
    title: name,
    description: tool.function.description,
    inputJsonSchema: toJsonObject(tool.function.parameters),
    capability,
    riskLevel,
    confirmationMode,
    authorityClass: inferToolAuthorityClass({
      capability,
      riskLevel,
      confirmationMode,
      manualBoundaryNotice: isManualBoundaryNoticeToolName(name),
      harnessManagedObservation: isHarnessManagedObservationToolName(name),
    }),
    navigationTarget: metadata?.navigationTarget ?? null,
  }
}

function plannerStepsFromRuntimeToolCalls(toolCalls: AgentToolCall[] | undefined): AgentToolCallStep[] {
  const steps: AgentToolCallStep[] = []
  for (const [index, call] of (toolCalls ?? []).entries()) {
    const step = toolCallToPlannerStep(call.name, call.input)
    if (!step) continue
    step.providerToolName = call.name
    step.providerToolArguments = call.input
    step.providerToolCallIndex = index
    step.providerToolCallId = call.toolCallId
    steps.push(step)
  }
  return steps
}

async function emitRuntimeEvent(input: RuntimePlanningInput, event: OpenAIAgentsRuntimeEvent) {
  if (!input.onStreamEvent) return
  if (event.kind === 'run_started') {
    await input.onStreamEvent({
      kind: 'stream_started',
      provider: event.provider,
      model: event.model,
      source: SOURCE,
    })
    return
  }
  if (event.kind === 'tool_call') {
    await input.onStreamEvent({
      kind: 'tool_call_delta',
      toolCallIndex: event.toolCallIndex,
      toolName: event.toolName,
      argumentsPreview: event.argumentsPreview,
    })
    return
  }
  await input.onStreamEvent({
    kind: 'stream_completed',
    contentLength: event.contentLength,
    toolCallCount: event.toolCallCount,
    source: SOURCE,
  })
}

function toJsonObject(value: unknown): JsonObject {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function safeRuntimeErrorMessage(error: string) {
  return error
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .slice(0, 300)
}

export class OpenAIAgentsAdapter implements RuntimeAdapter {
  readonly name = 'openai-agents'

  async plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
    if (!input.settings.openaiApiKey) {
      return {
        source: SOURCE,
        steps: [],
        error: { kind: 'missing_api_key' },
      }
    }

    try {
      const output = await runOpenAIAgentsTurn({
        userMessage: input.message,
        context: input.context,
        tools: input.tools.map(toRuntimeToolDescriptor),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      }, {
        apiKey: input.settings.openaiApiKey,
        ...(input.settings.openaiBaseUrl ? { baseURL: input.settings.openaiBaseUrl } : {}),
        model: input.settings.openaiModel,
        agentName: 'XOX Agent Planner',
        instructions: input.systemPrompt ?? plannerSystemPrompt(),
        buildPrompt: () => promptFromMessages(input),
        onEvent: (event) => emitRuntimeEvent(input, event),
      })
      if (output.error) {
        return {
          source: SOURCE,
          steps: [],
          error: {
            kind: 'provider_network_error',
            message: safeRuntimeErrorMessage(output.error),
          },
        }
      }

      const steps = plannerStepsFromRuntimeToolCalls(output.toolCalls)

      return steps.length > 0
        ? { source: SOURCE, steps }
        : output.assistantText?.trim()
          ? { source: SOURCE, steps: [], assistantText: output.assistantText.trim() }
          : { source: SOURCE, steps: [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        source: SOURCE,
        steps: [],
        error: {
          kind: 'provider_network_error',
          message: message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***').slice(0, 300),
        },
      }
    }
  }
}
