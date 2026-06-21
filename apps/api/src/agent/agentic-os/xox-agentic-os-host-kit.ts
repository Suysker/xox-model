import type {
  AgentActionAuditRecord as OsActionAuditRecord,
  AgentActionEditInput as OsActionEditInput,
  AgentActionEditResult as OsActionEditResult,
  AgentActionExecutionInput as OsActionExecutionInput,
  AgentActionExecutionResult as OsActionExecutionResult,
  AgentActionRejectionInput as OsActionRejectionInput,
  AgentActionRejectionResult as OsActionRejectionResult,
  AgentActionRequest as OsActionRequest,
  AgentContext as OsAgentContext,
  AgentEvidence as OsAgentEvidence,
  AgentFinalAnswerClaim as OsFinalAnswerClaim,
  AgentLoopObligationMaterializationRequest,
  AgentFinalReview as OsFinalReview,
  AgentObservation as OsObservation,
  AgentRunEvent as OsRunEvent,
  AgentRunInput as OsRunInput,
  AgentRunLease as OsRunLease,
  AgentRunLeaseCheck as OsRunLeaseCheck,
  AgentRunRecord as OsRunRecord,
  AgentRunResult as OsRunResult,
  AgentScope as OsScope,
  AgentSandboxExecutionResult as OsSandboxExecutionResult,
  AgentToolDefinition as OsToolDefinition,
  AgentToolHandlerResult as OsToolHandlerResult,
  AgentToolRiskLevel as OsToolRiskLevel,
  AgentToolConfirmationMode as OsToolConfirmationMode,
  AgentToolAuthorityClass as OsToolAuthorityClass,
  AgentToolSelectionHint as OsToolSelectionHint,
  JsonObject as OsJsonObject,
  JsonValue as OsJsonValue,
  RuntimeAdapter as OsRuntimeAdapter,
  RuntimeTurnInput as OsRuntimeTurnInput,
} from '@agentic-os/contracts'
import {
  createAgentHostLoopCoordinator,
  createAgentHostKit,
  hasNonActionHostObservation,
  inferToolAuthorityClass,
  isActionResultToolObservation,
  isActionToolObservation,
  isCompletedValidToolObservation,
  isFinalizableHostBusinessObservation,
  isRepairableToolObservation,
  isSandboxToolObservation,
  ledgerToReviewObligations,
  obligationMaterializationCompletedEventPayload,
  parseToolObservationModelFacts,
  planObligationMaterialization,
  runtimePlannerResultToTurnOutput,
  sandboxExecutionModeFromFacts,
  sandboxExecutionStatusFromFacts,
  selectCompletedReadObservation,
  selectAgentPrerequisiteObservations,
  selectReadinessObservation,
  selectSandboxFinalizerObservation,
  type AgentHostLoopCoordinator,
  type AgentActionPort,
  type AgentCompletionPort,
  type AgentContextPort,
  type AgentHostAdapter,
  type AgentLoopObligationMaterializationCache,
  type AgentPrerequisiteObservationSpec,
  type AgentSandboxPort,
  type AgentStorePort,
  type AgentToolRegistryPort,
} from '@agentic-os/core'
import {
  AGENT_SERVER_FINAL_ANSWER_CLAIM_EXTRACTION_TOOL_NAME,
  runAgentServerFinalAnswerClaimExtraction,
  type AgentServerFinalAnswerClaimExtractionCopyInput,
  type AgentServerFinalAnswerClaimExtractionOptions,
  type AgentServerFinalAnswerClaimExtractionResult,
} from '@agentic-os/server'
import type { AgentGoalFacts, AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import { parseJson } from '../../db/database.js'
import type { Row } from '../../db/schema.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { PlannerContext } from '../planning-context.js'
import {
  createXoxObservationBridge,
  type XoxObservationBridge,
} from './xox-observation-adapter.js'
import { executeAgentActionRequest } from '../approval-executor.js'
import {
  buildPlannedItemFromRuntimeStep,
  isActionDraft,
  readDraftsFromRuntimeResult,
  toolSupervisorFailureReadDraft,
  type PlannedItem,
  type PlannedItemResult,
} from '../action-draft-builder.js'
import {
  storePlannedActionGraph,
  type StoredActionGraph,
} from '../action-graph-store.js'
import { answerWorkspaceDataQuestion, type DataAgentQueryStep } from '../data-agent.js'
import { buildXoxClarificationResumeContext } from './xox-clarification-resume-adapter.js'
import {
  buildEvidenceLedger,
  evidenceForModel,
  isExecutedSandboxEvidenceFacts,
  type AgentEvidenceItem,
  type AgentFinalAnswerClaim,
} from '../evidence-ledger.js'
import {
  addEvaluationResult,
  createGoalContract,
  serializeEvaluation,
  updateGoalStatus,
} from '../goal-contract.js'
import {
  consolidateExecutedActionMemory,
  flushThreadContextToMemoryIfNeeded,
} from '../memory-kernel.js'
import { runMemoryDreamingSweep } from '../memory/dreaming-worker.js'
import {
  evaluateAssistantResponse,
  responseEvaluationSummary,
} from '../response-evaluator.js'
import { callRuntimePlanner } from '../runtime-planning-call.js'
import {
  configuredRuntimePlannerSource,
  planWithRuntimeAdapter,
  type RuntimeChatMessage,
  type RuntimePlanningInput,
  type RuntimePlanResult,
} from '../runtime/runtime-adapter.js'
import {
  mergeAgentGoalFacts,
  readRuntimeGoalFacts,
} from '../runtime-goal-facts.js'
import { addRunEvent } from '../run-events.js'
import { addMessage } from '../thread-store.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCapability,
  type AgentToolCallStep,
  type AgentToolRiskLevel,
  type AgentToolConfirmationMode,
  type ChatTool,
} from '../tool-catalog.js'
import {
  actionExecutionObservation,
  continueModelAfterToolObservations,
  toolSupervisorFailureObservation,
  type AgentToolObservation,
} from '../tool-observation-continuation.js'
import { redactSecretLikeContent } from '../memory.js'
import { runtimeIntentHandlers } from '../runtime-intent-handlers.js'
import { evaluateAgentGoal } from './xox-loop-readiness-adapter.js'
import {
  applyObservationToLedger,
  applyResponseEvaluationToLedger,
  initializeObligationLedger,
  ledgerToObligationPlan,
  osLedgerFromXoxLedger,
  runtimeBoundaryMissingObservationRepair,
  serializeObligationLedgerForResponseEvent,
  type AgentLoopLedgerObligation,
  type AgentLoopObligationLedger,
} from '../loop-obligation-ledger.js'
import { extractWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'

export type AgenticOsKernelRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus | null
}

type XoxAgenticOsPlannerContext = PlannerContext & {
  thread: Row<'agent_threads'>
  initialGoalFacts?: AgentGoalFacts | null
}

type XoxAgenticOsRunState = {
  plannerSource: AgentPlannerSource
  goal: Row<'agent_goals'> | null
  objective: string
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  xoxObservations: AgentToolObservation[]
  observationBridge: XoxObservationBridge
  loopCoordinator: AgentHostLoopCoordinator<AgentToolObservation>
  obligationLedger: AgentLoopObligationLedger
  lastToolSelection: OsToolSelectionHint | null
  finishedResult: OsRunResult | null
}

type XoxPrerequisiteObligation = {
  requiredDataScopes?: string[]
}

const ENTITY_SUMMARY_TOOL_ARGUMENTS = {
  question: '当前工作区有序成员、股东、员工和成本对象列表',
  scope: 'entity_summary',
  metrics: ['shareholderNames', 'shareholderInvestments'],
} satisfies DataAgentQueryStep

const ENTITY_SUMMARY_PREREQUISITE: AgentPrerequisiteObservationSpec<
  AgentGoalFacts,
  AgentToolObservation,
  XoxPrerequisiteObligation
> = {
  id: 'entity_summary',
  requiredDataScopes: ['entity_summary'],
  isRequiredByGoal: (goalFacts) => goalFacts?.requiresOrderedEntityFacts === true,
  isSatisfiedByObservation: (observation) => {
    if (observation.toolName !== 'data_query_workspace' || observation.status !== 'completed') return false
    const facts = parseXoxObservationContent(observation)
    return facts?.scope === 'entity_summary' && Array.isArray(facts.shareholders)
  },
}

function compactJsonObject(value: unknown): OsJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
}

function compactJsonValue(value: unknown): OsJsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as OsJsonValue
}

function osScope(ctx: PlannerContext): OsScope {
  return {
    tenantId: ctx.user.id,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
  }
}

function osRunRecord(ctx: PlannerContext, run: Row<'agent_runs'> | null): OsRunRecord {
  return {
    runId: ctx.runId,
    threadId: ctx.threadId,
    scope: osScope(ctx),
    status: 'running',
    createdAt: run?.created_at ?? utcNow(),
  }
}

function shouldCollectPendingActionsBeforePause(
  objective: string,
  _goalFacts: AgentGoalFacts,
): boolean {
  const normalized = objective.toLowerCase()
  return /[；;]\s*(把|帮|再|并|然后)/.test(objective) ||
    objective.includes('预测结果为空') ||
    objective.includes('继续修复') ||
    normalized.includes('operating model')
}

function maxPendingActionsForObjective(objective: string, collectPendingActionsBeforePause: boolean): number {
  const explicitParts = /[；;]\s*(把|帮|再|并|然后)/.test(objective)
    ? objective.split(/[；;]/).map((part) => part.trim()).filter(Boolean).length
    : 0
  if (explicitParts > 1) return explicitParts
  return collectPendingActionsBeforePause ? 2 : 1
}

function dataQueryArgumentsForObligation(obligation: AgentLoopLedgerObligation): DataAgentQueryStep | null {
  if (obligation.kind !== 'domain_fact') return null
  if (!obligation.toolNames.includes('data_query_workspace')) return null
  const scope = obligation.requiredDataScopes?.[0] ?? 'workspace_summary'
  const metrics = obligation.requiredMetrics ?? []
  return {
    question: obligation.reason,
    scope,
    ...(metrics.length > 0 ? { metrics } : {}),
  }
}

function obligationMaterializationRequests(
  ledger: AgentLoopObligationLedger,
): AgentLoopObligationMaterializationRequest[] {
  return ledger.obligations.flatMap((obligation) => {
    const toolArguments = dataQueryArgumentsForObligation(obligation)
    if (!toolArguments) return []
    return [{
      obligationId: obligation.id,
      toolName: 'data_query_workspace',
      toolArguments: toolArguments as unknown as OsJsonObject,
    }]
  })
}

