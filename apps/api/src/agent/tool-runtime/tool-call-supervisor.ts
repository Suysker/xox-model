import type { AgentToolExecutionObservation, AgentToolInventorySnapshot } from '@xox/contracts'
import {
  runToolCallSupervisor,
  type ToolRuntimeEvent,
  type ToolSupervisorFailureContext,
  type ToolSupervisorFailureCopy,
  type ToolSupervisorFailureObservation,
  type ToolSupervisorProducedItem,
  type ToolSupervisorRunInput,
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

// Inspired by OpenAI Agents JS tool execution and OpenClaw's tool loop events,
// but constrained to xox-model's observation/action-draft boundary.

export type ToolCallSupervisorResult = {
  items: PlannedItem[]
  observations: AgentToolExecutionObservation[]
}

type ToolInventoryItem = AgentToolInventorySnapshot['tools'][number]

function flattenItemResult(result: PlannedItemResult): PlannedItem[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

function supervisorFailureRead(input: ToolSupervisorFailureObservation): ReadDraft {
  return {
    ...input,
    readKind: 'tool_observation',
  }
}

function supervisorFailureCopy(
  input: ToolSupervisorFailureContext<RuntimePlannerStep, ToolInventoryItem, AgentToolInventorySnapshot>,
): ToolSupervisorFailureCopy {
  if (input.reason === 'outside_inventory') {
    return {
      title: '工具调用被阻止',
      message: `模型选择了当前工具目录之外的工具：${input.call.toolName}`,
    }
  }
  return {
    title: '工具未生成业务结果',
    message: `工具 ${input.call.toolName} 没有生成可执行动作或可观察结果。`,
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

function runtimeEventWithSummary(event: ToolRuntimeEvent, summary: string): ToolRuntimeEvent {
  return { ...event, summary }
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
  const supervisorInput: ToolSupervisorRunInput<
    RuntimePlannerStep,
    PlannedItem,
    ToolInventoryItem,
    AgentToolInventorySnapshot
  > = {
    runId: ctx.runId,
    steps: input.steps,
    inventoryTools: input.inventorySnapshot?.tools ?? null,
    inventorySnapshot: input.inventorySnapshot ?? null,
    executeToolCall: async ({ step }) => flattenItemResult(
      await buildPlannedItemFromRuntimeStep(ctx, step, input.handlers),
    ),
    createFailureItem: (failure) => supervisorFailureRead(failure),
    toProducedItem: (item) => supervisorProducedItem(item),
    failureCopy: (failureContext) => supervisorFailureCopy(failureContext),
  }

  if (input.emitRunEvents === true) {
    supervisorInput.onToolCallStarted = async ({ call, event }) => {
      await addToolRuntimeEvent(ctx, {
        type: 'tool_call_started',
        title: '工具调用开始',
        message: `开始处理模型选择的工具：${call.toolName}`,
        status: 'running',
        data: {
          runtimeEvent: {
            ...event,
            payload: { argumentsPreview: redactSecretLikeContent(JSON.stringify(call.arguments)).slice(0, 1000) },
          },
          inventorySnapshotId: input.inventorySnapshot?.snapshotId ?? null,
        },
      })
    }

    supervisorInput.onToolCallCompleted = async ({ call, event, observation, failureReason }) => {
      const hostObservation = observation as AgentToolExecutionObservation
      const hasFailure = hostObservation.status !== 'completed'
      const title = failureReason === 'outside_inventory'
        ? '工具调用被阻止'
        : hasFailure ? '工具调用失败' : '工具调用完成'
      const message = hostObservation.resultPreview ?? `工具调用完成：${call.toolName}`
      await addToolRuntimeEvent(ctx, {
        type: hasFailure ? 'tool_call_failed' : 'tool_call_completed',
        title,
        message,
        status: hasFailure ? 'failed' : 'completed',
        data: {
          runtimeEvent: runtimeEventWithSummary(event, message),
        },
      })
    }
  }

  const supervised = await runToolCallSupervisor(supervisorInput)
  return {
    items: supervised.items,
    observations: supervised.observations as AgentToolExecutionObservation[],
  }
}
