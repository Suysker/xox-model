import type { AgentToolExecutionObservation, AgentToolInventorySnapshot, AgentToolRuntimeEvent } from '@xox/contracts'

function runStatusForToolObservation(status: AgentToolExecutionObservation['status']) {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

export function inventoryReadyEvent(input: {
  runId: string
  inventory: AgentToolInventorySnapshot
}): AgentToolRuntimeEvent {
  return {
    kind: 'inventory_ready',
    runId: input.runId,
    status: 'running',
    summary: `工具目录已生成：${input.inventory.tools.length} 个工具，${input.inventory.source}。`,
    payload: {
      snapshotId: input.inventory.snapshotId,
      source: input.inventory.source,
      freshness: input.inventory.freshness,
      toolCount: input.inventory.tools.length,
      capabilities: input.inventory.capabilities,
    },
  }
}
export function toolCallStartedEvent(input: {
  runId: string
  toolName: string
  toolCallId?: string | null
  arguments: Record<string, unknown>
}): AgentToolRuntimeEvent {
  return {
    kind: 'tool_call_started',
    runId: input.runId,
    toolName: input.toolName,
    toolCallId: input.toolCallId ?? null,
    status: 'running',
    summary: `工具调用开始：${input.toolName}`,
    payload: { arguments: input.arguments },
  }
}

export function toolCallCompletedEvent(input: {
  runId: string
  observation: AgentToolExecutionObservation
}): AgentToolRuntimeEvent {
  return {
    kind: input.observation.status === 'completed' ? 'tool_call_completed' : 'tool_call_failed',
    runId: input.runId,
    toolName: input.observation.toolName,
    toolCallId: input.observation.toolCallId,
    status: runStatusForToolObservation(input.observation.status),
    summary: input.observation.resultPreview ?? `工具调用${input.observation.status === 'completed' ? '完成' : '失败'}：${input.observation.toolName}`,
    payload: {
      observationStatus: input.observation.status,
      outcome: input.observation.outcome ?? null,
      authorityClass: input.observation.authorityClass,
      errorMessage: input.observation.errorMessage ?? null,
    },
  }
}