async function materializeDataObservation(input: {
  ctx: PlannerContext
  obligation: AgentLoopLedgerObligation
  toolArguments: DataAgentQueryStep
  plannerSource: AgentPlannerSource
}) {
  const read = await answerWorkspaceDataQuestion(input.ctx, input.toolArguments)
  const toolCallId = `runner_obligation_${input.ctx.runId}_${input.obligation.id}`
  if (!read) {
    return storePlannedActionGraph(input.ctx, {
      plannerSource: input.plannerSource,
      emitPlanReady: false,
      items: [{
        title: 'Runner observation failed',
        message: 'The required data observation could not be produced.',
        readKind: 'tool_observation',
        toolName: 'data_query_workspace',
        toolCallId,
        toolArguments: input.toolArguments as Record<string, unknown>,
        modelContent: JSON.stringify({
          observationType: 'runner_obligation_failure',
          status: 'failed',
          obligationId: input.obligation.id,
          reason: 'data_observation_unavailable',
          toolName: 'data_query_workspace',
          toolArguments: input.toolArguments,
        }),
        displayPreview: 'The required data observation could not be produced.',
        observationLane: 'runner_obligation',
        observationStatus: 'failed',
        observationOutcome: 'failed_repairable',
        status: 'failed',
      }],
    })
  }

  return storePlannedActionGraph(input.ctx, {
    plannerSource: input.plannerSource,
    emitPlanReady: false,
    items: [{
      ...read,
      toolName: 'data_query_workspace',
      toolCallId,
      toolArguments: input.toolArguments as Record<string, unknown>,
      observationLane: 'runner_obligation',
    }],
  })
}

async function materializeLoopObligations(input: {
  ctx: PlannerContext
  ledger: AgentLoopObligationLedger
  plannerSource: AgentPlannerSource
  taskCache: AgentLoopObligationMaterializationCache
}): Promise<StoredActionGraph | null> {
  const graphs: StoredActionGraph[] = []
  const obligationsById = new Map(input.ledger.obligations.map((obligation) => [obligation.id, obligation]))
  const plan = planObligationMaterialization({
    ledger: osLedgerFromXoxLedger(input.ledger),
    taskCache: input.taskCache,
    tasks: obligationMaterializationRequests(input.ledger),
  })

  for (const task of plan.tasks) {
    const obligation = obligationsById.get(task.obligationId)
    if (obligation === undefined) continue

    await addRunEvent(input.ctx.db, {
      threadId: input.ctx.threadId,
      runId: input.ctx.runId,
      type: 'runner_obligation_materializing',
      title: 'Runner observation task',
      message: 'A required evidence obligation is being materialized as a model-visible observation.',
      status: 'running',
      data: task.startedEventPayload as Record<string, unknown>,
    })

    const graph = await materializeDataObservation({
      ctx: input.ctx,
      obligation,
      toolArguments: task.toolArguments as unknown as DataAgentQueryStep,
      plannerSource: input.plannerSource,
    })
    if (graph) graphs.push(graph)
  }

  if (graphs.length === 0) return null

  await addRunEvent(input.ctx.db, {
    threadId: input.ctx.threadId,
    runId: input.ctx.runId,
    type: 'runner_obligation_materialized',
    title: 'Runner observation materialized',
    message: `${graphs.reduce((sum, graph) => sum + graph.observations.length, 0)} required observation(s) were materialized for model replay.`,
    status: graphs.some((graph) => graph.observations.some((observation) => observation.status === 'failed')) ? 'failed' : 'completed',
    data: obligationMaterializationCompletedEventPayload({
      observationCount: graphs.reduce((sum, graph) => sum + graph.observations.length, 0),
      toolNames: graphs.flatMap((graph) => graph.observations.map((observation) => observation.toolName)),
    }) as Record<string, unknown>,
  })

  return {
    assistantText: null,
    observations: graphs.flatMap((graph) => graph.observations),
    navigationEvents: graphs.flatMap((graph) => graph.navigationEvents),
    actionRows: graphs.flatMap((graph) => graph.actionRows),
    planRows: graphs.flatMap((graph) => graph.planRows),
    plannerSource: graphs.at(-1)?.plannerSource ?? input.plannerSource,
  }
}

function osRunInput(ctx: PlannerContext, objective: string, goalFacts: AgentGoalFacts): OsRunInput {
  const collectPendingActionsBeforePause = shouldCollectPendingActionsBeforePause(objective, goalFacts)
  const maxPendingActionsToCollect = maxPendingActionsForObjective(objective, collectPendingActionsBeforePause)
  return {
    threadId: ctx.threadId,
    scope: osScope(ctx),
    userMessage: objective,
    automationLevel: ctx.automationLevel,
    maxIterations: 5,
    metadata: {
      host: 'xox-model',
      harness: 'agentic-os',
      xoxRunId: ctx.runId,
      collectPendingActionsBeforePause,
      maxPendingActionsToCollect,
    },
  }
}

function graphPlannerSource(graph: StoredActionGraph, fallback: AgentPlannerSource): AgentPlannerSource {
  return graph.plannerSource ?? fallback
}

function applyStoredGraph(state: XoxAgenticOsRunState, graph: StoredActionGraph): void {
  state.plannerSource = graphPlannerSource(graph, state.plannerSource)
  state.navigationEvents.push(...graph.navigationEvents)
  state.actionRows.push(...graph.actionRows)
  state.planRows.push(...graph.planRows)
  for (const observation of graph.observations) {
    state.xoxObservations.push(observation)
  }
}

async function runInitialPrerequisiteObservations(
  ctx: XoxAgenticOsPlannerContext,
  input: {
    goalFacts: AgentGoalFacts
    observations: AgentToolObservation[]
    plannerSource: AgentPlannerSource
  },
): Promise<StoredActionGraph | null> {
  const prerequisites = selectAgentPrerequisiteObservations({
    specs: [ENTITY_SUMMARY_PREREQUISITE],
    goalFacts: input.goalFacts,
    observations: input.observations,
  })
  if (!prerequisites.some((prerequisite) => prerequisite.id === ENTITY_SUMMARY_PREREQUISITE.id)) {
    return null
  }

  const read = await answerWorkspaceDataQuestion(ctx, ENTITY_SUMMARY_TOOL_ARGUMENTS)
  if (!read) return null

  return storePlannedActionGraph(ctx, {
    plannerSource: input.plannerSource,
    items: [{
      ...read,
      toolName: 'data_query_workspace',
      toolCallId: `runner_evidence_${ctx.runId}_entity_summary`,
      toolArguments: ENTITY_SUMMARY_TOOL_ARGUMENTS,
      observationLane: 'runner_evidence',
      syntheticObservation: true,
    }],
    emitPlanReady: false,
  })
}

function applyNewObservationsToLedger(
  state: XoxAgenticOsRunState,
  observations: AgentToolObservation[],
  iteration: number,
): void {
  state.loopCoordinator.applyNewObservations({
    observations,
    iteration,
    apply: ({ observation, iteration: appliedIteration }) => {
      applyObservationToLedger({
        ledger: state.obligationLedger,
        observation,
        iteration: appliedIteration,
      })
    },
  })
}

function agenticOsRiskLevel(riskLevel: AgentToolRiskLevel): OsToolRiskLevel {
  return riskLevel
}

function agenticOsConfirmationMode(mode: AgentToolConfirmationMode): OsToolConfirmationMode {
  return mode
}

function agenticOsCapability(capability: AgentToolCapability): string {
  return capability
}

function agenticOsAuthorityClass(input: {
  toolName: string
  capability: AgentToolCapability
  riskLevel: AgentToolRiskLevel
  confirmationMode: AgentToolConfirmationMode
}): OsToolAuthorityClass {
  return inferToolAuthorityClass({
    capability: input.capability,
    riskLevel: input.riskLevel,
    confirmationMode: input.confirmationMode,
    manualBoundaryNotice: isManualBoundaryNoticeToolName(input.toolName),
    harnessManagedObservation: isHarnessManagedObservationToolName(input.toolName),
  })
}

function toolSchema(tool: ChatTool): OsJsonObject {
  return compactJsonObject(tool.function.parameters)
}

function agenticOsToolDefinition(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  state: XoxAgenticOsRunState,
  entry: (typeof AGENT_TOOL_REGISTRY)[number],
): OsToolDefinition {
  const authorityClass = agenticOsAuthorityClass({
    toolName: entry.name,
    capability: entry.capability,
    riskLevel: entry.riskLevel,
    confirmationMode: entry.confirmationMode,
  })
  const definition: OsToolDefinition = {
    name: entry.name,
    title: entry.name,
    description: entry.tool.function.description,
    inputJsonSchema: toolSchema(entry.tool),
    capability: agenticOsCapability(entry.capability),
    riskLevel: agenticOsRiskLevel(entry.riskLevel),
    confirmationMode: agenticOsConfirmationMode(entry.confirmationMode),
    authorityClass,
    navigationTarget: entry.navigationTarget,
    validate: (input) => ({
      value: compactJsonObject(input),
    }),
  }

  if (authorityClass === 'read') {
    definition.executeRead = async (input): Promise<OsToolHandlerResult> => {
      const rawStep = plannerStepFromToolCall(entry.name, input.toolCall.toolCallId, input.input)
      const step = rawStep ? normalizeToolStepForObjective(state, rawStep) : null
      if (!step) {
        return {
          content: {
            error: `No xox planner step mapping exists for tool ${entry.name}.`,
          },
          outcome: 'failed_terminal',
        }
      }
      const graph = await storeSingleToolStep(ctx, state, step)
      const observation = graph.observations.at(-1) ?? toolSupervisorFailureObservation(step)
      const osObservation = state.observationBridge.toCanonical(observation, state.xoxObservations.length)
      const handlerResult: OsToolHandlerResult = {
        content: osObservation.content,
      }
      if (osObservation.outcome !== undefined) handlerResult.outcome = osObservation.outcome
      return handlerResult
    }
  }

  return definition
}

