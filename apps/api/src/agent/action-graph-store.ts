import type { Kysely } from 'kysely'
import type {
  AgentActionRequest as OsActionRequest,
  AgentActionStatus as OsActionStatus,
  AgentRunRecord as OsRunRecord,
  JsonObject as OsJsonObject,
} from '@agentic-os/contracts'
import { classifyToolObservationOutcome } from '@agentic-os/core'
import {
  materializeAgentServerActionGraph,
  type AgentServerActionGraphEventDraft,
  type AgentServerActionGraphPlanStepItem,
  type AgentServerActionGraphPlannedItem,
  type AgentServerActionGraphReadObservationItem,
  type AgentServerActionGraphStore,
  type AgentServerActionGraphStoreActionRequestResult,
  type AgentServerActionGraphSummary,
  type AgentServerActionPlanStep,
  type AgentServerActionPlanStepDraft,
  type AgentServerActionPlanStepStatus,
} from '@agentic-os/server'
import type { AgentNavigationEvent, AgentPlannerSource, AgentPlanStepStatus } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString } from '../db/database.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { isActionDraft, type PlannedItem, type ReadDraft } from './action-draft-builder.js'
import {
  addAgentActionRequest,
  autoExecuteAgentActionRequest,
  type AgentActionDraft,
} from './agentic-os/xox-action-approval-adapter.js'
import { addRunEvent } from './agentic-os/xox-run-event-store-adapter.js'
import { assertAgentRunLease } from './agentic-os/xox-run-lease-store-adapter.js'
import { agentThreadEvents } from './agentic-os/xox-thread-signal-adapter.js'
import {
  actionFailureObservation,
  actionExecutionObservation,
  actionPreviewObservation,
  type AgentToolObservation,
} from './agentic-os/xox-tool-observation-adapter.js'
import { resolveActionAuthority, type AgentAutomationLevel } from './tool-policy.js'
import {
  createXoxObservationBridge,
  type XoxObservationBridge,
} from './agentic-os/xox-observation-adapter.js'

type ActionGraphContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  automationLevel: AgentAutomationLevel
}

export type StoredActionGraph = {
  assistantText: string | null
  observations: AgentToolObservation[]
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  plannerSource: AgentPlannerSource
}

type StoredActionResult = {
  action: Row<'agent_action_requests'>
  observation: AgentToolObservation
}

type MaterializerMetadata = {
  xoxNavigation?: AgentNavigationEvent | null
  xoxPlanStatus?: AgentPlanStepStatus
}

function osJsonObject(value: unknown): OsJsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as OsJsonObject
}

function optionalOsJsonObject(value: Record<string, unknown> | null | undefined): OsJsonObject | undefined {
  return value && Object.keys(value).length > 0 ? osJsonObject(value) : undefined
}

function metadata(input: MaterializerMetadata): OsJsonObject | undefined {
  const record: Record<string, unknown> = {}
  if (input.xoxNavigation !== undefined) record.xoxNavigation = input.xoxNavigation
  if (input.xoxPlanStatus !== undefined) record.xoxPlanStatus = input.xoxPlanStatus
  return optionalOsJsonObject(record)
}

function metadataRecord(item: AgentServerActionGraphPlannedItem): Record<string, unknown> {
  return item.metadata ? item.metadata as Record<string, unknown> : {}
}

function navigationFromItem(item: AgentServerActionGraphPlannedItem): AgentNavigationEvent | null {
  const value = metadataRecord(item).xoxNavigation
  return value && typeof value === 'object' ? value as AgentNavigationEvent : null
}

function xoxStatusFromMetadata(item: AgentServerActionGraphPlannedItem): AgentPlanStepStatus | null {
  const value = metadataRecord(item).xoxPlanStatus
  return value === 'pending' ||
    value === 'ready' ||
    value === 'executed' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'info'
    ? value
    : null
}

function serverStatusFromXox(status: AgentPlanStepStatus | undefined): AgentServerActionPlanStepStatus | undefined {
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'pending') return 'running'
  if (status === 'ready' || status === 'executed' || status === 'info') return 'completed'
  return undefined
}

function xoxStatusFromServer(status: AgentServerActionPlanStepStatus): AgentPlanStepStatus {
  if (status === 'waiting') return 'ready'
  if (status === 'running') return 'pending'
  if (status === 'completed') return 'info'
  if (status === 'failed') return 'failed'
  return 'cancelled'
}

