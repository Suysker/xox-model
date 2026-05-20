import type { AgentPlannerSource } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import type { AgentToolCallStep, ChatTool } from '../tool-catalog.js'

export type RuntimePlannerSource = Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>

export type RuntimePlanError = {
  kind: 'missing_api_key' | 'provider_http_error' | 'provider_network_error' | 'provider_response_error' | 'provider_timeout'
  statusCode?: number
  message?: string
  toolNames?: string[]
  classification?: 'unsupported_parameter' | 'auth' | 'billing' | 'rate_limit' | 'context_overflow' | 'server' | 'http'
}

export type RuntimePlanResult = {
  source: RuntimePlannerSource
  steps: AgentToolCallStep[]
  assistantText?: string
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

export type RuntimePlanningInput = {
  settings: Settings
  message: string
  context: unknown
  tools: ChatTool[]
  systemPrompt?: string
  stream?: boolean
  maxTokens?: number
  requestTimeoutMs?: number
  abortSignal?: AbortSignal
  onStreamEvent?: (event: RuntimeStreamEvent) => void | Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null>
}