function plannerStepFromToolCall(
  toolName: string,
  toolCallId: string,
  input: OsJsonObject,
): AgentToolCallStep | null {
  const args = compactJsonObject(input)
  const step = toolCallToPlannerStep(toolName, args as Record<string, unknown>)
  if (!step) return null
  step.providerToolName = toolName
  step.providerToolCallId = toolCallId
  step.providerToolArguments = args as Record<string, unknown>
  return step
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstStringFromRecord(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function toolStepName(step: AgentToolCallStep): string {
  return step.providerToolName ?? step.intent ?? ''
}

function objectiveImpliesForecastOnly(objective: string): boolean {
  return objective.includes('如果') ||
    objective.includes('试算') ||
    objective.includes('会怎样') ||
    objective.includes('会怎么样') ||
    objective.toLowerCase().includes('what if')
}

function normalizeToolStepForObjective(
  state: XoxAgenticOsRunState,
  step: AgentToolCallStep,
): AgentToolCallStep {
  if (toolStepName(step) !== 'workspace_update_online_factor') return step
  if (step.mode === 'write') return step
  if (step.mode === 'forecast' || objectiveImpliesForecastOnly(state.objective)) {
    return {
      ...step,
      mode: 'forecast',
      providerToolArguments: {
        ...(step.providerToolArguments ?? {}),
        mode: 'forecast',
      },
    }
  }
  return step
}

function operatingModelWorkspaceName(
  state: XoxAgenticOsRunState,
  step: AgentToolCallStep,
): string | null {
  if (toolStepName(step) !== 'workspace_configure_operating_model') return null
  const plan =
    recordValue(step.plan) ??
    recordValue(step.modelPlan) ??
    recordValue(step.scenario)
  const goalFacts = state.goal ? goalContractFacts(state.goal) : {}
  return firstStringFromRecord(plan, 'workspaceName', 'projectName') ??
    (typeof goalFacts.workspaceName === 'string' ? goalFacts.workspaceName.trim() : null)
}

function renameWorkspaceName(step: AgentToolCallStep): string | null {
  if (toolStepName(step) !== 'workspace_rename') return null
  return typeof step.workspaceName === 'string' && step.workspaceName.trim().length > 0
    ? step.workspaceName.trim()
    : null
}

function normalizeRuntimePlanResultForAgenticOs(
  state: XoxAgenticOsRunState,
  result: RuntimePlanResult | null,
): RuntimePlanResult | null {
  if (!result || result.steps.length < 2) return result
  const operatingWorkspaceNames = new Set(result.steps
    .map((step) => operatingModelWorkspaceName(state, step))
    .filter((value): value is string => Boolean(value)))
  if (operatingWorkspaceNames.size === 0) return result

  const steps = result.steps.filter((step) => {
    const rename = renameWorkspaceName(step)
    return !rename || !operatingWorkspaceNames.has(rename)
  })
  return steps.length === result.steps.length ? result : { ...result, steps }
}

function flattenPlannedItems(result: PlannedItemResult): PlannedItem[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

async function storeSingleToolStep(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  state: XoxAgenticOsRunState,
  step: AgentToolCallStep,
  options: { forceManualApproval?: boolean; emitPlanReady?: boolean } = {},
): Promise<StoredActionGraph> {
  const result = await buildPlannedItemFromRuntimeStep(ctx, step, runtimeIntentHandlers)
  const items = flattenPlannedItems(result)
  const fallbackItem = toolSupervisorFailureReadDraft(step)
  const graph = await storePlannedActionGraph(
    options.forceManualApproval ? { ...ctx, automationLevel: 'manual' } : ctx,
    {
      items: items.length > 0 ? items : [fallbackItem],
      plannerSource: state.plannerSource,
      ...(options.emitPlanReady !== undefined ? { emitPlanReady: options.emitPlanReady } : {}),
    },
  )
  applyStoredGraph(state, graph)
  return graph
}

function osActionStatus(row: Row<'agent_action_requests'>): OsActionRequest['status'] {
  if (row.status === 'pending') return 'pending'
  if (row.status === 'executed') return 'executed'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'cancelled') return 'rejected'
  return 'pending'
}

function actionPreview(row: Row<'agent_action_requests'>): OsJsonObject {
  return {
    payload: compactJsonValue(parseJson(row.payload_json, {})),
    navigation: compactJsonValue(parseJson(row.navigation_json, {})),
    details: compactJsonValue(parseJson(row.details_json, [])),
    targetLabel: row.target_label,
    riskLevel: row.risk_level,
  }
}

function osActionRequest(row: Row<'agent_action_requests'>, toolCallId: string): OsActionRequest {
  return {
    actionRequestId: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    toolCallId,
    toolName: row.kind,
    status: osActionStatus(row),
    title: row.title,
    description: row.summary,
    preview: actionPreview(row),
  }
}

function replaceActionRow(
  state: XoxAgenticOsRunState,
  action: Row<'agent_action_requests'>,
): void {
  const index = state.actionRows.findIndex((row) => row.id === action.id)
  if (index >= 0) {
    state.actionRows[index] = action
  } else {
    state.actionRows.push(action)
  }
}

function osAudit(input: {
  runId: string
  threadId: string
  actionRequestId: string
  toolCallId: string
  toolName: string
  actorId: string
  outcome: OsActionAuditRecord['outcome']
  reason?: string
}): OsActionAuditRecord {
  const audit: OsActionAuditRecord = {
    auditId: newId(),
    runId: input.runId,
    threadId: input.threadId,
    actionRequestId: input.actionRequestId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    actorId: input.actorId,
    outcome: input.outcome,
    createdAt: utcNow(),
  }
  if (input.reason !== undefined) audit.reason = input.reason
  return audit
}

function agenticSelectionToXoxLoopPlan(
  state: XoxAgenticOsRunState,
): PlannerContext['loopObligationPlan'] | undefined {
  const selection = state.lastToolSelection
  if (!selection) return undefined
  const requiredToolNames = [...new Set(selection.requiredToolNames ?? [])]
  const selectedCapabilities = (selection.selectedCapabilities ?? [])
    .filter((value): value is AgentToolCapability =>
      AGENT_TOOL_REGISTRY.some((entry) => entry.capability === value))
  const facts = state.goal ? goalContractFacts(state.goal) : {}
  if (
    facts.requiresOrderedEntityFacts === true &&
    (requiredToolNames.includes('sandbox_run_code') || selectedCapabilities.includes('sandbox'))
  ) {
    if (!requiredToolNames.includes('data_query_workspace')) requiredToolNames.push('data_query_workspace')
    if (!selectedCapabilities.includes('data')) selectedCapabilities.push('data')
  }
  if (requiredToolNames.length === 0 && selectedCapabilities.length === 0) return undefined
  return {
    schemaVersion: 'xox.loop_obligation_plan.v1',
    objective: state.objective,
    obligations: [],
    requiredToolNames,
    selectedCapabilities,
    requiredActionCapabilities: [],
    goalFacts: {},
    modelContext: {
      purpose: 'satisfy_runner_obligations',
      obligations: [],
      instruction: [
        'Continue the same user objective.',
        'Satisfy the runner-owned obligations through tool observations before producing a final answer.',
        selection.reason ?? '',
      ].filter(Boolean).join(' '),
    },
  }
}

function runtimePlannerContext(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  state: XoxAgenticOsRunState,
  input: OsRuntimeTurnInput,
): PlannerContext & { thread: Row<'agent_threads'> } {
  const xoxObservations = state.observationBridge.combine(state.xoxObservations, input.observations)
  const loopObligationPlan = agenticSelectionToXoxLoopPlan(state)
  const nextContext: PlannerContext & { thread: Row<'agent_threads'> } = {
    ...ctx,
    message: state.objective,
    planningTurn: input.iteration === 1 ? 'user_objective' : 'evaluator_repair',
    priorObservations: xoxObservations,
  }
  if (loopObligationPlan !== undefined) nextContext.loopObligationPlan = loopObligationPlan
  if (state.goal) nextContext.goalFacts = goalContractFacts(state.goal)
  return nextContext
}

function parseXoxObservationContent(observation: AgentToolObservation): Record<string, unknown> | null {
  return parseToolObservationModelFacts(observation)
}

function completedActionAssistantText(
  state: XoxAgenticOsRunState,
  observations: AgentToolObservation[],
): string | null {
  const pendingActionCount = state.actionRows.filter((row) => row.status === 'pending').length
  const executedActionCount = state.actionRows.filter((row) => row.status === 'executed').length
  if (pendingActionCount > 0 || executedActionCount === 0) return null
  const actionObservations = observations
    .filter(isActionResultToolObservation)
  const lastActionObservation = actionObservations.at(-1)
  return lastActionObservation?.displayPreview?.trim() || null
}

function isFinalizableBusinessObservation(observation: AgentToolObservation): boolean {
  return isFinalizableHostBusinessObservation(observation, {
    readToolName: 'data_query_workspace',
  })
}

function hasFinalAnswerSupportingObservation(
  state: XoxAgenticOsRunState,
  observations: AgentToolObservation[],
): boolean {
  const requiresWriteCapability = stateRequiresWriteCapability(state)
  return observations.some((observation) => {
    if (isActionToolObservation(observation)) return true
    if (isSandboxToolObservation(observation)) return isCompletedValidToolObservation(observation)
    if (!isFinalizableBusinessObservation(observation)) return false
    return observation.toolName !== 'data_query_workspace' || !requiresWriteCapability
  })
}

function money(value: unknown): string {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return `¥${Math.round(numeric).toLocaleString('zh-CN')}`
}

function readableObservationText(observation: AgentToolObservation): string {
  const data = parseXoxObservationContent(observation)
  if (!data) return observation.displayPreview.trim()
  if (data.scope === 'period_summary') {
    return `${data.monthLabel ?? ''}计划收入 ${money(data.plannedRevenue)}，计划成本 ${money(data.plannedCost)}。`
  }
  if (data.scope === 'team_summary') {
    const names = Array.isArray(data.names) && data.names.length > 0 ? `，分别是：${data.names.join('、')}` : ''
    return `当前工作区共有 ${data.memberCount ?? 0} 个成员${names}。`
  }
  if (data.scope === 'entity_summary') {
    const shareholders = Array.isArray(data.shareholders)
      ? data.shareholders.map((shareholder) => {
          const item = shareholder as Record<string, unknown>
          return `${item.index ?? ''}. ${item.name ?? ''} ${money(item.investmentAmount)}`
        }).join('、')
      : ''
    return `当前工作区有 ${data.memberCount ?? 0} 个成员、${data.shareholderCount ?? 0} 个股东。${shareholders ? `股东：${shareholders}。` : ''}`
  }
  if (data.scope === 'workspace_summary') {
    return `基准场景总收入 ${money(data.grossSales)}，总成本 ${money(data.totalCost)}，总利润 ${money(data.totalProfit)}，期末现金 ${money(data.netCashAfterInvestment)}，回本周期 ${data.paybackMonthLabel ?? '未回本'}。`
  }
  if (data.scope === 'ledger_history') {
    const preview = Array.isArray(data.preview) && data.preview.length > 0 ? `：${data.preview.join('；')}` : ''
    return `已按“${data.filterText ?? ''}”筛选账本历史，命中 ${data.count ?? 0} 笔${preview}。`
  }
  if (data.scope === 'variance_detail') {
    const lines = Array.isArray(data.lines) && data.lines.length > 0
      ? ` ${(data.lines as Array<Record<string, unknown>>).map((line) =>
          `${line.subjectName ?? line.subjectKey ?? '科目'} 差异 ${money(line.varianceAmount)}`).join('；')}。`
      : ''
    return `${data.monthLabel ?? ''}收入差异 ${money(data.revenueVarianceAmount)}，成本差异 ${money(data.costVarianceAmount)}。${lines}`
  }
  if (data.observationType === 'sandbox_execution') {
    const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result)
      ? data.result as Record<string, unknown>
      : null
    const extraction = data.extraction && typeof data.extraction === 'object' && !Array.isArray(data.extraction)
      ? data.extraction as Record<string, unknown>
      : null
    const summary = typeof result?.summary === 'string'
      ? result.summary
      : typeof extraction?.summary === 'string'
        ? extraction.summary
        : typeof data.outputText === 'string'
          ? data.outputText
          : ''
    if (summary.trim()) {
      const structured = result?.structured && typeof result.structured === 'object' && !Array.isArray(result.structured)
        ? result.structured as Record<string, unknown>
        : null
      const shareholder = structured?.shareholder && typeof structured.shareholder === 'object' && !Array.isArray(structured.shareholder)
        ? structured.shareholder as Record<string, unknown>
        : structured?.firstShareholder && typeof structured.firstShareholder === 'object' && !Array.isArray(structured.firstShareholder)
          ? structured.firstShareholder as Record<string, unknown>
          : null
      const shareholderName = typeof shareholder?.name === 'string' && shareholder.name.trim().length > 0
        ? shareholder.name.trim()
        : null
      return shareholderName && !summary.includes(shareholderName)
        ? `沙箱结果：${summary.trim()}，${shareholderName}。`
        : `沙箱结果：${summary.trim()}`
    }
  }
  return observation.displayPreview.trim()
}

function objectiveRequiresActionWrite(objectiveText: string): boolean {
  const objective = objectiveText.toLowerCase()
  const isLedgerStatusFilter =
    objectiveText.includes('已作废') &&
    /账本历史|筛选|过滤|查询|查看|查一下/.test(objectiveText)
  return objectiveText.includes('入账') ||
    objectiveText.includes('记账') ||
    objectiveText.includes('并保存') ||
    objectiveText.includes('保存') ||
    objectiveText.includes('改成') ||
    objectiveText.includes('修改') ||
    objectiveText.includes('新增') ||
    objectiveText.includes('删除') ||
    objectiveText.includes('注资') ||
    objectiveText.includes('发布') ||
    objectiveText.includes('分享') ||
    objectiveText.includes('导入') ||
    objectiveText.includes('覆盖') ||
    objectiveText.includes('锁账') ||
    (!isLedgerStatusFilter && objectiveText.includes('作废')) ||
    objectiveText.includes('恢复') ||
    objectiveText.includes('确认卡') ||
    objective.includes('save') ||
    objective.includes('update') ||
    objective.includes('delete') ||
    objective.includes('import')
}

function stateRequiresActionWriteCapability(state: XoxAgenticOsRunState): boolean {
  const facts = state.goal ? goalContractFacts(state.goal) : {}
  return (
    (Array.isArray(facts.requiredActionCapabilities) && facts.requiredActionCapabilities.length > 0) ||
    objectiveRequiresActionWrite(state.objective)
  )
}

function stateRequiresWriteCapability(state: XoxAgenticOsRunState): boolean {
  const facts = state.goal ? goalContractFacts(state.goal) : {}
  const objective = state.objective.toLowerCase()
  const objectiveRequiresSandbox =
    objective.includes('sandbox') ||
    objective.includes('沙箱') ||
    (
      (objective.includes('roi') || objective.includes('回报率') || objective.includes('投资回报')) &&
      (objective.includes('贷款') || objective.includes('利率') || objective.includes('通胀') || objective.includes('股东'))
    )
  return (
    stateRequiresActionWriteCapability(state) ||
    facts.requiresSandboxComputation === true ||
    facts.requiresOrderedEntityFacts === true ||
    objectiveRequiresSandbox
  )
}

function completedReadObservationAssistantText(
  state: XoxAgenticOsRunState,
  observations: AgentToolObservation[],
): { text: string; observations: AgentToolObservation[] } | null {
  if (state.actionRows.some((row) => row.status === 'pending')) return null
  const requiresWriteCapability = stateRequiresWriteCapability(state)
  const selected = selectCompletedReadObservation({
    observations,
    requiresWriteCapability,
    readToolName: 'data_query_workspace',
    isFinalizableBusinessObservation,
  })
  if (!selected) return null
  const lastReadObservation = selected.observation
  return {
    text: lastReadObservation.toolName === 'data_query_workspace' || isFinalizableBusinessObservation(lastReadObservation)
      ? readableObservationText(lastReadObservation)
      : lastReadObservation.displayPreview.trim(),
    observations: selected.observations,
  }
}

function goalContractFacts(goal: Row<'agent_goals'>) {
  try {
    const contract = JSON.parse(goal.contract_json)
    return contract && typeof contract === 'object' ? contract.facts ?? {} : {}
  } catch {
    return {}
  }
}

function goalFactsForRun(
  initialFacts: AgentGoalFacts | null | undefined,
  resumeContext: Awaited<ReturnType<typeof buildXoxClarificationResumeContext>>,
): AgentGoalFacts | null {
  if (!initialFacts) return null
  if (!resumeContext || resumeContext.satisfiedActionCapabilities.length === 0) return initialFacts
  const facts: AgentGoalFacts = { ...initialFacts }
  if (Array.isArray(facts.requiredActionCapabilities)) {
    const satisfied = new Set(resumeContext.satisfiedActionCapabilities)
    const requiredActionCapabilities = facts.requiredActionCapabilities.filter((capability) => !satisfied.has(capability))
    if (requiredActionCapabilities.length > 0) {
      facts.requiredActionCapabilities = requiredActionCapabilities
    } else {
      delete facts.requiredActionCapabilities
    }
  }
  return facts
}

function evidenceHasValidSandbox(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) =>
    item.authority === 'sandbox' &&
    item.validity === 'valid' &&
    isExecutedSandboxEvidenceFacts(item.facts))
}

