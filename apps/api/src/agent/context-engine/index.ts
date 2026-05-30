import { buildAgentContextPack } from '../context-pack.js'

export type AgentContextEngineInput = Parameters<typeof buildAgentContextPack>[0]
export type AgentContextEngineOutput = Awaited<ReturnType<typeof buildAgentContextPack>>

export async function buildAgentContext(input: AgentContextEngineInput): Promise<AgentContextEngineOutput> {
  return buildAgentContextPack(input)
}
