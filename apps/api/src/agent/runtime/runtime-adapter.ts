import type { AgentPlannerSource } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import type { AgentToolCallStep } from '../tool-catalog.js'

export type RuntimePlannerSource = Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>

export type RuntimePlanError = {
  kind: 'missing_api_key' | 'provider_http_error' | 'provider_network_error'
  statusCode?: number
  message?: string
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
      kind: 'stream_completed'
      contentLength: number
      toolCallCount: number
    }

export type RuntimePlanningInput = {
  settings: Settings
  message: string
  context: unknown
  abortSignal?: AbortSignal
  onStreamEvent?: (event: RuntimeStreamEvent) => void | Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null>
}