function evidenceHasOrderedShareholderFacts(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) => {
    if (item.authority !== 'domain_read' || item.validity !== 'valid') return false
    return Object.prototype.hasOwnProperty.call(item.facts, 'firstShareholder') ||
      Object.prototype.hasOwnProperty.call(item.facts, 'shareholders')
  })
}

function shouldRunFinalAnswerClaimReview(input: {
  assistantText: string | null
  pendingActionCount: number
  preReviewEvaluation: ReturnType<typeof evaluateAssistantResponse>
  evidence: AgentEvidenceItem[]
  goalFacts: AgentGoalFacts
}) {
  if (!input.assistantText?.trim()) return false
  if (input.pendingActionCount > 0) return false
  if (input.preReviewEvaluation.status !== 'pass') return false
  if (input.goalFacts.requiresSandboxComputation || input.goalFacts.requiresOrderedEntityFacts) {
    const sandboxSatisfied = !input.goalFacts.requiresSandboxComputation || evidenceHasValidSandbox(input.evidence)
    const entitySatisfied = !input.goalFacts.requiresOrderedEntityFacts || evidenceHasOrderedShareholderFacts(input.evidence)
    if (sandboxSatisfied && entitySatisfied) return false
  }
  if (input.evidence.length === 0) return true
  if (evidenceHasValidSandbox(input.evidence)) return !evidenceHasOrderedShareholderFacts(input.evidence)
  return false
}

const XOX_FINAL_ANSWER_CLAIM_SUBJECT_TYPES = [
  'workspace',
  'shareholder',
  'member',
  'ledger_entry',
  'forecast',
  'calculation',
  'action',
] as const

const XOX_FINAL_ANSWER_CLAIM_EXTRA_PROMPT_LINES = [
  'Entity-specific claims include ordinal or named shareholders/members, such as "the second shareholder", "shareholder B", "member 1", or equivalent expressions in any language.',
  'Derived calculation claims include ROI, payback, inflation adjustment, loan-rate adjustment, profit, cash, projections, allocations, or scenario computations.',
] as const

type XoxFinalAnswerClaimSubjectType = typeof XOX_FINAL_ANSWER_CLAIM_SUBJECT_TYPES[number]

type XoxFinalAnswerClaimExtractionResult =
  | { status: 'completed'; claims: AgentFinalAnswerClaim[] }
  | Extract<AgentServerFinalAnswerClaimExtractionResult, { status: 'skipped' | 'unavailable' }>

function xoxFinalAnswerClaimExtractionCopy(input: AgentServerFinalAnswerClaimExtractionCopyInput) {
  if (input.status === 'started') {
    return {
      title: '最终回答 claim review',
      message: '正在尝试把模型最终回答转成结构化 claim，以便和 run-scoped observation evidence 对齐。',
    }
  }
  if (input.status === 'unavailable') {
    return {
      title: '最终回答 claim review 不可用',
      message: input.reason ??
        `Provider did not return ${AGENT_SERVER_FINAL_ANSWER_CLAIM_EXTRACTION_TOOL_NAME} for optional claim review.`,
    }
  }
  return {
    title: '最终回答 claim 已提取',
    message: `已提取 ${input.claims?.length ?? 0} 个最终回答 claim。`,
  }
}

function isXoxFinalAnswerClaimSubjectType(value: string): value is XoxFinalAnswerClaimSubjectType {
  return (XOX_FINAL_ANSWER_CLAIM_SUBJECT_TYPES as readonly string[]).includes(value)
}