function xoxActionStepStatus(status: AgentServerActionPlanStepStatus): AgentPlanStepStatus {
  if (status === 'waiting') return 'ready'
  if (status === 'completed') return 'executed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

function xoxPlanStepStatus(
  item: AgentServerActionGraphPlannedItem,
  step: AgentServerActionPlanStepDraft,
): AgentPlanStepStatus {
  const explicit = xoxStatusFromMetadata(item)
  if (explicit) return explicit
  return item.type === 'action_request' ? xoxActionStepStatus(step.status) : xoxStatusFromServer(step.status)
}

function osRunRecord(ctx: ActionGraphContext): OsRunRecord {
  return {
    runId: ctx.runId,
    threadId: ctx.threadId,
    scope: {
      tenantId: ctx.workspace.id,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
    },
    status: 'running',
    createdAt: utcNow(),
  }
}

function osActionStatus(status: string): OsActionStatus {
  if (status === 'executed') return 'executed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'rejected'
  if (status === 'confirmed') return 'executing'
  return 'pending'
}

function osActionRequestFromDraft(
  ctx: ActionGraphContext,
  draft: AgentActionDraft,
  index: number,
): OsActionRequest {
  const provisionalId = `xox_draft_${index + 1}_${draft.kind}`
  return {
    actionRequestId: provisionalId,
    runId: ctx.runId,
    threadId: ctx.threadId,
    toolCallId: provisionalId,
    toolName: draft.kind,
    status: 'pending',
    title: draft.title,
    description: draft.summary,
    preview: osJsonObject({
      targetLabel: draft.targetLabel,
      riskLevel: draft.riskLevel,
      details: draft.details,
      payload: draft.payload,
    }),
  }
}

function osActionRequestFromRow(row: Row<'agent_action_requests'>, base: OsActionRequest): OsActionRequest {
  return {
    ...base,
    actionRequestId: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    status: osActionStatus(row.status),
    title: row.title,
    description: row.summary,
  }
}

function toolNameForRead(item: ReadDraft, sequenceHint: number) {
  if (!('toolName' in item) || !item.toolName) return `read_observation_${sequenceHint}`
  return item.toolName
}

function observationFromRead(item: ReadDraft, sequenceHint: number): AgentToolObservation | null {
  if (!('readKind' in item) || item.readKind !== 'tool_observation') return null
  const toolName = toolNameForRead(item, sequenceHint)
  const displayPreview = item.displayPreview ?? item.message
  const lane = item.observationLane ?? 'provider_tool'
  const status = item.observationStatus ??
    (item.status === 'failed' ? 'failed' : item.status === 'cancelled' ? 'cancelled' : 'completed')
  const observation = {
    title: item.title,
    toolName,
    toolCallId: item.toolCallId ?? `call_observation_${sequenceHint}_${toolName}`,
    toolArguments: item.toolArguments ?? {},
    displayPreview,
    modelContent: item.modelContent ?? displayPreview,
    status,
    lane,
    ...(item.syntheticObservation ? { synthetic: true } : {}),
  }
  return {
    ...observation,
    outcome: item.observationOutcome ?? classifyToolObservationOutcome(observation),
  }
}

function isRunnerOwnedObservationLane(lane: unknown) {
  return lane === 'runner_evidence' || lane === 'runner_obligation'
}

type AddAgentPlanStepInput = {
  sequence: number
  title: string
  description: string
  status: AgentPlanStepStatus
  actionRequestId?: string | null
  navigation?: AgentNavigationEvent | null
  toolName?: string | null
  toolCallId?: string | null
  toolArguments?: Record<string, unknown> | null
}

async function addAgentPlanStep(ctx: ActionGraphContext, input: AddAgentPlanStepInput) {
  const id = newId()
  const now = utcNow()
  await ctx.db
    .insertInto('agent_plan_steps')
    .values({
      id,
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      action_request_id: input.actionRequestId ?? null,
      sequence_no: input.sequence,
      title: input.title,
      description: input.description,
      status: input.status,
      navigation_json: input.navigation ? jsonString(input.navigation) : null,
      tool_name: input.toolName ?? null,
      tool_call_id: input.toolCallId ?? null,
      tool_arguments_json: input.toolArguments ? jsonString(input.toolArguments) : null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function settleStoredAction(
  ctx: ActionGraphContext,
  input: {
    draft: AgentActionDraft
    action: Row<'agent_action_requests'>
  },
): Promise<StoredActionResult> {
  const authority = resolveActionAuthority({
    automationLevel: ctx.automationLevel,
    kind: input.draft.kind,
    riskLevel: input.draft.riskLevel,
  })

  if (authority.mode === 'auto_execute') {
    const executed = await autoExecuteAgentActionRequest(ctx.db, ctx.settings, ctx.user, input.action, authority.reason)
    return {
      action: executed.actionRequest,
      observation: executed.error
        ? actionFailureObservation({ action: executed.actionRequest, reason: authority.reason, error: executed.error })
        : actionExecutionObservation({ action: executed.actionRequest, result: executed.result }),
    }
  }

  if (authority.mode === 'forbidden') {
    await ctx.db.updateTable('agent_action_requests')
      .set({ status: 'failed', error_message: authority.reason })
      .where('id', '=', input.action.id)
      .execute()
    await ctx.db.updateTable('agent_plan_steps')
      .set({ status: 'failed', updated_at: utcNow() })
      .where('action_request_id', '=', input.action.id)
      .execute()
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'action_auto_execution_failed',
      title: '动作被策略阻止',
      message: `${input.draft.title}：${authority.reason}`,
      status: 'failed',
      data: { actionRequestId: input.action.id, actionKind: input.action.kind, reason: authority.reason },
    })
    const action = await ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
    return {
      action,
      observation: actionFailureObservation({ action, reason: authority.reason }),
    }
  }

  return {
    action: input.action,
    observation: actionPreviewObservation({ action: input.action }),
  }
}

function itemInput(toolArguments: Record<string, unknown> | null | undefined): OsJsonObject | undefined {
  return toolArguments ? osJsonObject(toolArguments) : undefined
}

function readPlannedItem(
  item: ReadDraft,
  index: number,
  observationBridge: XoxObservationBridge,
): AgentServerActionGraphPlannedItem {
  if ('readKind' in item && item.readKind === 'assistant_message') {
    return {
      type: 'assistant_message',
      content: item.message,
    }
  }

  const xoxStatus = item.status ?? 'info'
  const baseMetadata = metadata({
    ...(item.navigation !== undefined ? { xoxNavigation: item.navigation } : {}),
    xoxPlanStatus: xoxStatus,
  })
  const input = itemInput('toolArguments' in item ? item.toolArguments : undefined)
  const observation = observationFromRead(item, index + 1)

  if (observation) {
    const osObservation = observationBridge.toCanonical(observation, index)
    if (isRunnerOwnedObservationLane(item.observationLane)) {
      return {
        type: 'observation_only',
        observation: osObservation,
      }
    }
    const planned: AgentServerActionGraphReadObservationItem = {
      type: 'read_observation',
      title: item.title,
      description: item.message,
      observation: osObservation,
    }
    const serverStatus = serverStatusFromXox(xoxStatus)
    if (serverStatus !== undefined) planned.status = serverStatus
    if (input !== undefined) planned.input = input
    if (baseMetadata !== undefined) planned.metadata = baseMetadata
    return planned
  }

  const toolName = 'toolName' in item && item.toolName ? item.toolName : `status_step_${index + 1}`
  const toolCallId = 'toolCallId' in item && item.toolCallId ? item.toolCallId : `status_step_${index + 1}`
  const planned: AgentServerActionGraphPlanStepItem = {
    type: 'plan_step',
    title: item.title,
    description: item.message,
    toolName,
    toolCallId,
  }
  const serverStatus = serverStatusFromXox(xoxStatus)
  if (serverStatus !== undefined) planned.status = serverStatus
  if (input !== undefined) planned.input = input
  if (baseMetadata !== undefined) planned.metadata = baseMetadata
  return planned
}

function materializerItemFromPlannedItem(
  ctx: ActionGraphContext,
  item: PlannedItem,
  index: number,
  actionDrafts: Map<string, AgentActionDraft>,
  observationBridge: XoxObservationBridge,
): AgentServerActionGraphPlannedItem {
  if (!isActionDraft(item)) return readPlannedItem(item, index, observationBridge)

  const actionRequest = osActionRequestFromDraft(ctx, item, index)
  actionDrafts.set(actionRequest.actionRequestId, item)
  const planned: AgentServerActionGraphPlannedItem = {
    type: 'action_request',
    actionRequest,
    title: item.title,
    description: item.summary,
    input: osJsonObject({
      kind: item.kind,
      payload: item.payload,
    }),
  }
  const itemMetadata = metadata({ xoxNavigation: item.navigation })
  if (itemMetadata !== undefined) planned.metadata = itemMetadata
  return planned
}

function toolArgumentsFromStep(step: AgentServerActionPlanStepDraft): Record<string, unknown> | null {
  return step.input ? JSON.parse(JSON.stringify(step.input)) as Record<string, unknown> : null
}

function storedPlanStep(
  row: Row<'agent_plan_steps'>,
  step: AgentServerActionPlanStepDraft,
): AgentServerActionPlanStep {
  const stored: AgentServerActionPlanStep = {
    ...step,
    planStepId: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  return stored
}

async function addLocalizedActionGraphEvent(
  ctx: ActionGraphContext,
  input: {
    plannerSource: AgentPlannerSource
    summary: AgentServerActionGraphSummary
    eventDraft: AgentServerActionGraphEventDraft
  },
): Promise<void> {
  if (input.eventDraft.type === 'action_graph.confirmation_required') {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'confirmation_ready',
      title: '确认卡已生成',
      message: `已生成 ${input.summary.pendingActionCount} 张待确认动作卡，用户可编辑后执行。`,
      status: 'blocked',
      data: { actionCount: input.summary.pendingActionCount, automationLevel: ctx.automationLevel },
    })
    return
  }

  const actionCount = input.summary.actionCount
  const pendingActionCount = input.summary.pendingActionCount
  const executedActionCount = input.summary.executedActionCount
  const failedCount = input.summary.failedStepCount
  const visibleStepCount = input.summary.stepCount + input.summary.assistantMessageCount
  const actionSummary = actionCount > 0
    ? `，其中 ${pendingActionCount} 个写入动作需要确认，${executedActionCount} 个已按自动化策略执行。`
    : '。'
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_plan_ready',
    title: failedCount > 0 ? '模型规划需要处理' : actionCount > 0 ? '模型工具调用已解析' : '模型回复已生成',
    message:
      visibleStepCount > 0
        ? `模型规划生成 ${visibleStepCount} 个步骤${actionSummary}`
        : '模型没有生成可执行步骤。',
    status: failedCount > 0 ? 'failed' : pendingActionCount > 0 ? 'blocked' : executedActionCount > 0 ? 'completed' : 'info',
    data: {
      plannerSource: input.plannerSource,
      stepCount: visibleStepCount,
      actionCount,
      pendingActionCount,
      executedActionCount,
      failedCount,
      automationLevel: ctx.automationLevel,
      actionGraphEvent: input.eventDraft,
    },
  })
}

