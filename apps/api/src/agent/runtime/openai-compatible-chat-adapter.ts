import { plannerSystemPrompt } from '../prompt-registry.js'
import { AGENT_TOOL_CATALOG, toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'
import type { RuntimeAdapter, RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'

function parseToolArguments(raw: unknown) {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
}

function plannerStepsFromToolCalls(toolCalls: unknown): AgentToolCallStep[] {
  if (!Array.isArray(toolCalls)) return []
  const steps: AgentToolCallStep[] = []
  for (const toolCall of toolCalls) {
    const fn = (toolCall as any)?.function
    const name = fn?.name
    if (typeof name !== 'string') continue
    const args = parseToolArguments(fn?.arguments)
    const step = toolCallToPlannerStep(name, args)
    if (step) steps.push(step)
  }
  return steps
}

export class OpenAICompatibleChatAdapter implements RuntimeAdapter {
  readonly name = 'openai-compatible-chat'

  async plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
    if (!input.settings.openaiCompatibleApiKey) return null

    try {
      const response = await fetch(`${input.settings.openaiCompatibleBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.settings.openaiCompatibleApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.settings.openaiCompatibleModel,
          messages: [
            { role: 'system', content: plannerSystemPrompt() },
            { role: 'user', content: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}` },
          ],
          tools: AGENT_TOOL_CATALOG,
          tool_choice: 'auto',
          temperature: 0,
          max_tokens: 1600,
        }),
      })

      if (!response.ok) return null
      const body = (await response.json()) as any
      const message = body?.choices?.[0]?.message
      const toolSteps = plannerStepsFromToolCalls(message?.tool_calls)
      return toolSteps.length > 0 ? { source: 'openai_compatible_tool_calls', steps: toolSteps } : null
    } catch {
      return null
    }
  }
}