function xoxFinalAnswerClaimSubject(
  subject: OsFinalAnswerClaim['subject'],
): AgentFinalAnswerClaim['subject'] | undefined {
  if (!subject || !isXoxFinalAnswerClaimSubjectType(subject.type)) return undefined
  const xoxSubject: Exclude<AgentFinalAnswerClaim['subject'], string> = {
    type: subject.type,
  }
  if (subject.id !== undefined) {
    xoxSubject.id = subject.id
  }
  if (subject.label !== undefined) {
    xoxSubject.label = subject.label
  }
  return xoxSubject
}

function xoxFinalAnswerClaim(claim: OsFinalAnswerClaim): AgentFinalAnswerClaim {
  const mapped: AgentFinalAnswerClaim = {
    kind: claim.kind,
    reason: claim.reason,
  }
  if (claim.claimId !== undefined) {
    mapped.claimId = claim.claimId
  }
  const subject = xoxFinalAnswerClaimSubject(claim.subject)
  if (subject !== undefined) {
    mapped.subject = subject
  }
  if (claim.dependsOn !== undefined) {
    mapped.dependsOn = claim.dependsOn
  }
  if (claim.text !== undefined) {
    mapped.text = claim.text
  }
  if (claim.metadata !== undefined) {
    mapped.metadata = claim.metadata
  }
  return mapped
}

async function extractXoxFinalAnswerClaims(
  ctx: XoxAgenticOsPlannerContext,
  input: {
    objective: string
    finalAssistantText: string | null
    evidence: AgentEvidenceItem[]
  },
): Promise<XoxFinalAnswerClaimExtractionResult> {
  const options: AgentServerFinalAnswerClaimExtractionOptions = {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    objective: input.objective,
    finalAssistantText: input.finalAssistantText,
    evidence: evidenceForModel(input.evidence).map((item) => compactJsonObject(item)),
    context: compactJsonObject({
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
      user: { id: ctx.user.id },
    }),
    subjectTypes: XOX_FINAL_ANSWER_CLAIM_SUBJECT_TYPES,
    extraSystemPromptLines: XOX_FINAL_ANSWER_CLAIM_EXTRA_PROMPT_LINES,
    requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
    redact: redactSecretLikeContent,
    runtime: async (request) => {
      const runtimeInput: RuntimePlanningInput = {
        settings: ctx.settings,
        message: request.message,
        context: request.context,
        tools: request.tools as ChatTool[],
        messages: request.messages as RuntimeChatMessage[],
        stream: request.stream,
        maxTokens: request.maxTokens,
      }
      if (request.requestTimeoutMs !== undefined) {
        runtimeInput.requestTimeoutMs = request.requestTimeoutMs
      }
      if (request.abortSignal !== undefined) {
        runtimeInput.abortSignal = request.abortSignal as AbortSignal
      }
      return planWithRuntimeAdapter(runtimeInput)
    },
    appendRunEvent: (draft) => addRunEvent(ctx.db, draft),
    copy: xoxFinalAnswerClaimExtractionCopy,
  }
  if (ctx.settings.llmProvider === 'rules') {
    options.skipReason = 'rules_provider'
  }
  if (ctx.abortSignal) {
    options.abortSignal = ctx.abortSignal
  }
  const result = await runAgentServerFinalAnswerClaimExtraction(options)
  if (result.status !== 'completed') return result
  return {
    status: 'completed',
    claims: result.claims.map(xoxFinalAnswerClaim),
  }
}

function loopReadinessSummary(evaluation: ReturnType<typeof serializeEvaluation>) {
  if (evaluation.status === 'pass') return 'Loop Readiness Check 已确认运行图可进入最终回答证据检查。'
  if (evaluation.status === 'needs_confirmation') return 'Loop Readiness Check 已暂停后续规划，等待用户处理确认卡。'
  if (evaluation.status === 'needs_clarification') return 'Loop Readiness Check 已暂停后续规划，等待用户补充信息。'
  if (evaluation.status === 'continue') return 'Loop Readiness Check 发现仍有未满足项，已准备下一轮修复规划。'
  if (evaluation.status === 'blocked') return `Loop Readiness Check 已阻断目标：${evaluation.blocker ?? '存在策略阻断。'}`
  if (evaluation.status === 'failed') return `Loop Readiness Check 判定运行图失败：${evaluation.blocker ?? '存在失败步骤。'}`
  return 'Loop Readiness Check 需要补充信息。'
}

function osEvidenceFromXoxEvidence(evidence: ReturnType<typeof buildEvidenceLedger>): OsAgentEvidence[] {
  return evidence.map((item) => ({
    kind: item.authority,
    label: item.summary ?? item.source,
    value: compactJsonObject({
      id: item.id,
      source: item.source,
      validity: item.validity,
      subject: item.subject ?? null,
      facts: item.facts,
    }),
  }))
}

async function addReadinessEvaluation(input: {
  ctx: XoxAgenticOsPlannerContext
  state: XoxAgenticOsRunState
  iteration: number
}): Promise<ReturnType<typeof serializeEvaluation> | null> {
  if (!input.state.goal) return null
  return recordGoalEvaluation({
    ctx: input.ctx,
    state: input.state,
    iteration: input.iteration,
    allowComplete: false,
  })
}

async function recordGoalEvaluation(input: {
  ctx: XoxAgenticOsPlannerContext
  state: XoxAgenticOsRunState
  iteration: number
  allowComplete: boolean
}): Promise<ReturnType<typeof serializeEvaluation> | null> {
  if (!input.state.goal) return null
  const evaluationRow = await evaluateAgentGoal({
    db: input.ctx.db,
    workspace: input.ctx.workspace,
    goal: input.state.goal,
    iteration: input.iteration,
    allowComplete: input.allowComplete,
  })
  const evaluation = serializeEvaluation(evaluationRow)
  await addRunEvent(input.ctx.db, {
    threadId: input.ctx.thread.id,
    runId: input.ctx.runId,
    type: 'goal_evaluated',
    title: 'Loop Readiness Check 已运行',
    message: loopReadinessSummary(evaluation),
    status:
      evaluation.status === 'pass'
        ? 'running'
        : evaluation.status === 'needs_confirmation'
          ? 'blocked'
          : evaluation.status === 'continue'
            ? 'running'
            : evaluation.status === 'blocked' || evaluation.status === 'failed'
              ? 'failed'
              : 'info',
    data: {
      goalId: input.state.goal.id,
      iteration: input.iteration,
      evaluationStatus: evaluation.status,
      satisfiedCriteria: evaluation.satisfiedCriteria,
      unsatisfiedCount: evaluation.unsatisfiedCriteria.length,
      nextPlannerBrief: evaluation.nextPlannerBrief,
      harness: 'agentic-os',
    },
  })
  const updatedGoal = await input.ctx.db
    .selectFrom('agent_goals')
    .selectAll()
    .where('id', '=', input.state.goal.id)
    .executeTakeFirst()
  if (updatedGoal) input.state.goal = updatedGoal
  return evaluation
}

async function addPendingWriteReadinessEvaluation(input: {
  ctx: XoxAgenticOsPlannerContext
  state: XoxAgenticOsRunState
  iteration: number
}): Promise<ReturnType<typeof serializeEvaluation> | null> {
  if (!input.state.goal) return null
  const finding = {
    id: 'graph.required_write_after_observation',
    criterionId: 'graph.visible_steps',
    severity: 'blocking' as const,
    message: '目标已取得读取 observation，但仍需要继续规划写入动作或确认卡。',
    evidence: { observationCount: input.state.xoxObservations.length },
  }
  const row = await addEvaluationResult(input.ctx.db, input.state.goal, {
    iteration: input.iteration,
    status: 'continue',
    confidence: 0.86,
    satisfiedCriteria: ['graph.visible_steps'],
    unsatisfiedCriteria: [finding],
    policyFindings: [],
    nextPlannerBrief: finding.message,
    userQuestion: null,
    blocker: null,
  })
  const evaluation = serializeEvaluation(row)
  await updateGoalStatus(input.ctx.db, input.state.goal, 'repairing')
  await addRunEvent(input.ctx.db, {
    threadId: input.ctx.thread.id,
    runId: input.ctx.runId,
    type: 'goal_evaluated',
    title: 'Loop Readiness Check 已运行',
    message: loopReadinessSummary(evaluation),
    status: 'running',
    data: {
      goalId: input.state.goal.id,
      iteration: input.iteration,
      evaluationStatus: evaluation.status,
      satisfiedCriteria: evaluation.satisfiedCriteria,
      unsatisfiedCount: evaluation.unsatisfiedCriteria.length,
      nextPlannerBrief: evaluation.nextPlannerBrief,
      harness: 'agentic-os',
    },
  })
  const updatedGoal = await input.ctx.db
    .selectFrom('agent_goals')
    .selectAll()
    .where('id', '=', input.state.goal.id)
    .executeTakeFirst()
  if (updatedGoal) input.state.goal = updatedGoal
  return evaluation
}

