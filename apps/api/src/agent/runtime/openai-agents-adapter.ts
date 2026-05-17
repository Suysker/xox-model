import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents'
import { plannerSystemPrompt } from '../prompt-registry.js'
import { AGENT_TOOL_CATALOG, toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'
import type { RuntimeAdapter, RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'

const SOURCE = 'openai_agents' as const

function buildPlannerTools(collectedSteps: AgentToolCallStep[]) {
  return AGENT_TOOL_CATALOG.map((descriptor) => {
    const name = descriptor.function.name
    return tool({
      name,
      description: descriptor.function.description,
      parameters: descriptor.function.parameters as any,
      strict: false,
      execute: (args) => {
        const input = args && typeof args === 'object' ? args as Record<string, unknown> : {}
        const step = toolCallToPlannerStep(name, input)
        if (step) collectedSteps.push(step)
        return JSON.stringify({ planned: Boolean(step), tool: name })
      },
    })
  })
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

    const collectedSteps: AgentToolCallStep[] = []
    try {
      const modelProvider = new OpenAIProvider({
        apiKey: input.settings.openaiApiKey,
        baseURL: input.settings.openaiBaseUrl,
        useResponses: false,
      })
      const planner = new Agent({
        name: 'XOX Agent Planner',
        instructions: plannerSystemPrompt(),
        model: input.settings.openaiModel,
        tools: buildPlannerTools(collectedSteps),
        toolUseBehavior: () => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: JSON.stringify({ plannedSteps: collectedSteps.length }),
        }),
      })
      const runner = new Runner({
        modelProvider,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
      })

      const result = await runner.run(
        planner,
        `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`,
        {
          maxTurns: 2,
          toolExecution: { maxFunctionToolConcurrency: 1 },
        },
      )
      await modelProvider.close()

      return collectedSteps.length > 0
        ? { source: SOURCE, steps: collectedSteps }
        : typeof (result as any)?.finalOutput === 'string' && (result as any).finalOutput.trim()
          ? { source: SOURCE, steps: [], assistantText: (result as any).finalOutput.trim() }
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
