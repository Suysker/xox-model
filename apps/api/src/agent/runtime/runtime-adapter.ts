import type { AgentPlannerSource, AgentToolInventorySnapshot } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import type { AgentToolCallStep, ChatTool } from '../tool-catalog.js'

export type RuntimePlannerSource = Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>

export type RuntimePlanError = {
  kind: 'missing_api_key' | 'provider_http_error' | 'provider_network_error' | 'provider_response_error' | 'provider_timeout'
  statusCode?: number
  message?: string
  toolNames?: string[]
  classification?: 'unsupported_parameter' | 'auth' | 'billing' | 'rate_limit' | 'context_overflow' | 'server' | 'http' | 'unmaterialized_tool_call' | 'unregistered_tool'
}

export type RuntimePlanResult = {
  source: RuntimePlannerSource
  steps: AgentToolCallStep[]
  assistantText?: string
  toolInventorySnapshot?: AgentToolInventorySnapshot
  error?: RuntimePlanError
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
  messages?: RuntimeChatMessage[]
  systemPrompt?: string
  stream?: boolean
  disableThinking?: boolean
  maxTokens?: number
  requestTimeoutMs?: number
  abortSignal?: AbortSignal
  onStreamEvent?: (event: RuntimeStreamEvent) => void | Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null>
}