function createXoxAgenticOsHost(
  ctx: XoxAgenticOsPlannerContext,
  options: { beforeStateWrite: () => Promise<boolean> },
  state: XoxAgenticOsRunState,
): AgentHostAdapter {
  const store: AgentStorePort = {
    createRun: async () => {
      const run = await ctx.db
        .selectFrom('agent_runs')
        .selectAll()
        .where('id', '=', ctx.runId)
        .executeTakeFirst()
      return osRunRecord(ctx, run ?? null)
    },
    claimRunLane: async ({ run }) => ({
      leaseId: `${run.runId}:xox-worker-lease`,
      runId: run.runId,
      threadId: run.threadId,
    }),
    refreshRunLease: async (lease): Promise<OsRunLeaseCheck> => {
      const active = await options.beforeStateWrite()
      return active
        ? { status: 'active', lease }
        : { status: 'lost', reason: 'xox run lease is no longer active.' }
    },
    releaseRunLane: async (_lease: OsRunLease) => undefined,
    appendEvent: async (event: OsRunEvent) => {
      if (event.type === 'turn.started') {
        const payload = event.payload as Record<string, unknown>
        const iteration = typeof payload.iteration === 'number' ? payload.iteration : null
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'goal_iteration_started',
          title: `目标循环 ${iteration ?? ''}`.trim(),
          message: iteration === 1 ? '开始第一轮模型规划。' : '根据 readiness findings 开始下一轮修复规划。',
          status: 'running',
          data: {
            goalId: state.goal?.id ?? null,
            iteration,
            harness: 'agentic-os',
          },
        })
      }
      if (event.type === 'tool.observed') {
        const payload = event.payload as Record<string, unknown>
        const outcome = typeof payload.outcome === 'string' ? payload.outcome : null
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown_tool'
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null
        const failedOutcome = outcome === 'failed_repairable' ||
          outcome === 'failed_terminal' ||
          outcome === 'completed_invalid' ||
          outcome === 'policy_blocked'
        const observationStatus = payload.status === 'ok' && !failedOutcome ? 'completed' : 'failed'
        const eventType = observationStatus === 'completed' ? 'tool_call_completed' : 'tool_call_failed'
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: eventType,
          title: observationStatus === 'completed' ? '工具调用完成' : '工具调用失败',
          message: `工具调用${observationStatus === 'completed' ? '完成' : '失败'}：${toolName}`,
          status: observationStatus === 'completed' ? 'completed' : 'failed',
          data: {
            runtimeEvent: {
              kind: eventType,
              runId: ctx.runId,
              toolName,
              toolCallId,
              status: observationStatus === 'completed' ? 'completed' : 'failed',
              summary: `工具调用${observationStatus === 'completed' ? '完成' : '失败'}：${toolName}`,
              payload: {
                observationStatus,
                outcome,
                authorityClass: null,
                errorMessage: null,
              },
            },
            harness: 'agentic-os',
          },
        })
      }
      if (event.type === 'tool.guardrail') {
        const payload = event.payload as Record<string, unknown>
        if (payload.pattern === 'repeated_repairable_failure') {
          await addRunEvent(ctx.db, {
            threadId: ctx.thread.id,
            runId: ctx.runId,
            type: 'tool_loop_guardrail',
            title: '工具循环保护已触发',
            message: typeof payload.message === 'string'
              ? payload.message
              : '工具连续返回相同的可修复失败，已停止重复调用。',
            status: 'failed',
            data: {
              ...payload,
              harness: 'agentic-os',
            },
          })
        }
      }
    },
    finishRun: async (result) => {
      state.finishedResult = result
    },
  }

  const runtime: OsRuntimeAdapter = {
    runTurn: async (input) => {
      const xoxObservations = state.loopCoordinator.combineObservations(input.observations)
      applyNewObservationsToLedger(state, xoxObservations, input.iteration)

      const completedActionText = completedActionAssistantText(state, xoxObservations)
      let readinessEvaluation: ReturnType<typeof serializeEvaluation> | null = null
      const readinessObservation = selectReadinessObservation(xoxObservations)
      if (
        readinessObservation &&
        state.loopCoordinator.claimObservation({
          namespace: 'readiness_evaluation',
          observation: readinessObservation,
        })
      ) {
        if (
          !isRepairableToolObservation(readinessObservation) &&
          stateRequiresWriteCapability(state) &&
          state.actionRows.length === 0
        ) {
          readinessEvaluation = await addPendingWriteReadinessEvaluation({ ctx, state, iteration: input.iteration })
        } else {
          readinessEvaluation = await addReadinessEvaluation({
            ctx,
            state,
            iteration: input.iteration,
          })
        }
      }
      if (completedActionText && readinessEvaluation?.status !== 'continue') {
        if (hasNonActionHostObservation(xoxObservations)) {
          const continuation = await continueModelAfterToolObservations({
            db: ctx.db,
            settings: ctx.settings,
            workspace: ctx.workspace,
            user: ctx.user,
            threadId: ctx.thread.id,
            runId: ctx.runId,
            message: state.objective,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          }, xoxObservations)
          if (continuation.status === 'answered') {
            return {
              assistantText: continuation.assistantText,
            }
          }
          if (continuation.status === 'failed') {
            state.planRows.push(continuation.planStep)
          }
        }
        return {
          assistantText: completedActionText,
        }
      }
      const sandboxFinalizerObservation = selectSandboxFinalizerObservation({
        observations: xoxObservations,
        claim: (observation) => state.loopCoordinator.claimObservation({
          namespace: 'sandbox_finalizer',
          observation,
        }),
      })
      if (sandboxFinalizerObservation) {
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'observation_assistant_continuation_requested',
          title: '基于工具结果生成回复',
          message: '工具 observation 已满足当前 runner obligations，下一步用无工具 assistant continuation 生成最终回答候选。',
          status: 'running',
          data: {
            goalId: state.goal?.id ?? null,
            iteration: input.iteration,
            observationCount: xoxObservations.length,
            toolNames: xoxObservations.map((observation) => observation.toolName),
            harness: 'agentic-os',
          },
        })
        return {
          assistantText: readableObservationText(sandboxFinalizerObservation),
        }
      }
      const completedRead = completedReadObservationAssistantText(state, xoxObservations)
      if (completedRead) {
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'observation_continuation_requested',
          title: '继续基于工具结果规划',
          message: '工具结果已作为 observation 回到 Agentic OS harness，本轮 read observation 可直接进入最终回答证据检查。',
          status: 'running',
          data: {
            observationCount: completedRead.observations.length,
            toolNames: completedRead.observations.map((observation) => observation.toolName),
            harness: 'agentic-os',
          },
        })
        return {
          assistantText: completedRead.text,
        }
      }
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'model_planning',
        title: '模型规划中',
        message: '正在通过 Agentic OS runtime port 调用配置的模型，并等待 provider-native tool calls。',
        status: 'running',
        data: { provider: ctx.settings.llmProvider, iteration: input.iteration },
      })
      const result = normalizeRuntimePlanResultForAgenticOs(
        state,
        await callRuntimePlanner(runtimePlannerContext(ctx, state, input)),
      )
      state.plannerSource = result?.source ?? state.plannerSource
      if (result?.error) {
        const graph = await storePlannedActionGraph(ctx, {
          items: readDraftsFromRuntimeResult(result),
          plannerSource: state.plannerSource,
          emitPlanReady: false,
        })
        applyStoredGraph(state, graph)
        const boundaryToolNames = [
          ...(result.error.toolCallBoundary?.toolNames ?? []),
          ...(result.error.toolNames ?? []),
        ].filter((toolName, index, values) => toolName && values.indexOf(toolName) === index)
        const missingObservationRepair = runtimeBoundaryMissingObservationRepair({
          ledger: state.obligationLedger,
          objective: state.objective,
          toolNames: boundaryToolNames,
        })
        if (missingObservationRepair) {
          await addRunEvent(ctx.db, {
            threadId: ctx.thread.id,
            runId: ctx.runId,
            type: 'runtime_evidence_required',
            title: '需要补齐工具证据',
            message: 'Provider 已产生 sandbox_run_code 工具调用意图，但没有形成对应工具 observation；最终回答前必须补齐 sandbox evidence 或失败关闭。',
            status: 'running',
            data: {
              toolNames: missingObservationRepair.toolNames,
              reason: 'provider_tool_call_without_observation_after_retry',
              requiredGoalFacts: missingObservationRepair.requiredGoalFacts,
              harness: 'agentic-os',
            },
          })
          await addRunEvent(ctx.db, {
            threadId: ctx.thread.id,
            runId: ctx.runId,
            type: 'response_evaluated',
            title: '最终回答证据检查',
            message: '最终回答还缺少可复核计算 evidence。',
            status: 'running',
            data: {
              goalId: state.goal?.id ?? null,
              evaluationStatus: missingObservationRepair.evaluation.status,
              confidence: missingObservationRepair.evaluation.confidence,
              evidenceCount: 0,
              evidence: [],
              findings: missingObservationRepair.evaluation.findings,
              requiredEvidence: missingObservationRepair.evaluation.requiredEvidence,
              finalAnswerClaims: [],
              claimReviewStatus: null,
              claimReviewReason: null,
              obligationLedger: missingObservationRepair.obligationLedger,
              obligationPlan: missingObservationRepair.obligationPlan,
              nextPlannerBrief: missingObservationRepair.nextPlannerBrief,
              harness: 'agentic-os',
            },
          })
        }
      }
      return runtimePlannerResultToTurnOutput(result, {
        unknownToolNamePrefix: 'xox_unknown_tool_',
        unknownToolCallIdPrefix: 'xox_step_',
      })
    },
  }

  const context: AgentContextPort = {
    assemble: async (input): Promise<OsAgentContext> => ({
      messages: [
        {
          role: 'user',
          content: input.request.userMessage,
        },
      ],
      facts: {
        xoxRunId: ctx.runId,
        xoxObservationCount: input.observations.length,
      },
    }),
  }

  const tools: AgentToolRegistryPort = {
    listTools: async (input) => {
      state.lastToolSelection = input.toolSelection ?? null
      return AGENT_TOOL_REGISTRY.map((entry) => agenticOsToolDefinition(ctx, state, entry))
    },
  }

  const actions: AgentActionPort = {
    previewAction: async (input) => {
      const rawStep = plannerStepFromToolCall(input.tool.name, input.toolCall.toolCallId, input.input)
      const step = rawStep ? normalizeToolStepForObjective(state, rawStep) : null
      if (!step) throw new Error(`No xox planner step mapping exists for tool ${input.tool.name}.`)
      const graph = await storeSingleToolStep(ctx, state, step, {
        forceManualApproval: true,
        emitPlanReady: input.approvalPolicy?.mode === 'auto_execute' ? false : true,
      })
      const action = graph.actionRows.at(-1)
      if (!action) {
        throw new Error(`Tool ${input.tool.name} did not create an xox action request.`)
      }
      return osActionRequest(action, input.toolCall.toolCallId)
    },
    executeAction: async (input: OsActionExecutionInput): Promise<OsActionExecutionResult> => {
      const action = await ctx.db
        .selectFrom('agent_action_requests')
        .selectAll()
        .where('id', '=', input.actionRequest.actionRequestId)
        .executeTakeFirstOrThrow()
      const result = await executeAgentActionRequest(ctx.db, ctx.settings, ctx.user, action)
      const updated = await ctx.db
        .selectFrom('agent_action_requests')
        .selectAll()
        .where('id', '=', action.id)
        .executeTakeFirstOrThrow()
      await addRunEvent(ctx.db, {
        threadId: updated.thread_id,
        runId: updated.run_id,
        type: 'action_auto_executed',
        title: '动作已自动执行',
        message: `已自动执行：${updated.title}`,
        status: 'completed',
        data: {
          actionRequestId: updated.id,
          actionKind: updated.kind,
          reason: input.reason ?? null,
          harness: 'agentic-os',
        },
      })
      replaceActionRow(state, updated)
      const xoxObservation = actionExecutionObservation({ action: updated, result })
      state.xoxObservations.push(xoxObservation)
      const observation = state.observationBridge.toCanonical(xoxObservation, state.xoxObservations.length - 1)
      return {
        actionRequest: osActionRequest(updated, input.actionRequest.toolCallId),
        observation,
        audit: osAudit({
          runId: updated.run_id,
          threadId: updated.thread_id,
          actionRequestId: updated.id,
          toolCallId: input.actionRequest.toolCallId,
          toolName: updated.kind,
          actorId: ctx.user.id,
          outcome: 'executed',
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      }
    },
    editAction: async (input: OsActionEditInput): Promise<OsActionEditResult> => ({
      actionRequest: {
        ...input.actionRequest,
        status: 'edited',
        preview: input.preview,
      },
      audit: osAudit({
        runId: input.run.runId,
        threadId: input.run.threadId,
        actionRequestId: input.actionRequest.actionRequestId,
        toolCallId: input.actionRequest.toolCallId,
        toolName: input.actionRequest.toolName,
        actorId: input.actorId,
        outcome: 'edited',
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      }),
    }),
    rejectAction: async (input: OsActionRejectionInput): Promise<OsActionRejectionResult> => ({
      actionRequest: {
        ...input.actionRequest,
        status: 'rejected',
      },
      audit: osAudit({
        runId: input.run.runId,
        threadId: input.run.threadId,
        actionRequestId: input.actionRequest.actionRequestId,
        toolCallId: input.actionRequest.toolCallId,
        toolName: input.actionRequest.toolName,
        actorId: input.actorId,
        outcome: 'rejected',
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      }),
    }),
  }

  const sandbox: AgentSandboxPort = {
    executeSandbox: async (input): Promise<OsSandboxExecutionResult> => {
      const rawStep = plannerStepFromToolCall(input.tool.name, input.toolCall.toolCallId, input.input)
      const step = rawStep ? normalizeToolStepForObjective(state, rawStep) : null
      if (!step) {
        return {
          content: {
            error: `No xox planner step mapping exists for sandbox tool ${input.tool.name}.`,
          },
          manifestScoped: false,
          executionMode: 'not_executed',
          status: 'failed',
          outcome: 'failed_terminal',
        }
      }

      const graph = await storeSingleToolStep(ctx, state, step)
      const xoxObservation = graph.observations.at(-1) ?? toolSupervisorFailureObservation(step)
      const osObservation = state.observationBridge.toCanonical(xoxObservation, state.xoxObservations.length)
      const facts = parseToolObservationModelFacts(xoxObservation)
      const result: OsSandboxExecutionResult = {
        content: osObservation.content,
        manifestScoped: facts?.manifestScoped === true,
      }
      if (osObservation.outcome !== undefined) result.outcome = osObservation.outcome
      const executionMode = sandboxExecutionModeFromFacts(facts)
      if (executionMode !== null) result.executionMode = executionMode
      const status = sandboxExecutionStatusFromFacts(facts, xoxObservation)
      if (status !== null) result.status = status
      const actionRequests = graph.actionRows.map((row) => osActionRequest(row, input.toolCall.toolCallId))
      if (actionRequests.length > 0) result.actionRequests = actionRequests
      return result
    },
  }

  const completion: AgentCompletionPort = {
    reviewFinal: async (input): Promise<OsFinalReview> => {
      if (!state.goal) {
        return {
          pass: false,
          reason: 'xox goal contract was not created.',
          repairable: false,
        }
      }
      const reviewIteration = state.loopCoordinator.nextFinalReviewIteration()
      const reviewObservations = state.loopCoordinator.combineObservations(input.observations)
      state.loopCoordinator.mergeHostObservations(reviewObservations)
      applyNewObservationsToLedger(state, reviewObservations, reviewIteration)
      const evidence = buildEvidenceLedger({
        threadId: ctx.thread.id,
        runId: ctx.runId,
        observations: reviewObservations,
      })
      const runtimeFacts = await readRuntimeGoalFacts(ctx.db, ctx.runId)
      const goalFacts = mergeAgentGoalFacts(goalContractFacts(state.goal), runtimeFacts)
      const pendingActionCount = state.actionRows.filter((row) => row.status === 'pending').length
      const preReviewEvaluation = evaluateAssistantResponse({
        goal: state.goal,
        finalAssistantText: input.assistantText,
        observations: reviewObservations,
        evidence,
        runtimeFacts: goalFacts,
        finalAnswerClaims: [],
        pendingActionCount,
      })
      if (
        input.assistantText.trim() &&
        pendingActionCount === 0 &&
        state.actionRows.length === 0 &&
        stateRequiresActionWriteCapability(state) &&
        !hasFinalAnswerSupportingObservation(state, reviewObservations)
      ) {
        if (reviewIteration >= 2) {
          const reason = '缺少必要的工具调用或确认卡，模型连续返回普通文本，已停止重复修复。'
          await addRunEvent(ctx.db, {
            threadId: ctx.thread.id,
            runId: ctx.runId,
            type: 'tool_loop_guardrail',
            title: '工具循环保护已触发',
            message: reason,
            status: 'failed',
            data: {
              pattern: 'missing_required_tool_call_after_repair',
              goalId: state.goal.id,
              iteration: reviewIteration,
              harness: 'agentic-os',
            },
          })
          return {
            pass: false,
            reason,
            repairable: false,
            evidence: [],
          }
        }
        return {
          pass: false,
          reason: '模型返回了普通文本，但当前目标仍需要工具调用生成写入确认卡或可验证 observation。',
          repairable: true,
          evidence: [],
        }
      }
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'final_answer_candidate',
        title: '最终回答候选已生成',
        message: '模型已基于本轮 observation 生成最终回答候选，进入 response evaluation。',
        status: 'running',
        channel: 'assistant',
        data: {
          goalId: state.goal.id,
          priorObservationCount: state.xoxObservations.length,
          harness: 'agentic-os',
        },
      })
      const claimExtraction = shouldRunFinalAnswerClaimReview({
        assistantText: input.assistantText,
        pendingActionCount,
        preReviewEvaluation,
        evidence,
        goalFacts,
      })
        ? await extractXoxFinalAnswerClaims(ctx, {
            objective: state.objective,
            finalAssistantText: input.assistantText,
            evidence,
          })
        : input.assistantText.trim()
          ? { status: 'skipped' as const, reason: 'deterministic_evidence_satisfied' as const }
          : null
      const finalAnswerClaims = claimExtraction?.status === 'completed' ? claimExtraction.claims : []
      const evaluation = claimExtraction?.status === 'completed'
        ? evaluateAssistantResponse({
            goal: state.goal,
            finalAssistantText: input.assistantText,
            observations: reviewObservations,
            evidence,
            runtimeFacts: goalFacts,
            finalAnswerClaims,
            pendingActionCount,
          })
        : preReviewEvaluation
      applyResponseEvaluationToLedger({
        ledger: state.obligationLedger,
        evaluation,
        iteration: reviewIteration,
      })
      let obligationPlan = ledgerToObligationPlan({
        ledger: state.obligationLedger,
        objective: state.objective,
      })
      let responseEventLedger = serializeObligationLedgerForResponseEvent({
        ledger: state.obligationLedger,
        evaluation,
      })
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'agentic_os.final_reviewed',
        title: '最终回答证据检查',
        message: responseEvaluationSummary(evaluation),
        status: evaluation.status === 'pass'
          ? 'completed'
          : evaluation.status === 'blocked'
            ? 'failed'
            : 'running',
        data: {
          harness: 'agentic-os',
          evaluationStatus: evaluation.status,
          confidence: evaluation.confidence,
          evidenceCount: evidence.length,
          findings: evaluation.findings,
          requiredEvidence: evaluation.requiredEvidence,
          finalAnswerClaims,
          obligationLedger: responseEventLedger,
          obligationPlan,
        },
      })
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'response_evaluated',
        title: '最终回答证据检查',
        message: responseEvaluationSummary(evaluation),
        status: evaluation.status === 'pass'
          ? 'completed'
          : evaluation.status === 'blocked'
            ? 'failed'
            : 'running',
        data: {
          goalId: state.goal.id,
          evaluationStatus: evaluation.status,
          confidence: evaluation.confidence,
          evidenceCount: evidence.length,
          evidence: evidence.map((item) => ({
            id: item.id,
            authority: item.authority,
            source: item.source,
            subject: item.subject,
            summary: item.summary,
          })),
          findings: evaluation.findings,
          requiredEvidence: evaluation.requiredEvidence,
          finalAnswerClaims,
          claimReviewStatus: claimExtraction?.status ?? null,
          claimReviewReason: claimExtraction?.status === 'unavailable' ? claimExtraction.reason : null,
          obligationLedger: responseEventLedger,
          obligationPlan,
          nextPlannerBrief: evaluation.nextPlannerBrief,
          harness: 'agentic-os',
        },
      })
      if (evaluation.requiredEvidence.some((requirement) => requirement.authority === 'sandbox')) {
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'runtime_evidence_required',
          title: '运行证据要求已收紧',
          message: '最终回答需要可复核的 sandbox_run_code observation。',
          status: 'running',
          data: {
            toolNames: ['sandbox_run_code'],
            requiredGoalFacts: { requiresSandboxComputation: true },
            harness: 'agentic-os',
          },
        })
      }
      if (
        evaluation.status === 'needs_calculation' ||
        evaluation.status === 'needs_final_answer'
      ) {
        const materialized = await materializeLoopObligations({
          ctx,
          ledger: state.obligationLedger,
          plannerSource: state.plannerSource,
          taskCache: state.loopCoordinator.materializationTaskCache,
        })
        if (materialized) {
          applyStoredGraph(state, materialized)
          applyNewObservationsToLedger(state, materialized.observations, reviewIteration)
          obligationPlan = ledgerToObligationPlan({
            ledger: state.obligationLedger,
            objective: state.objective,
          })
          responseEventLedger = serializeObligationLedgerForResponseEvent({
            ledger: state.obligationLedger,
            evaluation,
          })
        }
      }
      const latestReadinessStatus = await latestGoalEvaluationStatus(ctx, state)
      if (!(evaluation.status === 'pass' && latestReadinessStatus === 'pass')) {
        await recordGoalEvaluation({
          ctx,
          state,
          iteration: reviewIteration,
          allowComplete: evaluation.status === 'pass',
        })
      }
      const osEvidence = osEvidenceFromXoxEvidence(evidence)
      if (evaluation.status === 'pass') {
        await updateGoalStatus(ctx.db, state.goal, 'completed')
        return {
          pass: true,
          evidence: osEvidence,
        }
      }
      if (evaluation.status === 'awaiting_clarification') {
        await updateGoalStatus(ctx.db, state.goal, 'needs_clarification')
        return {
          pass: false,
          reason: responseEvaluationSummary(evaluation),
          repairable: false,
          clarification: {
            question: input.assistantText.trim() ||
              evaluation.findings.find((finding) => finding.severity === 'info')?.message ||
              responseEvaluationSummary(evaluation),
          },
          evidence: osEvidence,
        }
      }
      return {
        pass: false,
        reason: evaluation.findings.find((finding) => finding.severity === 'fail')?.message ??
          evaluation.nextPlannerBrief ??
          responseEvaluationSummary(evaluation),
        repairable: evaluation.status === 'needs_calculation' ||
          evaluation.status === 'needs_more_evidence' ||
          evaluation.status === 'needs_final_answer',
        obligations: ledgerToReviewObligations(osLedgerFromXoxLedger(state.obligationLedger)),
        evidence: osEvidence,
      }
    },
  }

  return {
    store,
    runtime,
    context,
    tools,
    actions,
    sandbox,
    completion,
  }
}

