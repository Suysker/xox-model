import type { AgentToolExecutionObservation, AgentToolInventorySnapshot } from '@xox/contracts'
import {
  buildToolSupervisorFailureObservation,
  createToolSupervisorCall,
  shouldBlockToolCallOutsideInventory,
  summarizeToolSupervisorObservation,
  toolSupervisorInventoryByName,
  type ToolSupervisorProducedItem,
} from '@agentic-os/core'
import type { PlannerContext } from '../planning-context.js'
import {
  buildPlannedItemFromRuntimeStep,
  isActionDraft,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
  type PlannedItemResult,
  type ReadDraft,
  type RuntimePlannerStep,
} from '../action-draft-builder.js'
import { redactSecretLikeContent } from '../memory.js'
import { addRunEvent } from '../run-events.js'
import { toolCallCompletedEvent, toolCallStartedEvent } from './tool-execution-events.js'

// Inspired by OpenAI Agents JS tool execution and OpenClaw's tool loop events,
// but constrained to xox-model's observation/action-draft boundary.

export type ToolCallSupervisorResult = {
  items: PlannedItem[]
  observations: AgentToolExecutionObservation[]
}

function flattenItemResult(result: PlannedItemResult): PlannedItem[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

function supervisorFailureRead(input: {
  title: string
  message: string
  toolName: string
  toolCallId?: string
  toolArguments: Record<string, unknown>
}): ReadDraft {
  return {
    ...buildToolSupervisorFailureObservation(input),
    readKind: 'tool_observation',
  }
}

function supervisorProducedItem(item: PlannedItem): ToolSupervisorProducedItem {
  if (isActionDraft(item)) {
    return {
      kind: 'action',
      title: item.title,
      preview: `已生成动作草稿：${item.title}`,
    }
  }

  const produced: ToolSupervisorProducedItem = {
    kind: 'observation',
    title: item.title,
    message: item.message,
    preview: item.message,
  }
  if (item.status !== undefined) produced.status = item.status
  if (item.observationStatus !== undefined) produced.observationStatus = item.observationStatus
  if (item.observationOutcome !== undefined) produced.observationOutcome = item.observationOutcome
  if (item.modelContent !== undefined) produced.modelContent = item.modelContent
  if (item.syntheticObservation !== undefined) produced.syntheticObservation = item.syntheticObservation
  return produced
}

async function addToolRuntimeEvent(
  ctx: PlannerContext,
  input: {
    type: 'tool_call_started' | 'tool_call_completed' | 'tool_call_failed'
    title: string
    message: string
    status: 'running' | 'completed' | 'failed'
    data: Record<string, unknown>
  },
) {
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: input.type,
    title: input.title,
    message: input.message,
    status: input.status,
    data: input.data,
  })
}

export async function superviseRuntimeToolCalls(
  ctx: PlannerContext,
  input: {
    steps: RuntimePlannerStep[]
    handlers: ActionDraftBuilderHandlers<PlannerContext>
    inventorySnapshot?: AgentToolInventorySnapshot | null
    emitRunEvents?: boolean
  },
): Promise<ToolCallSupervisorResult> {
  const items: PlannedItem[] = []
  const observations: AgentToolExecutionObservation[] = []
  const inventoryByName = toolSupervisorInventoryByName(input.inventorySnapshot?.tools ?? [])

  for (const [index, step] of input.steps.entries()) {
    const call = createToolSupervisorCall({ step, index })
    const toolName = call.toolName
    const toolArguments = call.arguments
    const inventoryTool = inventoryByName.get(toolName)
    const toolCallId = call.toolCallId

    const started = toolCallStartedEvent({
      runId: ctx.runId,
      toolName,
      toolCallId,
      arguments: toolArguments,
    })
    if (input.emitRunEvents === true) {
      await addToolRuntimeEvent(ctx, {
        type: 'tool_call_started',
        title: '工具调用开始',
        message: `开始处理模型选择的工具：${toolName}`,
        status: 'running',
        data: {
          runtimeEvent: {
            ...started,
            payload: { argumentsPreview: redactSecretLikeContent(JSON.stringify(toolArguments)).slice(0, 1000) },
          },
          inventorySnapshotId: input.inventorySnapshot?.snapshotId ?? null,
        },
      })
    }

    if (shouldBlockToolCallOutsideInventory({
      providerToolName: call.providerToolName,
      inventoryPresent: Boolean(input.inventorySnapshot),
      inventoryItem: inventoryTool ?? null,
    })) {
      const item = supervisorFailureRead({
        title: '工具调用被阻止',
        message: `模型选择了当前工具目录之外的工具：${toolName}`,
        toolName,
        toolCallId,
        toolArguments,
      })
      items.push(item)
      const observation = summarizeToolSupervisorObservation({
        call,
        producedItems: [supervisorProducedItem(item)],
        authorityClass: 'manual_only',
      }) as AgentToolExecutionObservation
      observations.push(observation)
      if (input.emitRunEvents === true) {
        await addToolRuntimeEvent(ctx, {
          type: 'tool_call_failed',
          title: '工具调用被阻止',
          message: item.message,
          status: 'failed',
          data: { runtimeEvent: toolCallCompletedEvent({ runId: ctx.runId, observation }) },
        })
      }
      continue
    }

    const result = await buildPlannedItemFromRuntimeStep(ctx, step, input.handlers)
    const producedItems = flattenItemResult(result)
    if (producedItems.length === 0) {
      producedItems.push(supervisorFailureRead({
        title: '工具未生成业务结果',
        message: `工具 ${toolName} 没有生成可执行动作或可观察结果。`,
        toolName,
        toolCallId,
        toolArguments,
      }))
    }
    items.push(...producedItems)
    const observation = summarizeToolSupervisorObservation({
      call,
      producedItems: producedItems.map(supervisorProducedItem),
      authorityClass: inventoryTool?.authorityClass ?? 'read',
    }) as AgentToolExecutionObservation
    const hasFailure = observation.status !== 'completed'
    observations.push(observation)
    if (input.emitRunEvents === true) {
      await addToolRuntimeEvent(ctx, {
        type: hasFailure ? 'tool_call_failed' : 'tool_call_completed',
        title: hasFailure ? '工具调用失败' : '工具调用完成',
        message: observation.resultPreview ?? `工具调用完成：${toolName}`,
        status: hasFailure ? 'failed' : 'completed',
        data: { runtimeEvent: toolCallCompletedEvent({ runId: ctx.runId, observation }) },
      })
    }
  }

  return { items, observations }
}
