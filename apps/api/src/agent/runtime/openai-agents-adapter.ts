import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents'
import { plannerSystemPrompt } from '../prompt-registry.js'
import { toolCallToPlannerStep, type AgentToolCallStep, type ChatTool } from '../tool-catalog.js'
import type { RuntimeAdapter, RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'

const SOURCE = 'openai_agents' as const
const TOOL_ARGUMENT_PREVIEW_LIMIT = 700

function previewToolArguments(args: Record<string, unknown>) {
  return JSON.stringify(args).slice(0, TOOL_ARGUMENT_PREVIEW_LIMIT)
}

function buildPlannerTools(tools: ChatTool[], collectedSteps: AgentToolCallStep[], runtimeInput: RuntimePlanningInput) {
  return tools.map((descriptor) => {
    const name = descriptor.function.name
    return tool({
      name,
      description: descriptor.function.description,
      parameters: descriptor.function.parameters as any,
      strict: false,
      execute: async (args) => {
        const toolInput = args && typeof args === 'object' ? args as Record<string, unknown> : {}
        const step = toolCallToPlannerStep(name, toolInput)
        if (step) collectedSteps.push(step)
        await runtimeInput.onStreamEvent?.({
          kind: 'tool_call_delta',
          toolCallIndex: step ? collectedSteps.length - 1 : collectedSteps.length,
          toolName: name,
          argumentsPreview: previewToolArguments(toolInput),
        })
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
    let modelProvider: OpenAIProvider | null = null
    try {
      modelProvider = new OpenAIProvider({
        apiKey: input.settings.openaiApiKey,
        baseURL: input.settings.openaiBaseUrl,
        useResponses: false,
      })
      const planner = new Agent({
        name: 'XOX Agent Planner',
        instructions: input.systemPrompt ?? plannerSystemPrompt(),
        model: input.settings.openaiModel,
        tools: buildPlannerTools(input.tools, collectedSteps, input),
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

      await input.onStreamEvent?.({
        kind: 'stream_started',
        provider: 'openai',
        model: input.settings.openaiModel,
        source: SOURCE,
      })
      const result = await runner.run(
        planner,
        `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`,
        {
          maxTurns: 2,
          toolExecution: { maxFunctionToolConcurrency: 1 },
          ...(input.abortSignal ? { signal: input.abortSignal } : {}),
        },
      )
      await input.onStreamEvent?.({
        kind: 'stream_completed',
        contentLength: typeof (result as any)?.finalOutput === 'string' ? (result as any).finalOutput.length : 0,
        toolCallCount: collectedSteps.length,
        source: SOURCE,
      })

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
    } finally {
      await modelProvider?.close().catch(() => undefined)
    }
  }
}