async function latestRunRows(ctx: PlannerContext) {
  const [actionRows, planRows] = await Promise.all([
    ctx.db
      .selectFrom('agent_action_requests')
      .selectAll()
      .where('run_id', '=', ctx.runId)
      .orderBy('created_at', 'asc')
      .execute(),
    ctx.db
      .selectFrom('agent_plan_steps')
      .selectAll()
      .where('run_id', '=', ctx.runId)
      .orderBy('sequence_no', 'asc')
      .execute(),
  ])
  return { actionRows, planRows }
}

async function nextGoalEvaluationIteration(ctx: PlannerContext): Promise<number> {
  const row = await ctx.db
    .selectFrom('agent_evaluations')
    .select(({ fn }) => fn.max<number>('iteration_no').as('maxIteration'))
    .where('run_id', '=', ctx.runId)
    .executeTakeFirst()
  return Number(row?.maxIteration ?? 0) + 1
}

async function latestGoalEvaluationStatus(
  ctx: PlannerContext,
  state: XoxAgenticOsRunState,
): Promise<string | null> {
  if (!state.goal) return null
  const row = await ctx.db
    .selectFrom('agent_evaluations')
    .select('status')
    .where('goal_id', '=', state.goal.id)
    .orderBy('iteration_no', 'desc')
    .executeTakeFirst()
  return row?.status ?? null
}

