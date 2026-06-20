import type {
  AgentToolCall,
  JsonObject,
  RuntimeToolDescriptor,
} from '@agentic-os/contracts'
import { createRuntimePlanRouter, inferToolAuthorityClass } from '@agentic-os/core'
import {
  runOpenAIAgentsTurn,
  type OpenAIAgentsRuntimeEvent,
} from '@agentic-os/runtime-openai-agents'
import type { AgentPlannerSource, AgentToolInventorySnapshot } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import { plannerSystemPrompt } from '../prompt-registry.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCallStep,
  type ChatTool,
} from '../tool-catalog.js'
import { OpenAICompatibleChatAdapter } from './openai-compatible-chat-adapter.js'

export type RuntimePlannerSource = Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>

export type RuntimeProviderErrorClassification =
  | 'unsupported_parameter'
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'context_overflow'
  | 'server'
  | 'http'

export type ToolCallBoundaryViolationCode =
  | 'tool_call_registered_but_deferred'
  | 'tool_call_not_in_effective_inventory'
  | 'tool_call_without_registered_handler'
  | 'tool_call_arguments_truncated'
  | 'tool_call_arguments_invalid'
  | 'tool_call_stream_interrupted'

export type RuntimeToolCallBoundaryViolation = {
  code: ToolCallBoundaryViolationCode
  toolName?: string
  toolNames: string[]
  effectiveToolNames: string[]
}

export type RuntimePlanError = {
  kind: 'missing_api_key' | 'provider_http_error' | 'provider_network_error' | 'provider_response_error' | 'provider_timeout'
  statusCode?: number
  message?: string
  toolNames?: string[]
  classification?: RuntimeProviderErrorClassification
  toolCallBoundary?: RuntimeToolCallBoundaryViolation
}

export type RuntimePlanResult = {
  source: RuntimePlannerSource
  steps: AgentToolCallStep[]
  assistantText?: string
  providerAssistantMessage?: Extract<RuntimeChatMessage, { role: 'assistant' }>
  providerArtifact?: RuntimeProviderArtifact
  toolInventorySnapshot?: AgentToolInventorySnapshot
  error?: RuntimePlanError
}

export type RuntimeProviderArtifact = {
  family: string
  thinkingLevel?: string
  reasoningText?: string
}

export type RuntimeStreamEvent =
  | {
      kind: 'stream_started'
      provider: string
      model: string
      source: RuntimePlannerSource
      requestTimeoutMs?: number
    }
  | {
      kind: 'content_delta'
      delta: string
      preview: string
    }
  | {
      kind: 'tool_call_delta'
      toolCallIndex: number
      toolName?: string
      argumentsDelta?: string
      argumentsPreview?: string
    }
  | {
      kind: 'tool_call_repaired'
      toolName: string
      toolCallId?: string
      leadingChars: number
      trailingChars: number
    }
  | {
      kind: 'tool_call_damage'
      toolCallIndex: number
      toolName?: string
      boundaryCode: ToolCallBoundaryViolationCode
      message: string
      retryable: boolean
    }
  | {
      kind: 'stream_completed'
      contentLength: number
      toolCallCount: number
      source?: RuntimePlannerSource
    }

export type RuntimeChatMessage =
  | {
      role: 'system' | 'user'
      content: string
    }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
  | {
      role: 'tool'
      content: string
      tool_call_id: string
      name?: string
    }

export type RuntimePlanningInput = {
  settings: Settings
  message: string
  context: unknown
  tools: ChatTool[]
  materializableToolNames?: string[]
  messages?: RuntimeChatMessage[]
  systemPrompt?: string
  stream?: boolean
  thinkingLevel?: string
  maxTokens?: number
  requestTimeoutMs?: number
  abortSignal?: AbortSignal
  onStreamEvent?: (event: RuntimeStreamEvent) => void | Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null>
}

const OPENAI_AGENTS_SOURCE = 'openai_agents' as const
const toolRegistryByName = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))

function promptFromOpenAIAgentsMessages(input: RuntimePlanningInput) {
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

function openAIAgentsRuntimeToolDescriptor(tool: ChatTool): RuntimeToolDescriptor {
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

function plannerStepsFromOpenAIAgentsToolCalls(toolCalls: AgentToolCall[] | undefined): AgentToolCallStep[] {
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

async function emitOpenAIAgentsRuntimeEvent(input: RuntimePlanningInput, event: OpenAIAgentsRuntimeEvent) {
  if (!input.onStreamEvent) return
  if (event.kind === 'run_started') {
    await input.onStreamEvent({
      kind: 'stream_started',
      provider: event.provider,
      model: event.model,
      source: OPENAI_AGENTS_SOURCE,
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
    source: OPENAI_AGENTS_SOURCE,
  })
}

function toJsonObject(value: unknown): JsonObject {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function safeOpenAIAgentsRuntimeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .slice(0, 300)
}

async function planWithOpenAIAgentsRuntime(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
  if (!input.settings.openaiApiKey) {
    return {
      source: OPENAI_AGENTS_SOURCE,
      steps: [],
      error: { kind: 'missing_api_key' },
    }
  }

  try {
    const output = await runOpenAIAgentsTurn({
      userMessage: input.message,
      context: input.context,
      tools: input.tools.map(openAIAgentsRuntimeToolDescriptor),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    }, {
      apiKey: input.settings.openaiApiKey,
      ...(input.settings.openaiBaseUrl ? { baseURL: input.settings.openaiBaseUrl } : {}),
      model: input.settings.openaiModel,
      agentName: 'XOX Agent Planner',
      instructions: input.systemPrompt ?? plannerSystemPrompt(),
      buildPrompt: () => promptFromOpenAIAgentsMessages(input),
      onEvent: (event) => emitOpenAIAgentsRuntimeEvent(input, event),
    })
    if (output.error) {
      return {
        source: OPENAI_AGENTS_SOURCE,
        steps: [],
        error: {
          kind: 'provider_network_error',
          message: safeOpenAIAgentsRuntimeErrorMessage(output.error),
        },
      }
    }

    const steps = plannerStepsFromOpenAIAgentsToolCalls(output.toolCalls)

    return steps.length > 0
      ? { source: OPENAI_AGENTS_SOURCE, steps }
      : output.assistantText?.trim()
        ? { source: OPENAI_AGENTS_SOURCE, steps: [], assistantText: output.assistantText.trim() }
        : { source: OPENAI_AGENTS_SOURCE, steps: [] }
  } catch (error) {
    return {
      source: OPENAI_AGENTS_SOURCE,
      steps: [],
      error: {
        kind: 'provider_network_error',
        message: safeOpenAIAgentsRuntimeErrorMessage(error),
      },
    }
  }
}

export function configuredRuntimePlannerSource(
  settings: Settings,
): Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'> | null {
  if (settings.llmProvider === 'rules') return null
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

const openAICompatibleChatAdapter = new OpenAICompatibleChatAdapter()

export const planWithRuntimeAdapter = createRuntimePlanRouter<RuntimePlanningInput, RuntimePlanResult | null>({
  routes: [
    {
      routeId: 'rules',
      when: (input) => input.settings.llmProvider === 'rules',
      plan: () => null,
    },
    {
      routeId: 'openai',
      when: (input) => input.settings.llmProvider === 'openai',
      plan: (input) => planWithOpenAIAgentsRuntime(input),
    },
  ],
  fallback: (input) => openAICompatibleChatAdapter.plan(input),
})
