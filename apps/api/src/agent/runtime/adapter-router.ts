import { OpenAIAgentsAdapter } from './openai-agents-adapter.js'
import { OpenAICompatibleChatAdapter } from './openai-compatible-chat-adapter.js'
import type { RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'

const openAIAgentsAdapter = new OpenAIAgentsAdapter()
const openAICompatibleChatAdapter = new OpenAICompatibleChatAdapter()

export async function planWithRuntimeAdapter(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
  if (input.settings.llmProvider === 'rules') return null
  if (input.settings.llmProvider === 'openai') return openAIAgentsAdapter.plan(input)
  return openAICompatibleChatAdapter.plan(input)
}