async function finalizeAgenticOsResult(
  ctx: XoxAgenticOsPlannerContext,
  state: XoxAgenticOsRunState,
  result: OsRunResult,
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgenticOsKernelRunResult | null> {
  let assistantMessage: Row<'agent_messages'> | null = null

  if (result.status === 'completed') {
    if (!(await options.beforeStateWrite())) return null
    assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', result.assistantText)
  } else if (result.status === 'awaiting_confirmation') {
    const accountStep = state.planRows.find((row) =>
      row.title.includes('账号') || row.description.includes('账号登录、退出、注销'))
    const pendingActionCount = state.actionRows.filter((row) => row.status === 'pending').length
    if (pendingActionCount > 0 && state.goal) {
      await recordGoalEvaluation({
        ctx,
        state,
        iteration: await nextGoalEvaluationIteration(ctx),
        allowComplete: false,
      })
    }
    if (accountStep || pendingActionCount > 0) {
      if (!(await options.beforeStateWrite())) return null
      assistantMessage = await addMessage(
        ctx.db,
        ctx.thread.id,
        'assistant',
        accountStep?.description ?? `已生成 ${pendingActionCount} 张待确认动作卡，请检查后确认或编辑。`,
      )
    }
  } else if (result.status === 'awaiting_clarification') {
    if (!(await options.beforeStateWrite())) return null
    assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', result.question)
  } else if (result.status === 'blocked' || result.status === 'failed') {
    const reason = result.reason || 'Agentic OS harness did not complete the run.'
    if (state.goal) await updateGoalStatus(ctx.db, state.goal, 'failed', { blockedReason: reason })
    if (result.status === 'blocked' && reason.includes('Iteration budget exhausted')) {
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'goal_iteration_exhausted',
        title: '目标循环已耗尽',
        message: `Agent 已达到本轮最大修复次数，但目标仍未完成：${reason}`,
        status: 'failed',
        data: {
          goalId: state.goal?.id ?? null,
          maxIterations: 5,
          harness: 'agentic-os',
        },
      })
    }
    const providerConfigurationFailure = state.planRows.some((row) =>
      row.status === 'failed' &&
      (row.title.includes('模型') || row.description.includes('API key') || row.description.includes('认证失败')))
    if (!providerConfigurationFailure) {
      if (!(await options.beforeStateWrite())) return null
      assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', `这轮没有完成所有目标：${reason}`)
    }
  } else if (result.status === 'cancelled') {
    const reason = result.reason || 'Run was cancelled.'
    if (state.goal) await updateGoalStatus(ctx.db, state.goal, 'cancelled', { blockedReason: reason })
  }

  await consolidateExecutedActionMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
    actionRows: state.actionRows,
    message: '已从 Agentic OS 运行结果沉淀记忆候选。',
  })
  await flushThreadContextToMemoryIfNeeded({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
  })
  const dreamReport = await runMemoryDreamingSweep({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
  })
  if (dreamReport) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'memory_dreaming_reported',
      title: '记忆整理报告已生成',
      message: dreamReport.summary,
      status: 'info',
      data: {
        dreamReportId: dreamReport.id,
        candidateIds: JSON.parse(dreamReport.candidate_ids_json),
        source: 'openclaw_dreaming_sweep',
      },
    })
  }
  const [{ actionRows, planRows }, finalGoal] = await Promise.all([
    latestRunRows(ctx),
    state.goal
      ? ctx.db.selectFrom('agent_goals').select('status').where('id', '=', state.goal.id).executeTakeFirst()
      : Promise.resolve(null),
  ])
  if (!(await options.beforeStateWrite())) return null
  return {
    plannerSource: state.plannerSource,
    assistantMessage,
    navigationEvents: state.navigationEvents,
    actionRows,
    planRows,
    goalStatus: finalGoal?.status as AgentGoalStatus | null ?? null,
  }
}

export async function executeXoxAgenticOsRun(
  ctx: XoxAgenticOsPlannerContext,
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgenticOsKernelRunResult | null> {
  const resumeContext = await buildXoxClarificationResumeContext({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    thread: ctx.thread,
    runId: ctx.runId,
    message: ctx.message,
  })
  const rawObjective = resumeContext?.objective ?? ctx.message
  const providedWorkspaceBundle = ctx.providedWorkspaceBundle ?? extractWorkspaceBundleArtifact(rawObjective) ?? undefined
  const objective = providedWorkspaceBundle?.messageForModel ?? rawObjective
  const initialGoalFacts = goalFactsForRun(ctx.initialGoalFacts ?? null, resumeContext)
  const goal = await createGoalContract({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
    objective,
    automationLevel: ctx.automationLevel,
    goalFacts: initialGoalFacts,
  })
  const xoxObservations: AgentToolObservation[] = []
  const observationBridge = createXoxObservationBridge()
  const state: XoxAgenticOsRunState = {
    plannerSource: configuredRuntimePlannerSource(ctx.settings) ?? 'rules',
    goal,
    objective,
    navigationEvents: [],
    actionRows: [],
    planRows: [],
    xoxObservations,
    observationBridge,
    loopCoordinator: createAgentHostLoopCoordinator({
      observationBridge,
      hostObservations: xoxObservations,
    }),
    obligationLedger: initializeObligationLedger({ runId: ctx.runId }),
    lastToolSelection: null,
    finishedResult: null,
  }

  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'goal_contract_created',
    title: '目标契约已建立',
    message: 'Agentic OS harness 已建立目标契约，后续由 Agentic OS loop 推进工具、评估和最终回答。',
    status: 'info',
    data: { goalId: goal.id, maxIterations: JSON.parse(goal.contract_json).maxIterations },
  })
  if (resumeContext) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'clarification_resume_context',
      title: '澄清目标已续接',
      message: '本轮用户消息已作为上一轮待澄清目标的补充信息进入 Agentic OS harness。',
      status: 'info',
      data: {
        goalId: goal.id,
        resumedGoalId: resumeContext.resumedGoalId,
        resumedRunId: resumeContext.resumedRunId,
      },
    })
  }

  const planningCtx: XoxAgenticOsPlannerContext = {
    ...ctx,
    message: objective,
    goalFacts: goalContractFacts(goal),
    ...(providedWorkspaceBundle ? { providedWorkspaceBundle } : {}),
  }
  const initialPrerequisites = await runInitialPrerequisiteObservations(planningCtx, {
    goalFacts: goalContractFacts(goal),
    observations: state.xoxObservations,
    plannerSource: state.plannerSource,
  })
  if (!(await options.beforeStateWrite())) return null
  if (initialPrerequisites) applyStoredGraph(state, initialPrerequisites)

  const initialOsObservations = state.xoxObservations.map((observation, index) => {
    return state.observationBridge.toCanonical(observation, index)
  })
  const run = await ctx.db
    .selectFrom('agent_runs')
    .selectAll()
    .where('id', '=', ctx.runId)
    .executeTakeFirst()
  const request = osRunInput(planningCtx, objective, goalContractFacts(goal))
  const host = createXoxAgenticOsHost(planningCtx, options, state)
  const kit = createAgentHostKit(host, {
    engineOptions: {
      defaultMaxIterations: 5,
    },
  })
  const resumeInput = {
    run: osRunRecord(ctx, run ?? null),
    request,
    observations: initialOsObservations,
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
  }
  const result = await kit.resume(resumeInput, {
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })

  return finalizeAgenticOsResult(ctx, state, result, options)
}
