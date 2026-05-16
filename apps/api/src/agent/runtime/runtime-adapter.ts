import type { AgentPlannerSource } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import type { AgentToolCallStep } from '../tool-catalog.js'

export type RuntimePlannerSource = Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>

export type RuntimePlanResult = {
  source: RuntimePlannerSource
  steps: AgentToolCallStep[]
}

export type RuntimePlanningInput = {
  settings: Settings
  message: string
  context: unknown
}

export interface RuntimeAdapter {
  readonly name: string
  plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null>
}