export async function storePlannedActionGraph(
  ctx: ActionGraphContext,
  input: { items: PlannedItem[]; plannerSource: AgentPlannerSource; emitPlanReady?: boolean },
): Promise<StoredActionGraph> {
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const actionDrafts = new Map<string, AgentActionDraft>()
  const observationBridge = createXoxObservationBridge()

  const store: AgentServerActionGraphStore = {
    loadMaxPlanSequence: async () => {
      await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
      const existing = await ctx.db
        .selectFrom('agent_plan_steps')
        .select(({ fn }) => fn.max<number>('sequence_no').as('maxSequence'))
        .where('run_id', '=', ctx.runId)
        .executeTakeFirst()
      return Number(existing?.maxSequence ?? 0)
    },
    storeActionRequest: async (actionInput): Promise<AgentServerActionGraphStoreActionRequestResult> => {
      await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
      const draft = actionDrafts.get(actionInput.actionRequest.actionRequestId)
      if (!draft) throw new Error(`Missing xox action draft for ${actionInput.actionRequest.actionRequestId}`)
      const createdAction = await addAgentActionRequest(ctx, draft)
      const settled = await settleStoredAction(ctx, { draft, action: createdAction })
      actionRows.push(settled.action)
      navigationEvents.push(draft.navigation)
      const osObservation = observationBridge.toCanonical(settled.observation, actionRows.length - 1)
      return {
        actionRequest: osActionRequestFromRow(settled.action, actionInput.actionRequest),
        observation: osObservation,
      }
    },
    storePlanStep: async (stepInput) => {
      await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
      const navigation = navigationFromItem(stepInput.item)
      if (navigation && stepInput.item.type !== 'action_request') navigationEvents.push(navigation)
      const row = await addAgentPlanStep(ctx, {
        sequence: stepInput.step.sequence,
        title: stepInput.step.title,
        description: stepInput.step.description,
        status: xoxPlanStepStatus(stepInput.item, stepInput.step),
        actionRequestId: stepInput.step.actionRequestId ?? null,
        navigation,
        toolName: stepInput.item.type === 'action_request' ? null : stepInput.step.toolName,
        toolCallId: stepInput.item.type === 'action_request' ? null : stepInput.step.toolCallId,
        toolArguments: stepInput.item.type === 'action_request' ? null : toolArgumentsFromStep(stepInput.step),
      })
      planRows.push(row)
      return storedPlanStep(row, stepInput.step)
    },
  }

  const items = input.items.map((item, index) =>
    materializerItemFromPlannedItem(ctx, item, index, actionDrafts, observationBridge)
  )
  const materialized = await materializeAgentServerActionGraph({
    store,
    run: osRunRecord(ctx),
    items,
  })

  if (input.emitPlanReady !== false) {
    for (const eventDraft of materialized.eventDrafts) {
      await addLocalizedActionGraphEvent(ctx, {
        plannerSource: input.plannerSource,
        summary: materialized.summary,
        eventDraft,
      })
    }
  }
  agentThreadEvents.publish(ctx.threadId, 'plan_ready')
  return {
    assistantText: materialized.assistantText,
    observations: materialized.observations.map((observation) =>
      observationBridge.fromCanonical(observation)
    ),
    navigationEvents,
    actionRows,
    planRows,
    plannerSource: input.plannerSource,
  }
}
