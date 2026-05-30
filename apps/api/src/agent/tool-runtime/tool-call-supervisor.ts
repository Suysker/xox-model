import type { AgentToolExecutionObservation, AgentToolInventorySnapshot } from '@xox/contracts'
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

function safeToolArguments(step: RuntimePlannerStep) {
  return step.providerToolArguments && typeof step.providerToolArguments === 'object'
    ? step.providerToolArguments
    : {}
}

function fallbackToolName(step: RuntimePlannerStep, index: number) {
  return step.providerToolName ?? step.intent ?? `unknown_tool_${index + 1}`
}

function failedRead(input: {
  title: string
  message: string
  toolName: string
  toolCallId?: string
  toolArguments: Record<string, unknown>
}): ReadDraft {
  return {
    title: input.title,
    message: input.message,
    readKind: 'tool_observation',
    status: 'failed',
    toolName: input.toolName,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    toolArguments: input.toolArguments,
    displayPreview: input.message,
    modelContent: JSON.stringify({
      observationType: 'tool_supervisor_failure',
      toolName: input.toolName,
      toolCallId: input.toolCallId ?? null,
      message: input.message,
    }),
  }
}

function resultPreview(items: PlannedItem[]) {
  const first = items[0]
  if (!first) return '工具调用没有生成业务结果。'
  if (isActionDraft(first)) return `已生成动作草稿：${first.title}`
  return first.message
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
  const inventoryByName = new Map((input.inventorySnapshot?.tools ?? []).map((tool) => [tool.name, tool]))

  for (const [index, step] of input.steps.entries()) {
    const toolName = fallbackToolName(step, index)
    const toolArguments = safeToolArguments(step)
    const inventoryTool = inventoryByName.get(toolName)
    const toolCallId = step.providerToolCallId ?? `supervised_${index}_${toolName}`

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

    if (step.providerToolName && input.inventorySnapshot && !inventoryTool) {
      const item = failedRead({
        title: '工具调用被阻止',
        message: `模型选择了当前工具目录之外的工具：${toolName}`,
        toolName,
        toolCallId,
        toolArguments,
      })
      items.push(item)
      const observation: AgentToolExecutionObservation = {
        toolName,
        toolCallId,
        status: 'failed',
        authorityClass: 'manual_only',
        arguments: toolArguments,
        errorMessage: item.message,
      }
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
      producedItems.push(failedRead({
        title: '工具未生成业务结果',
        message: `工具 ${toolName} 没有生成可执行动作或可观察结果。`,
        toolName,
        toolCallId,
        toolArguments,
      }))
    }
    items.push(...producedItems)
    const hasFailure = producedItems.some((item) => !isActionDraft(item) && item.status === 'failed')
    const observation: AgentToolExecutionObservation = {
      toolName,
      toolCallId,
      status: hasFailure ? 'failed' : 'completed',
      authorityClass: inventoryTool?.authorityClass ?? 'read',
      arguments: toolArguments,
      resultPreview: resultPreview(producedItems),
      ...(hasFailure ? { errorMessage: resultPreview(producedItems) } : {}),
    }
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
