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
  AgentEvidenceRecord as OsAgentEvidenceRecord,
  AgentEvidenceRequirement as OsAgentEvidenceRequirement,
  AgentFinalAnswerClaim as OsFinalAnswerClaim,
  AgentLoopObligation as OsAgentLoopObligation,
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
  inferToolAuthorityClass,
  ledgerToReviewObligations,
  obligationMaterializationCompletedEventPayload,
  parseToolObservationModelFacts,
  planObligationMaterialization,
  runtimePlannerResultToTurnOutput,
  sandboxExecutionModeFromFacts,
  sandboxExecutionStatusFromFacts,
  selectReadinessObservation,
  type AgentHostLoopCoordinator,
  type AgentActionPort,
  type AgentCompletionPort,
  type AgentContextPort,
  type AgentHostAdapter,
  type AgentLoopObligationMaterializationCache,
  type AgentSandboxPort,
  type AgentStorePort,
  type AgentToolRegistryPort,
} from '@agentic-os/core'
import {
  AGENT_SERVER_FINAL_ANSWER_CLAIM_EXTRACTION_TOOL_NAME,
  agentServerRunLifecycleEvents,
  reviewAgentServerFinalResponse,
  runAgentServerFinalAnswerClaimExtraction,
  runAgentServerFinalResponseReviewCycle,
  type AgentServerFinalAnswerClaimExtractionCopyInput,
  type AgentServerFinalAnswerClaimExtractionOptions,
  type AgentServerFinalAnswerClaimExtractionResult,
} from '@agentic-os/server'
import type { AgentGoalFacts, AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import { parseJson } from '../../db/database.js'
import type { Row } from '../../db/schema.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { PlannerContext } from './xox-planned-items.js'
import {
  answerWorkspaceDataQuestion,
  executeAgentActionRequest,
  xoxBusinessToolHandlers,
  type WorkspaceDataQueryStep,
} from '../tool-executor.js'
import {
  buildPlannedItemFromRuntimeStep,
  createXoxObservationBridge,
  isActionDraft,
  readDraftsFromRuntimeResult,
  toolSupervisorFailureObservation,
  toolSupervisorFailureReadDraft,
  type AgentToolObservation,
  type PlannedItem,
  type PlannedItemResult,
  type XoxObservationBridge,
} from './xox-planned-items.js'
import {
  actionExecutionObservation,
  storePlannedActionGraph,
  type StoredActionGraph,
} from '../agentic-os/xox-action-graph-adapter.js'
import {
  buildEvidenceLedger,
  evidenceForModel,
  type AgentEvidenceItem,
  type ResponseRequiredEvidence,
} from './xox-final-review-policy.js'
import {
  addEvaluationResult,
  buildXoxClarificationResumeContext,
  createGoalContract,
  evaluateAgentGoal,
  getGoalForRun,
  serializeEvaluation,
  updateGoalStatus,
} from '../agentic-os/xox-goal-store-adapter.js'
import {
  consolidateExecutedActionMemory,
  flushThreadContextToMemoryIfNeeded,
} from '../memory.js'
import { runMemoryDreamingSweep } from '../memory.js'
import { responseEvaluationSummary, type ResponseEvaluation } from './xox-final-review-policy.js'
import {
  callRuntimePlanner,
  configuredRuntimePlannerSource,
  planWithRuntimeAdapter,
  type RuntimeChatMessage,
  type RuntimePlanningInput,
  type RuntimePlanResult,
} from './xox-provider-runtime.js'
import {
  mergeAgentGoalFacts,
  readRuntimeGoalFacts,
} from './xox-goal-facts.js'
import { addRunEvent } from '../agentic-os/xox-run-event-store-adapter.js'
import { addMessage } from '../agentic-os/xox-thread-store-adapter.js'
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
import { redactSecretLikeContent } from '../memory.js'
import { normalizeAgentAutomationLevel } from '../tool-policy.js'
import {
  applyObservationToLedger,
  applyResponseEvaluationToLedger,
  initializeObligationLedger,
  ledgerToObligationPlan,
  osEvidenceFromXoxEvidence,
  serializeObligationLedgerForResponseEvent,
  type AgentLoopLedgerObligation,
  type AgentLoopObligationLedger,
} from './xox-final-review-policy.js'
import { extractWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'

export type AgenticOsKernelRunResult = {
  agenticOsResult: OsRunResult
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
  lastActionExecutionResult: unknown | null
}

function createXoxRunState(input: {
  runId: string
  threadId?: string
  plannerSource: AgentPlannerSource
  goal: Row<'agent_goals'> | null
  objective: string
  actionRows?: Row<'agent_action_requests'>[]
  planRows?: Row<'agent_plan_steps'>[]
}): XoxAgenticOsRunState {
  const xoxObservations: AgentToolObservation[] = []
  const observationBridge = createXoxObservationBridge()
  return {
    plannerSource: input.plannerSource,
    goal: input.goal,
    objective: input.objective,
    navigationEvents: [],
    actionRows: input.actionRows ?? [],
    planRows: input.planRows ?? [],
    xoxObservations,
    observationBridge,
    loopCoordinator: createAgentHostLoopCoordinator({
      observationBridge,
      hostObservations: xoxObservations,
    }),
    obligationLedger: initializeObligationLedger({
      runId: input.runId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }),
    lastToolSelection: null,
    finishedResult: null,
    lastActionExecutionResult: null,
  }
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

function obligationMetadataValue(obligation: AgentLoopLedgerObligation, key: string): unknown {
  const direct = obligation.metadata?.[key]
  if (direct !== undefined) return direct
  const host = obligation.metadata?.host
  return host && typeof host === 'object' && !Array.isArray(host)
    ? (host as Record<string, unknown>)[key]
    : undefined
}

function obligationMetadataStringArray(obligation: AgentLoopLedgerObligation, key: string): string[] | undefined {
  const value = obligationMetadataValue(obligation, key)
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return values.length > 0 ? values : undefined
}

function xoxObligationKind(obligation: AgentLoopLedgerObligation) {
  const value = obligationMetadataValue(obligation, 'xoxKind')
  if (typeof value === 'string') return value
  const evidenceKind = obligationMetadataValue(obligation, 'evidenceKind')
  if (evidenceKind === 'sandbox_calculation') return 'sandbox_calculation'
  if (evidenceKind === 'domain_fact') return 'domain_fact'
  const authority = obligationMetadataValue(obligation, 'authority')
  if (authority === 'sandbox') return 'sandbox_calculation'
  if (authority === 'domain_read') return 'domain_fact'
  return obligation.kind
}

function obligationSubjectType(obligation: AgentLoopLedgerObligation): string | null {
  const direct = obligationMetadataValue(obligation, 'subject')
  if (typeof direct === 'string') return direct
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const type = (direct as Record<string, unknown>).type
    return typeof type === 'string' && type.trim().length > 0 ? type : null
  }
  return null
}

function dataQueryArgumentsForObligation(obligation: AgentLoopLedgerObligation): WorkspaceDataQueryStep | null {
  if (xoxObligationKind(obligation) !== 'domain_fact') return null
  const canUseDataTool = (obligation.toolNames ?? []).includes('data_query_workspace') ||
    (obligation.capabilities ?? []).includes('data')
  if (!canUseDataTool) return null
  const subjectType = obligationSubjectType(obligation)
  const scope = obligationMetadataStringArray(obligation, 'requiredDataScopes')?.[0] ??
    (subjectType === 'shareholder' ? 'entity_summary' : 'workspace_summary')
  const metadataMetrics = obligationMetadataStringArray(obligation, 'requiredMetrics')
  const metrics = metadataMetrics ?? (subjectType === 'shareholder'
    ? ['shareholderNames', 'shareholderInvestments']
    : [])
  return {
    question: obligation.reason,
    scope,
    ...(metrics.length > 0 ? { metrics } : {}),
  }
}

function xoxToolNamesForObligation(obligation: OsAgentLoopObligation): string[] | null {
  if ((obligation.toolNames ?? []).length > 0) return null
  if ((obligation.capabilities ?? []).includes('data')) return ['data_query_workspace']
  if ((obligation.capabilities ?? []).includes('sandbox')) return ['sandbox_run_code']
  return null
}

function xoxObligationForAgenticOs(obligation: OsAgentLoopObligation): OsAgentLoopObligation {
  const toolNames = xoxToolNamesForObligation(obligation)
  return toolNames === null
    ? obligation
    : {
        ...obligation,
        toolNames,
      }
}

function xoxResponseEvaluationForAgenticOs(evaluation: ResponseEvaluation): ResponseEvaluation {
  if (!evaluation.obligations?.length) return evaluation
  return {
    ...evaluation,
    obligations: evaluation.obligations.map(xoxObligationForAgenticOs),
  }
}

function xoxReviewObligationsForAgenticOs(ledger: AgentLoopObligationLedger): OsAgentLoopObligation[] {
  return ledgerToReviewObligations(ledger).map(xoxObligationForAgenticOs)
}

function obligationMaterializationRequests(
  ledger: AgentLoopObligationLedger,
): AgentLoopObligationMaterializationRequest[] {
  return ledger.obligations.flatMap((obligation) => {
    const toolArguments = dataQueryArgumentsForObligation(obligation)
    if (!toolArguments) return []
    return [{
      obligationId: obligation.obligationId,
      toolName: 'data_query_workspace',
      toolArguments: toolArguments as unknown as OsJsonObject,
    }]
  })
}

async function materializeDataObservation(input: {
  ctx: PlannerContext
  obligation: AgentLoopLedgerObligation
  toolArguments: WorkspaceDataQueryStep
  plannerSource: AgentPlannerSource
}) {
  const read = await answerWorkspaceDataQuestion(input.ctx, input.toolArguments)
  const toolCallId = `runner_obligation_${input.ctx.runId}_${input.obligation.obligationId}`
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
          obligationId: input.obligation.obligationId,
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
  const obligationsById = new Map(input.ledger.obligations.map((obligation) => [obligation.obligationId, obligation]))
  const plan = planObligationMaterialization({
    ledger: input.ledger,
    taskCache: input.taskCache,
    tasks: obligationMaterializationRequests(input.ledger),
  })

  for (const task of plan.tasks) {
    const obligation = obligationsById.get(task.obligationId)
    if (obligation === undefined) continue

    await addRunEvent(input.ctx.db, agentServerRunLifecycleEvents.runnerObligationMaterializing({
      threadId: input.ctx.threadId,
      runId: input.ctx.runId,
      payload: task.startedEventPayload as Record<string, unknown>,
    }))

    const graph = await materializeDataObservation({
      ctx: input.ctx,
      obligation,
      toolArguments: task.toolArguments as unknown as WorkspaceDataQueryStep,
      plannerSource: input.plannerSource,
    })
    if (graph) graphs.push(graph)
  }

  if (graphs.length === 0) return null

  await addRunEvent(input.ctx.db, agentServerRunLifecycleEvents.runnerObligationMaterialized({
    threadId: input.ctx.threadId,
    runId: input.ctx.runId,
    observationCount: graphs.reduce((sum, graph) => sum + graph.observations.length, 0),
    toolNames: graphs.flatMap((graph) => graph.observations.map((observation) => observation.toolName)),
    failed: graphs.some((graph) => graph.observations.some((observation) => observation.status === 'failed')),
    payload: obligationMaterializationCompletedEventPayload({
      observationCount: graphs.reduce((sum, graph) => sum + graph.observations.length, 0),
      toolNames: graphs.flatMap((graph) => graph.observations.map((observation) => observation.toolName)),
    }) as Record<string, unknown>,
  }))

  return {
    assistantText: null,
    observations: graphs.flatMap((graph) => graph.observations),
    navigationEvents: graphs.flatMap((graph) => graph.navigationEvents),
    actionRows: graphs.flatMap((graph) => graph.actionRows),
    planRows: graphs.flatMap((graph) => graph.planRows),
    plannerSource: graphs.at(-1)?.plannerSource ?? input.plannerSource,
  }
}

function osRunInput(ctx: PlannerContext, objective: string): OsRunInput {
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

  if (entry.name === 'workspace_update_online_factor') {
    definition.resolveAuthorityClass = (input) =>
      input.mode === 'forecast' ? 'read' : authorityClass
  }

  if (authorityClass === 'read' || entry.name === 'workspace_update_online_factor') {
    definition.executeRead = async (input): Promise<OsToolHandlerResult> => {
      const rawStep = plannerStepFromToolCall(entry.name, input.toolCall.toolCallId, input.input)
      const step = rawStep ? normalizeToolStepForObjective(rawStep) : null
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

function normalizeToolStepForObjective(step: AgentToolCallStep): AgentToolCallStep {
  if (toolStepName(step) !== 'workspace_update_online_factor') return step
  if (step.mode === 'write') return step
  if (step.mode === 'forecast') {
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
  const result = await buildPlannedItemFromRuntimeStep(ctx, step, xoxBusinessToolHandlers)
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

function osEvidenceRecordsFromXoxEvidence(evidence: AgentEvidenceItem[]): OsAgentEvidenceRecord[] {
  return evidence.map((item) => ({
    evidenceId: item.id,
    runId: item.runId,
    threadId: item.threadId,
    authority: item.authority,
    validity: item.validity,
    source: item.source,
    facts: item.facts as OsJsonObject,
    createdAt: item.createdAt,
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.observationId ? { observationId: item.observationId } : {}),
    ...(item.subject !== undefined ? { subject: item.subject } : {}),
    ...(item.invalidReasons !== undefined ? { invalidReasons: item.invalidReasons } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
  }))
}

function responseRequiredEvidence(evidenceRequirements: OsAgentEvidenceRequirement[]): ResponseEvaluation['requiredEvidence'] {
  return evidenceRequirements.map((requirement) => ({
    authority: requirement.authority as ResponseRequiredEvidence['authority'],
    ...(requirement.subject ? { subject: requirement.subject.type } : {}),
    reason: requirement.reason,
  }))
}

function reviewXoxFinalResponseWithAgenticOsServer(input: {
  finalAssistantText: string | null
  observationCount: number
  evidence: AgentEvidenceItem[]
  finalAnswerClaims?: OsFinalAnswerClaim[]
  goalFacts: AgentGoalFacts
  pendingActionCount?: number
  awaitingClarification?: boolean
}): ResponseEvaluation {
  return reviewAgentServerFinalResponse<ResponseRequiredEvidence>({
    finalAssistantText: input.finalAssistantText,
    observationCount: input.observationCount,
    evidenceRecords: osEvidenceRecordsFromXoxEvidence(input.evidence),
    facts: input.goalFacts as Record<string, unknown>,
    finalAnswerClaims: input.finalAnswerClaims ?? [],
    buildRequiredEvidence: responseRequiredEvidence,
    ...(input.pendingActionCount !== undefined ? { pendingActionCount: input.pendingActionCount } : {}),
    ...(input.awaitingClarification !== undefined ? { awaitingClarification: input.awaitingClarification } : {}),
    copy: {
      missingFinalAnswerRequiredEvidence: [{
        authority: 'domain_read',
        reason: '工具 observation 已产生，但还没有模型最终回答。',
      }],
      awaitingConfirmation: {
        severity: 'info',
        code: 'response.pending_confirmation_interrupt',
        message: '运行图中仍有待确认动作，不能把说明文字判定为目标完成。',
        confidence: 0.99,
        nextPlannerBrief: null,
      },
      awaitingClarification: {
        severity: 'info',
        code: 'response.pending_clarification_interrupt',
        message: '运行图中仍有待澄清问题，不能把说明文字判定为目标完成。',
        confidence: 0.99,
        nextPlannerBrief: null,
      },
      missingFinalAnswer: {
        severity: 'fail',
        code: 'response.final_answer_missing',
        message: '工具结果只能作为 observation，不能替代面向用户的 assistant final answer。',
        confidence: 0.99,
        nextPlannerBrief: '基于已经取得的 observation 生成最终回答；不要把工具返回原文当成最终回答。',
      },
      providerProtocolArtifact: ({ artifactFormat }) => ({
        severity: 'fail',
        code: 'response.provider_tool_call_text_not_final',
        message: `Provider 返回了 ${artifactFormat} 工具调用协议文本，不能作为面向用户的最终回答。`,
        confidence: 0.99,
        nextPlannerBrief: '上一轮 provider 把工具调用协议片段放进 assistant content。不要把它当最终回答；如果还需要工具，必须通过结构化 tool_calls 继续，否则基于已取得 observation 输出自然语言最终回答。',
      }),
      emptyFinalAnswer: {
        severity: 'fail',
        code: 'response.empty_final_answer',
        message: '没有可展示的最终回答。',
        confidence: 0.98,
        nextPlannerBrief: '生成一个面向用户的最终回答。',
      },
      defaultEvidenceFailure: {
        status: 'needs_more_evidence',
        code: 'response.evidence_missing',
        message: '本轮缺少必要的结构化事实 evidence。',
        confidence: 0.9,
        nextPlannerBrief: '补充必要的工作区事实，再基于该事实生成最终回答。',
        evidenceIds: 'all',
      },
      pass: () => ({
        confidence: input.evidence.some((item) => item.authority === 'sandbox') ? 0.94 : 0.9,
        code: 'response.evidence_accepted',
        evidenceIds: input.evidence.filter((item) => item.authority !== 'memory').map((item) => item.id),
        message: input.evidence.some((item) => item.authority === 'sandbox')
          ? '最终回答已在 sandbox/domain evidence 之后生成。'
          : '最终回答已在当前 run evidence 之后生成。',
      }),
    },
  })
}

function finalResponseReviewSnapshot(input: {
  observations: AgentToolObservation[]
  evidence: AgentEvidenceItem[]
}) {
  return {
    observationCount: input.observations.length,
    evidence: input.evidence,
    evidenceRecords: osEvidenceRecordsFromXoxEvidence(input.evidence),
    responseEventData: {
      evidence: input.evidence.map((item) => ({
        id: item.id,
        authority: item.authority,
        source: item.source,
        subject: item.subject,
        summary: item.summary,
      })),
    },
  }
}

function finalResponseReviewEventCopy(input: {
  phase: 'initial' | 'after_materialization'
  evaluation: ResponseEvaluation
}) {
  return {
    title: input.phase === 'after_materialization' ? '最终回答证据复检' : '最终回答证据检查',
    message: responseEvaluationSummary(input.evaluation),
  }
}

function finalResponseRuntimeEvidenceRequest(evaluation: ResponseEvaluation) {
  if (!evaluation.requiredEvidence.some((requirement) => requirement.authority === 'sandbox')) return null
  return {
    toolNames: ['sandbox_run_code'],
    reason: 'final_answer_requires_sandbox_evidence',
    requiredGoalFacts: { requiresSandboxComputation: true },
    copy: {
      title: '运行证据要求已收紧',
      message: '最终回答需要可复核的 sandbox_run_code observation。',
    },
  }
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
  | { status: 'completed'; claims: OsFinalAnswerClaim[] }
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
): OsFinalAnswerClaim['subject'] | undefined {
  if (!subject || !isXoxFinalAnswerClaimSubjectType(subject.type)) return undefined
  const xoxSubject: NonNullable<OsFinalAnswerClaim['subject']> = {
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

function xoxFinalAnswerClaim(claim: OsFinalAnswerClaim): OsFinalAnswerClaim {
  const mapped: OsFinalAnswerClaim = {
    kind: claim.kind,
    reason: claim.reason,
  }
  if (claim.claimId !== undefined) {
    mapped.claimId = claim.claimId
  }
  const subject = xoxFinalAnswerClaimSubject(claim.subject) ??
    (claim.kind === 'entity_specific' || claim.kind === 'domain_fact'
      ? { type: 'shareholder' }
      : undefined)
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
  await addRunEvent(input.ctx.db, agentServerRunLifecycleEvents.goalEvaluated({
    threadId: input.ctx.thread.id,
    runId: input.ctx.runId,
    goalId: input.state.goal.id,
    iteration: input.iteration,
    evaluationStatus: evaluation.status,
    satisfiedCriteria: evaluation.satisfiedCriteria,
    unsatisfiedCount: evaluation.unsatisfiedCriteria.length,
    nextPlannerBrief: evaluation.nextPlannerBrief,
    copy: {
      title: 'Loop Readiness Check 已运行',
      message: loopReadinessSummary(evaluation),
    },
  }))
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
        await addRunEvent(ctx.db, agentServerRunLifecycleEvents.goalIterationStarted({
          threadId: ctx.thread.id,
          runId: ctx.runId,
          goalId: state.goal?.id ?? null,
          iteration,
          copy: {
            title: `目标循环 ${iteration ?? ''}`.trim(),
            message: iteration === 1 ? '开始第一轮模型规划。' : '根据 readiness findings 开始下一轮修复规划。',
          },
        }))
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

      const readinessObservation = selectReadinessObservation(xoxObservations)
      if (
        readinessObservation &&
        state.loopCoordinator.claimObservation({
          namespace: 'readiness_evaluation',
          observation: readinessObservation,
        })
      ) {
        await addReadinessEvaluation({
          ctx,
          state,
          iteration: input.iteration,
        })
      }
      await addRunEvent(ctx.db, agentServerRunLifecycleEvents.modelPlanning({
        threadId: ctx.thread.id,
        runId: ctx.runId,
        provider: ctx.settings.llmProvider,
        iteration: input.iteration,
        copy: {
          title: '模型规划中',
          message: '正在通过 Agentic OS runtime port 调用配置的模型，并等待 provider-native tool calls。',
        },
      }))
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
      const step = rawStep ? normalizeToolStepForObjective(rawStep) : null
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
      state.lastActionExecutionResult = result
      await addRunEvent(ctx.db, input.reason === undefined
        ? agentServerRunLifecycleEvents.actionExecuted({
            threadId: updated.thread_id,
            runId: updated.run_id,
            actionRequestId: updated.id,
            actionKind: updated.kind,
            actionTitle: updated.title,
            copy: {
              title: '确认卡已执行',
              message: `已执行：${updated.title}`,
            },
          })
        : agentServerRunLifecycleEvents.actionAutoExecuted({
            threadId: updated.thread_id,
            runId: updated.run_id,
            actionRequestId: updated.id,
            actionKind: updated.kind,
            actionTitle: updated.title,
            reason: input.reason,
            copy: {
              title: '动作已自动执行',
              message: `已自动执行：${updated.title}`,
            },
          }))
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
      const step = rawStep ? normalizeToolStepForObjective(rawStep) : null
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
      let reviewObservations = state.loopCoordinator.combineObservations(input.observations)
      state.loopCoordinator.mergeHostObservations(reviewObservations)
      applyNewObservationsToLedger(state, reviewObservations, reviewIteration)
      let evidence = buildEvidenceLedger({
        threadId: ctx.thread.id,
        runId: ctx.runId,
        observations: reviewObservations,
      })
      const runtimeFacts = await readRuntimeGoalFacts(ctx.db, ctx.runId)
      const goalFacts = mergeAgentGoalFacts(goalContractFacts(state.goal), runtimeFacts)
      const pendingActionCount = state.actionRows.filter((row) => row.status === 'pending').length
      const reviewCycle = await runAgentServerFinalResponseReviewCycle<ResponseRequiredEvidence, AgentEvidenceItem, StoredActionGraph>({
        threadId: ctx.thread.id,
        runId: ctx.runId,
        goalId: state.goal.id,
        finalAssistantText: input.assistantText,
        pendingActionCount,
        priorObservationCount: state.xoxObservations.length,
        initialSnapshot: finalResponseReviewSnapshot({ observations: reviewObservations, evidence }),
        review: ({ snapshot, finalAnswerClaims }) => reviewXoxFinalResponseWithAgenticOsServer({
          finalAssistantText: input.assistantText,
          observationCount: snapshot.observationCount,
          evidence: [...snapshot.evidence],
          goalFacts,
          finalAnswerClaims,
          pendingActionCount,
        }),
        normalizeEvaluation: xoxResponseEvaluationForAgenticOs,
        extractClaims: ({ snapshot }) => extractXoxFinalAnswerClaims(ctx, {
          objective: state.objective,
          finalAssistantText: input.assistantText,
          evidence: [...snapshot.evidence],
        }),
        applyEvaluation: ({ evaluation }) => applyResponseEvaluationToLedger({
          ledger: state.obligationLedger,
          evaluation,
          iteration: reviewIteration,
        }),
        projectEventState: ({ evaluation }) => ({
          obligationLedger: serializeObligationLedgerForResponseEvent({
            ledger: state.obligationLedger,
            evaluation,
          }),
          obligationPlan: ledgerToObligationPlan({
            ledger: state.obligationLedger,
            objective: state.objective,
          }),
        }),
        runtimeEvidenceRequired: ({ evaluation }) => finalResponseRuntimeEvidenceRequest(evaluation),
        materialize: () => materializeLoopObligations({
          ctx,
          ledger: state.obligationLedger,
          plannerSource: state.plannerSource,
          taskCache: state.loopCoordinator.materializationTaskCache,
        }),
        afterMaterialize: async ({ materialized }) => {
          applyStoredGraph(state, materialized)
          applyNewObservationsToLedger(state, materialized.observations, reviewIteration)
          reviewObservations = state.loopCoordinator.combineObservations(input.observations)
          state.loopCoordinator.mergeHostObservations(reviewObservations)
          evidence = buildEvidenceLedger({
            threadId: ctx.thread.id,
            runId: ctx.runId,
            observations: reviewObservations,
          })
          return finalResponseReviewSnapshot({ observations: reviewObservations, evidence })
        },
        appendRunEvent: (draft) => addRunEvent(ctx.db, draft),
        copy: {
          finalAnswerCandidate: () => ({
            title: '最终回答候选已生成',
            message: '模型已基于本轮 observation 生成最终回答候选，进入 response evaluation。',
          }),
          finalReviewed: finalResponseReviewEventCopy,
          responseEvaluated: finalResponseReviewEventCopy,
        },
      })
      const evaluation = reviewCycle.evaluation
      evidence = [...reviewCycle.snapshot.evidence]
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
        obligations: xoxReviewObligationsForAgenticOs(state.obligationLedger),
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
    const pendingActionCount = state.actionRows.filter((row) => row.status === 'pending').length
    if (pendingActionCount > 0 && state.goal) {
      await recordGoalEvaluation({
        ctx,
        state,
        iteration: await nextGoalEvaluationIteration(ctx),
        allowComplete: false,
      })
    }
  } else if (result.status === 'awaiting_clarification') {
    if (!(await options.beforeStateWrite())) return null
    assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', result.question)
  } else if (result.status === 'blocked' || result.status === 'failed') {
    if (state.goal) await updateGoalStatus(ctx.db, state.goal, 'failed', { blockedReason: result.reason })
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
    await addRunEvent(ctx.db, agentServerRunLifecycleEvents.memoryDreamingReported({
      threadId: ctx.thread.id,
      runId: ctx.runId,
      dreamReportId: dreamReport.id,
      candidateIds: JSON.parse(dreamReport.candidate_ids_json),
      source: 'openclaw_dreaming_sweep',
      copy: {
        title: '记忆整理报告已生成',
        message: dreamReport.summary,
      },
    }))
  }
  const [{ actionRows, planRows }, finalGoal] = await Promise.all([
    latestRunRows(ctx),
    state.goal
      ? ctx.db.selectFrom('agent_goals').select('status').where('id', '=', state.goal.id).executeTakeFirst()
      : Promise.resolve(null),
  ])
  if (!(await options.beforeStateWrite())) return null
  return {
    agenticOsResult: result,
    plannerSource: state.plannerSource,
    assistantMessage,
    navigationEvents: state.navigationEvents,
    actionRows,
    planRows,
    goalStatus: finalGoal?.status as AgentGoalStatus | null ?? null,
  }
}

export async function resumeXoxAgenticOsRunAfterActionConfirmation(input: {
  db: PlannerContext['db']
  settings: PlannerContext['settings']
  user: PlannerContext['user']
  workspace: Row<'workspaces'>
  action: Row<'agent_action_requests'>
  abortSignal?: AbortSignal
  beforeStateWrite?: () => Promise<boolean>
}): Promise<{
  actionRequest: Row<'agent_action_requests'>
  actionResult: unknown
  runResult: AgenticOsKernelRunResult | null
}> {
  const beforeStateWrite = input.beforeStateWrite ?? (async () => true)
  const [thread, run, goalRow] = await Promise.all([
    input.db
      .selectFrom('agent_threads')
      .selectAll()
      .where('id', '=', input.action.thread_id)
      .executeTakeFirstOrThrow(),
    input.db
      .selectFrom('agent_runs')
      .selectAll()
      .where('id', '=', input.action.run_id)
      .executeTakeFirstOrThrow(),
    getGoalForRun(input.db, input.action.run_id),
  ])
  const goal = goalRow ?? null
  const objective = goal?.objective?.trim() || run.input_message?.trim() || input.action.title
  const goalFacts = goal ? goalContractFacts(goal) : {}
  const planningCtx: XoxAgenticOsPlannerContext = {
    db: input.db,
    settings: input.settings,
    user: input.user,
    workspace: input.workspace,
    threadId: thread.id,
    runId: run.id,
    message: objective,
    automationLevel: normalizeAgentAutomationLevel(run.automation_level),
    thread,
    goalFacts,
  }
  if (input.abortSignal) planningCtx.abortSignal = input.abortSignal

  const { actionRows, planRows } = await latestRunRows(planningCtx)
  const state = createXoxRunState({
    runId: run.id,
    threadId: thread.id,
    plannerSource: configuredRuntimePlannerSource(input.settings) ?? 'rules',
    goal,
    objective,
    actionRows,
    planRows,
  })
  const host = createXoxAgenticOsHost(planningCtx, { beforeStateWrite }, state)
  const kit = createAgentHostKit(host, {
    engineOptions: {
      defaultMaxIterations: 5,
      pendingActionCollection: {
        enabledByDefault: true,
        maxActions: 8,
      },
    },
  })
  const request = osRunInput(planningCtx, objective)
  const osRun: OsRunRecord = {
    ...osRunRecord(planningCtx, run),
    status: 'awaiting_confirmation',
  }
  const confirmInput = {
    run: osRun,
    actionRequest: osActionRequest(input.action, `action_${input.action.id}`),
    actorId: input.user.id,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  }
  const execution = await kit.confirmAction(confirmInput)
  if (state.actionRows.some((row) => row.status === 'pending')) {
    const actionRequest = await input.db
      .selectFrom('agent_action_requests')
      .selectAll()
      .where('id', '=', input.action.id)
      .executeTakeFirstOrThrow()
    return {
      actionRequest,
      actionResult: state.lastActionExecutionResult,
      runResult: null,
    }
  }
  const resumeInput = {
    run: osRun,
    request,
    observations: [execution.observation],
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
  }
  const result = await kit.resume(resumeInput, {
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  })
  const runResult = await finalizeAgenticOsResult(planningCtx, state, result, { beforeStateWrite })
  const actionRequest = await input.db
    .selectFrom('agent_action_requests')
    .selectAll()
    .where('id', '=', input.action.id)
    .executeTakeFirstOrThrow()
  return {
    actionRequest,
    actionResult: state.lastActionExecutionResult,
    runResult,
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
  const state = createXoxRunState({
    runId: ctx.runId,
    threadId: ctx.thread.id,
    plannerSource: configuredRuntimePlannerSource(ctx.settings) ?? 'rules',
    goal,
    objective,
  })

  await addRunEvent(ctx.db, agentServerRunLifecycleEvents.goalContractCreated({
    threadId: ctx.thread.id,
    runId: ctx.runId,
    goalId: goal.id,
    maxIterations: JSON.parse(goal.contract_json).maxIterations,
    copy: {
      title: '目标契约已建立',
      message: 'Agentic OS harness 已建立目标契约，后续由 Agentic OS loop 推进工具、评估和最终回答。',
    },
  }))
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
  const run = await ctx.db
    .selectFrom('agent_runs')
    .selectAll()
    .where('id', '=', ctx.runId)
    .executeTakeFirst()
  const request = osRunInput(planningCtx, objective)
  const host = createXoxAgenticOsHost(planningCtx, options, state)
  const kit = createAgentHostKit(host, {
    engineOptions: {
      defaultMaxIterations: 5,
      pendingActionCollection: {
        enabledByDefault: true,
        maxActions: 8,
      },
    },
  })
  const resumeInput = {
    run: osRunRecord(ctx, run ?? null),
    request,
    observations: [],
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
  }
  const result = await kit.resume(resumeInput, {
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })

  return finalizeAgenticOsResult(ctx, state, result, options)
}
