import type { AgentPlannerSource, AgentToolInventorySnapshot } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import type { AgentToolCallStep, ChatTool } from '../tool-catalog.js'

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
