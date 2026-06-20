import type { AgentPlannerSource, AgentToolInventorySnapshot } from '@xox/contracts'
import {
  runToolCallSupervisor,
  type ToolRuntimeEvent,
  type ToolSupervisorFailureContext,
  type ToolSupervisorFailureCopy,
  type ToolSupervisorFailureObservation,
  type ToolSupervisorProducedItem,
  type ToolSupervisorRunInput,
} from '@agentic-os/core'
import type { PlannerContext } from './planning-context.js'
import {
  buildPlannedItemFromRuntimeStep,
  isActionDraft,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
  type ReadDraft,
  type RuntimePlannerStep,
} from './action-draft-builder.js'
import type { RuntimePlanResult } from './runtime/runtime-adapter.js'
import { configuredRuntimePlannerSource, readDraftsFromRuntimeResult } from './runtime-plan-reader.js'
import { extractWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'

type RuntimePlanner = (ctx: PlannerContext) => Promise<RuntimePlanResult | null>

function isStepDelimiter(char: string) {
  return char === '；' || char === ';' || char === '\n'
}

function shouldPreserveDelimitersAsStructuredBrief(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (message.length >= 1200 || lines.length >= 8) return true
  const startsWithNumberedMarker = (line: string) => {
    let index = 0
    while (index < line.length) {
      const code = line.charCodeAt(index)
      if (code < 48 || code > 57) break
      index += 1
    }
    if (index === 0) return false
    const marker = line[index]
    return marker === '.' || marker === ')' || marker === '、'
  }
  const listLikeLines = lines.filter((line) =>
    line.startsWith('-') ||
    line.startsWith('*') ||
    line.startsWith('•') ||
    startsWithNumberedMarker(line),
  )
  return listLikeLines.length >= 4
}

export function splitRequestedSteps(message: string) {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let escaped = false
  const preserveStructuredDelimiters = shouldPreserveDelimitersAsStructuredBrief(message)

  for (let index = 0; index < message.length; index += 1) {
    const char = message[index] ?? ''
    if (inString) {
      current += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      current += char
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      current += char
      continue
    }
    if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1
      current += char
      continue
    }
    if (depth === 0 && isStepDelimiter(char) && !preserveStructuredDelimiters) {
      const part = current.trim()
      if (part) parts.push(part)
      current = ''
      continue
    }
    current += char
  }

  const finalPart = current.trim()
  if (finalPart) parts.push(finalPart)
  return parts.length > 0 ? parts : [message]
}

function actionPayload(item: PlannedItem) {
  return isActionDraft(item) && item.payload && typeof item.payload === 'object'
    ? item.payload as Record<string, unknown>
    : null
}

function configureOperatingModelWorkspaceNames(items: PlannedItem[]) {
  return new Set(items.flatMap((item) => {
    const payload = actionPayload(item)
    return isActionDraft(item) &&
      item.kind === 'workspace.update_draft' &&
      payload?.source === 'workspace_configure_operating_model' &&
      typeof payload.workspaceName === 'string' &&
      payload.workspaceName.trim()
      ? [payload.workspaceName.trim()]
      : []
  }))
}

function removeRedundantWorkspaceRename(items: PlannedItem[]) {
  const configuredWorkspaceNames = configureOperatingModelWorkspaceNames(items)
  if (configuredWorkspaceNames.size === 0) return items
  return items.filter((item) => {
    if (!isActionDraft(item) || item.kind !== 'workspace.rename') return true
    const payload = actionPayload(item)
    const workspaceName = typeof payload?.workspaceName === 'string' ? payload.workspaceName.trim() : ''
    return !configuredWorkspaceNames.has(workspaceName)
  })
}

type ToolInventoryItem = AgentToolInventorySnapshot['tools'][number]

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

async function superviseRuntimePlannerSteps(
  ctx: PlannerContext,
  input: {
    steps: RuntimePlannerStep[]
    handlers: ActionDraftBuilderHandlers<PlannerContext>
    inventorySnapshot?: AgentToolInventorySnapshot | null
    emitRunEvents?: boolean
  },
): Promise<{ items: PlannedItem[] }> {
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
    executeToolCall: ({ step }) => buildPlannedItemFromRuntimeStep(ctx, step, input.handlers),
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
      const hasFailure = observation.status !== 'completed'
      const title = failureReason === 'outside_inventory'
        ? '工具调用被阻止'
        : hasFailure ? '工具调用失败' : '工具调用完成'
      const message = observation.resultPreview ?? `工具调用完成：${call.toolName}`
      const runtimeEvent: ToolRuntimeEvent = { ...event, summary: message }
      await addToolRuntimeEvent(ctx, {
        type: hasFailure ? 'tool_call_failed' : 'tool_call_completed',
        title,
        message,
        status: hasFailure ? 'failed' : 'completed',
        data: { runtimeEvent },
      })
    }
  }

  const supervised = await runToolCallSupervisor(supervisorInput)
  return {
    items: supervised.items,
  }
}

export async function runPlanningSession(
  ctx: PlannerContext,
  input: { handlers: ActionDraftBuilderHandlers<PlannerContext>; callRuntimePlanner: RuntimePlanner },
): Promise<{ source: AgentPlannerSource; items: PlannedItem[] } | null> {
  const requiredSource = configuredRuntimePlannerSource(ctx.settings)
  const items: PlannedItem[] = []
  let source: AgentPlannerSource | null = null

  const requestedParts = ctx.planningTurn === 'evaluator_repair' ? [ctx.message] : splitRequestedSteps(ctx.message)
  for (const part of requestedParts) {
    const artifact = extractWorkspaceBundleArtifact(part)
    const baseCtx: PlannerContext = { ...ctx, message: part }
    const planningCtx: PlannerContext = artifact ? { ...baseCtx, providedWorkspaceBundle: artifact } : baseCtx
    const runtimeCtx: PlannerContext = artifact ? { ...planningCtx, message: artifact.messageForModel } : planningCtx
    const result = await input.callRuntimePlanner(runtimeCtx)

    if (!result || result.steps.length === 0) {
      if (!requiredSource) return null
      source = source ?? result?.source ?? requiredSource
      items.push(...readDraftsFromRuntimeResult(result))
      continue
    }

    source =
      result.source === 'openai_agents' || source === 'openai_agents'
        ? 'openai_agents'
        : 'openai_compatible_tool_calls'

    const supervisorInput: Parameters<typeof superviseRuntimePlannerSteps>[1] = {
      steps: result.steps,
      handlers: input.handlers,
      emitRunEvents: true,
      ...(result.toolInventorySnapshot ? { inventorySnapshot: result.toolInventorySnapshot } : {}),
    }
    const supervised = await superviseRuntimePlannerSteps(planningCtx, supervisorInput)
    const partItems = supervised.items
    if (partItems.length > 0) {
      items.push(...partItems)
    } else if (requiredSource) {
      items.push(...readDraftsFromRuntimeResult(result))
    }
  }

  const normalizedItems = removeRedundantWorkspaceRename(items)
  return normalizedItems.length > 0
    ? { source: source ?? requiredSource ?? 'openai_compatible_tool_calls', items: normalizedItems }
    : null
}
