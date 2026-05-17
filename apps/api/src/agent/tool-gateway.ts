import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { addRunEvent } from './run-events.js'
import { AGENT_TOOL_REGISTRY, type AgentToolMetadata, type ChatTool } from './tool-catalog.js'

type ToolGatewayContext = {
  db: Kysely<Database>
  threadId: string
  runId: string
}

export type ToolCatalogProjectionStrategy = 'full_registry'

export type RuntimeToolCatalogProjection = {
  strategy: ToolCatalogProjectionStrategy
  tools: ChatTool[]
  toolCount: number
  toolNames: string[]
  toolCapabilities: AgentToolMetadata[]
}

export function buildRuntimeToolCatalogProjection(): RuntimeToolCatalogProjection {
  return {
    strategy: 'full_registry',
    tools: AGENT_TOOL_REGISTRY.map((entry) => entry.tool),
    toolCount: AGENT_TOOL_REGISTRY.length,
    toolNames: AGENT_TOOL_REGISTRY.map((entry) => entry.name),
    toolCapabilities: AGENT_TOOL_REGISTRY.map((entry) => ({
      name: entry.name,
      capability: entry.capability,
      riskLevel: entry.riskLevel,
      confirmationMode: entry.confirmationMode,
      navigationTarget: entry.navigationTarget,
    })),
  }
}

export async function provideRuntimeToolCatalog(ctx: ToolGatewayContext) {
  const projection = buildRuntimeToolCatalogProjection()
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_catalog_ready',
    title: '工具目录已提供',
    message: `本轮向模型提供 ${projection.toolCount} 个 provider-native 工具，由模型通过 tool_calls 选择。`,
    status: 'running',
    data: {
      projectionStrategy: projection.strategy,
      toolCount: projection.toolCount,
      toolNames: projection.toolNames,
      toolCapabilities: projection.toolCapabilities,
    },
  })
  return projection
}
