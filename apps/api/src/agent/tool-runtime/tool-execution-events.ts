import type { AgentToolExecutionObservation, AgentToolInventorySnapshot, AgentToolRuntimeEvent } from '@xox/contracts'
import {
  buildToolCallCompletedEvent,
  buildToolCallStartedEvent,
  buildToolInventoryReadyEvent,
  type ToolExecutionObservation,
  type ToolInventoryEventSnapshotLike,
} from '@agentic-os/core'

export function inventoryReadyEvent(input: {
  runId: string
  inventory: AgentToolInventorySnapshot
}): AgentToolRuntimeEvent {
  return {
    ...buildToolInventoryReadyEvent({
      runId: input.runId,
      inventory: input.inventory as ToolInventoryEventSnapshotLike,
    }),
    summary: `工具目录已生成：${input.inventory.tools.length} 个工具，${input.inventory.source}。`,
  } as AgentToolRuntimeEvent
}
export function toolCallStartedEvent(input: {
  runId: string
  toolName: string
  toolCallId?: string | null
  arguments: Record<string, unknown>
}): AgentToolRuntimeEvent {
  return {
    ...buildToolCallStartedEvent(input),
    summary: `工具调用开始：${input.toolName}`,
  } as AgentToolRuntimeEvent
}

export function toolCallCompletedEvent(input: {
  runId: string
  observation: AgentToolExecutionObservation
}): AgentToolRuntimeEvent {
  return {
    ...buildToolCallCompletedEvent({
      runId: input.runId,
      observation: input.observation as ToolExecutionObservation,
    }),
    summary: input.observation.resultPreview ?? `工具调用${input.observation.status === 'completed' ? '完成' : '失败'}：${input.observation.toolName}`,
  } as AgentToolRuntimeEvent
}
