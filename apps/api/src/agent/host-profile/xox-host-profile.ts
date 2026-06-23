import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
  AgentObservation as OsObservation,
  AgentRunEvent as OsRunEvent,
  AgentRunInput as OsRunInput,
  AgentRunLease as OsRunLease,
  AgentRunLeaseCheck as OsRunLeaseCheck,
  AgentRunRecord as OsRunRecord,
  AgentRunResult as OsRunResult,
  AgentSandboxExecutionResult as OsSandboxExecutionResult,
  AgentScope as OsScope,
  AgentToolCall as OsToolCall,
  AgentToolDefinition as OsToolDefinition,
  AgentToolHandlerResult as OsToolHandlerResult,
  AgentToolAuthorityClass as OsToolAuthorityClass,
  AgentToolConfirmationMode as OsToolConfirmationMode,
  AgentToolRiskLevel as OsToolRiskLevel,
  JsonObject as OsJsonObject,
  JsonValue as OsJsonValue,
  RuntimeAdapter as OsRuntimeAdapter,
  RuntimeToolDescriptor as OsRuntimeToolDescriptor,
  RuntimeTurnInput as OsRuntimeTurnInput,
  RuntimeTurnOutput as OsRuntimeTurnOutput,
} from '@agentic-os/contracts'
import {
  contextWithoutRuntimeConversationLog,
  inferToolAuthorityClass,
  normalizeAgentAutomationLevel,
  parseToolObservationModelFacts,
  runtimeConversationLogFromContext,
  runtimeMessagesFromConversationLog,
  sandboxExecutionModeFromFacts,
  sandboxExecutionStatusFromFacts,
  type AgentActionPort,
  type AgentCompletionPort,
  type AgentContextPort,
  type AgentHostAdapter,
  type AgentSandboxPort,
  type AgentStorePort,
  type AgentToolRegistryPort,
} from '@agentic-os/core'
import {
  agentServerRunLifecycleEvents,
  createAgentServer,
  type AgentServerRuntimeStreamEvent,
} from '@agentic-os/server'
import {
  buildProviderToolObservationTurnMessages,
  resolveProviderRuntimeProfile,
  runOpenAICompatibleRuntimeTurn,
  type NormalizedProviderToolCall,
  type OpenAiCompatibleFunctionToolDescriptor,
  type OpenAICompatibleRuntimeTurnError,
  type OpenAICompatibleRuntimeTurnEvent,
} from '@agentic-os/runtime-openai-compatible'
import {
  runOpenAIAgentsTurn,
  type OpenAIAgentsRuntimeEvent,
} from '@agentic-os/runtime-openai-agents'
import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import { hydrateModelConfig } from '@xox/domain'
import { parseJson } from '../../db/database.js'
import type { Row } from '../../db/schema.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import { listPeriods, listSubjectsForPeriod } from '../../modules/ledger.js'
import { getWorkspaceDraft, listVersions } from '../../modules/workspace.js'
import type { PlannerContext } from './xox-planned-items.js'
import {
  executeAgentActionRequest,
  safeAgentActionErrorMessage,
  xoxBusinessToolHandlers,
} from '../tool-executor.js'
import {
  buildPlannedItemFromRuntimeStep,
  createXoxObservationBridge,
  toolSupervisorFailureObservation,
  toolSupervisorFailureReadDraft,
  type AgentToolObservation,
  type PlannedItem,
  type PlannedItemResult,
  type XoxObservationBridge,
} from './xox-planned-items.js'
import {
  actionExecutionObservation,
  actionFailureObservation,
  storePlannedActionGraph,
  type StoredActionGraph,
} from '../agentic-os/xox-action-graph-adapter.js'
import { addAgenticOsActionRunEvent, addRunEvent, addRuntimeStreamRunEvent } from '../agentic-os/xox-run-event-store-adapter.js'
import { addMessage } from '../agentic-os/xox-thread-store-adapter.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCallStep,
  type AgentToolCapability,
  type AgentToolConfirmationMode,
  type AgentToolRiskLevel,
  type ChatTool,
} from '../tool-catalog.js'
import { buildAgentWritableConfigContext } from '../tool-catalog.js'
import { redactSecretLikeContent } from '../memory.js'
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

type XoxAgentRunContext = PlannerContext & {
  thread: Row<'agent_threads'>
}

type XoxHostState = {
  plannerSource: AgentPlannerSource
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  xoxObservations: AgentToolObservation[]
  observationBridge: XoxObservationBridge
  finishedResult: OsRunResult | null
  lastActionExecutionResult: unknown | null
}

const PLANNING_USER_CONTENT_MAX_CHARS = 64_000
const PLANNING_POLICY_PROMPT = readFileSync(
  fileURLToPath(new URL('./prompts/xox-planning-policy.md', import.meta.url)),
  'utf8',
).trim()
const THREAD_LOG_LIMIT = 8
const THREAD_LOG_CONTENT_LIMIT = 800

function createXoxHostState(input: {
  plannerSource: AgentPlannerSource
  actionRows?: Row<'agent_action_requests'>[]
  planRows?: Row<'agent_plan_steps'>[]
}): XoxHostState {
  return {
    plannerSource: input.plannerSource,
    navigationEvents: [],
    actionRows: input.actionRows ?? [],
    planRows: input.planRows ?? [],
    xoxObservations: [],
    observationBridge: createXoxObservationBridge(),
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

function compactMessageContent(content: string) {
  const artifact = extractWorkspaceBundleArtifact(content)
  return (artifact?.messageForModel ?? content).replace(/\s+/g, ' ').trim().slice(0, THREAD_LOG_CONTENT_LIMIT)
}

function buildThreadConversationLog(input: {
  recentMessages: Row<'agent_messages'>[]
}) {
  const messages = [...input.recentMessages]
  const last = messages.at(-1)
  if (last?.role === 'user') messages.pop()

  return {
    policy: 'same-thread recent messages; redacted; untrusted; for resolving references and corrections only',
    messages: messages.slice(-THREAD_LOG_LIMIT).map((message) => ({
      role: message.role,
      createdAt: message.created_at,
      content: compactMessageContent(redactSecretLikeContent(message.content)),
    })),
  }
}

async function buildXoxHostContextFacts(ctx: XoxAgentRunContext, userMessage: string) {
  const [draft, periods, versions, snapshot, recentMessagesDesc] = await Promise.all([
    getWorkspaceDraft(ctx.db, ctx.workspace),
    listPeriods(ctx.db, ctx.workspace),
    listVersions(ctx.db, ctx.workspace),
    ctx.db
      .selectFrom('agent_context_snapshots')
      .selectAll()
      .where('workspace_id', '=', ctx.workspace.id)
      .where('user_id', '=', ctx.user.id)
      .where('thread_id', '=', ctx.thread.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst(),
    ctx.db
      .selectFrom('agent_messages')
      .selectAll()
      .where('thread_id', '=', ctx.thread.id)
      .orderBy('created_at', 'desc')
      .limit(THREAD_LOG_LIMIT)
      .execute(),
  ])
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const ledgerSubjects = periods[0]
    ? (await listSubjectsForPeriod(ctx.db, ctx.workspace, periods[0].id)).map((subject) => ({
        key: subject.subjectKey,
        name: subject.subjectName,
        type: subject.subjectType,
        group: subject.subjectGroup,
      }))
    : []
  const providedWorkspaceBundle = ctx.providedWorkspaceBundle ?? extractWorkspaceBundleArtifact(userMessage) ?? undefined

  return {
    currentDate: utcNow().slice(0, 10),
    months: config.months.map((month, index) => ({ label: month.label, index, id: month.id })),
    teamMembers: config.teamMembers.map((member) => ({ id: member.id, name: member.name })),
    employees: config.employees.map((employee) => ({ id: employee.id, name: employee.name, role: employee.role })),
    shareholders: config.shareholders.map((shareholder, index) => ({
      index: index + 1,
      id: shareholder.id,
      name: shareholder.name,
      investmentAmount: shareholder.investmentAmount,
      dividendRate: shareholder.dividendRate,
    })),
    costItems: {
      monthlyFixed: config.operating.monthlyFixedCosts.map((item) => ({ id: item.id, name: item.name, amount: item.amount })),
      perEvent: config.operating.perEventCosts.map((item) => ({ id: item.id, name: item.name, amount: item.amount })),
      perUnit: config.operating.perUnitCosts.map((item) => ({ id: item.id, name: item.name, amount: item.amount })),
      stage: config.stageCostItems.map((item) => ({ id: item.id, name: item.name, mode: item.mode })),
    },
    versions: versions.map((version) => ({ versionNo: version.version_no, name: version.name, kind: version.kind })),
    periods: periods.map((period) => ({ id: period.id, monthLabel: period.monthLabel })),
    ledgerSubjects,
    contextSummary: snapshot?.summary ?? null,
    threadConversationLog: buildThreadConversationLog({
      recentMessages: recentMessagesDesc.reverse(),
    }),
    writableConfig: buildAgentWritableConfigContext(config),
    ...(providedWorkspaceBundle
      ? {
          providedArtifacts: {
            workspaceBundle: providedWorkspaceBundle.summary,
          },
        }
      : {}),
  }
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

function plannerSource(settings: PlannerContext['settings']): AgentPlannerSource {
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

function flattenPlannedItems(result: PlannedItemResult): PlannedItem[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

function applyStoredGraph(state: XoxHostState, graph: StoredActionGraph): void {
  state.plannerSource = graph.plannerSource ?? state.plannerSource
  state.navigationEvents.push(...graph.navigationEvents)
  state.actionRows.push(...graph.actionRows)
  state.planRows.push(...graph.planRows)
  state.xoxObservations.push(...graph.observations)
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

async function storeSingleToolStep(
  ctx: XoxAgentRunContext,
  state: XoxHostState,
  step: AgentToolCallStep,
  options: { forceManualApproval?: boolean; emitPlanReady?: boolean } = {},
): Promise<StoredActionGraph> {
  const result = await buildPlannedItemFromRuntimeStep(ctx, step, xoxBusinessToolHandlers)
  const items = flattenPlannedItems(result)
  const graph = await storePlannedActionGraph(
    options.forceManualApproval ? { ...ctx, automationLevel: 'manual' } : ctx,
    {
      items: items.length > 0 ? items : [toolSupervisorFailureReadDraft(step)],
      plannerSource: state.plannerSource,
      ...(options.emitPlanReady !== undefined ? { emitPlanReady: options.emitPlanReady } : {}),
    },
  )
  applyStoredGraph(state, graph)
  return graph
}

function agenticOsToolDefinition(
  ctx: XoxAgentRunContext,
  state: XoxHostState,
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
    capability: entry.capability,
    riskLevel: entry.riskLevel as OsToolRiskLevel,
    confirmationMode: entry.confirmationMode as OsToolConfirmationMode,
    authorityClass,
    navigationTarget: entry.navigationTarget,
    validate: (input) => ({ value: compactJsonObject(input) }),
  }

  if (entry.name === 'workspace_update_online_factor') {
    definition.resolveAuthorityClass = (input) =>
      input.mode === 'forecast' ? 'read' : authorityClass
  }

  if (authorityClass === 'read' || entry.name === 'workspace_update_online_factor') {
    definition.executeRead = async (input): Promise<OsToolHandlerResult> => {
      const step = plannerStepFromToolCall(entry.name, input.toolCall.toolCallId, input.input)
      if (!step) {
        return {
          content: { error: `No xox planner step mapping exists for tool ${entry.name}.` },
          outcome: 'failed_terminal',
        }
      }
      const graph = await storeSingleToolStep(ctx, state, step)
      const xoxObservation = graph.observations.at(-1) ?? toolSupervisorFailureObservation(step)
      const osObservation = state.observationBridge.toCanonical(xoxObservation, state.xoxObservations.length)
      const result: OsToolHandlerResult = { content: osObservation.content }
      if (osObservation.outcome !== undefined) result.outcome = osObservation.outcome
      return result
    }
  }

  return definition
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

function replaceActionRow(state: XoxHostState, action: Row<'agent_action_requests'>): void {
  const index = state.actionRows.findIndex((row) => row.id === action.id)
  if (index >= 0) state.actionRows[index] = action
  else state.actionRows.push(action)
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

function providerTool(tool: OsRuntimeToolDescriptor): OpenAiCompatibleFunctionToolDescriptor {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputJsonSchema,
    },
  }
}

function runtimeMaxTokens(input: OsRuntimeTurnInput) {
  return input.userMessage.length >= 600 || input.tools.length >= 20 ? 6000 : 1600
}

function providerReplayObservation(observation: AgentToolObservation) {
  return {
    toolName: observation.toolName,
    toolCallId: observation.toolCallId,
    toolArguments: observation.toolArguments,
    modelContent: observation.modelContent,
    lane: observation.lane === 'runner_evidence' || observation.lane === 'runner_obligation'
      ? observation.lane
      : 'provider_tool' as const,
  }
}

function runtimeUserContent(input: OsRuntimeTurnInput): string {
  const facts = contextWithoutRuntimeConversationLog(input.context.facts ?? {})
  return `上下文：${JSON.stringify(facts)}\n用户指令：${input.userMessage}`
}

function runtimeErrorMessage(error: OpenAICompatibleRuntimeTurnError | string | undefined): string {
  if (!error) return 'Provider runtime failed.'
  if (typeof error === 'string') return redactSecretLikeContent(error)
  if (error.kind === 'missing_api_key') return 'Provider API key is missing.'
  const parts = [
    error.kind,
    error.statusCode !== undefined ? `HTTP ${error.statusCode}` : null,
    error.classification,
    error.message,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0)
  return redactSecretLikeContent(parts.join(': ') || 'Provider runtime failed.')
}

async function persistRuntimeFailure(input: {
  ctx: XoxAgentRunContext
  state: XoxHostState
  error: OpenAICompatibleRuntimeTurnError
}) {
  const graph = await storePlannedActionGraph(input.ctx, {
    plannerSource: input.state.plannerSource,
    emitPlanReady: false,
    items: [{
      title: 'Provider 调用失败',
      message: runtimeErrorMessage(input.error),
      readKind: 'status',
      status: 'failed',
    }],
  })
  applyStoredGraph(input.state, graph)
}

function agentServerStreamEvent(
  event: OpenAICompatibleRuntimeTurnEvent,
  source: AgentPlannerSource,
): AgentServerRuntimeStreamEvent {
  if (event.kind === 'stream_started') {
    return {
      ...event,
      source,
    }
  }
  if (event.kind === 'stream_completed') {
    return {
      ...event,
      source,
    }
  }
  return event
}

function agentToolCall(call: NormalizedProviderToolCall, index: number): OsToolCall {
  return {
    toolCallId: call.providerToolCallId ?? `provider_tool_${index + 1}`,
    name: call.toolName,
    input: call.arguments,
  }
}

async function runOpenAICompatibleTurn(
  ctx: XoxAgentRunContext,
  state: XoxHostState,
  input: OsRuntimeTurnInput,
): Promise<OsRuntimeTurnOutput> {
  const provider = ctx.settings.openaiCompatibleProvider || ctx.settings.llmProvider
  const model = ctx.settings.openaiCompatibleModel
  const { profile, capability, thinkingLevel } = resolveProviderRuntimeProfile({
    provider,
    model,
  })
  const xoxObservations = state.observationBridge.combine(state.xoxObservations, input.observations)
  const messages = buildProviderToolObservationTurnMessages({
    profile,
    capability,
    thinkingLevel,
    systemPrompt: PLANNING_POLICY_PROMPT,
    priorMessages: runtimeMessagesFromConversationLog(runtimeConversationLogFromContext(input.context.facts ?? {})),
    userContent: runtimeUserContent(input),
    observations: xoxObservations.map(providerReplayObservation),
    suffix: 'planning_observation',
    maxObservations: 12,
    maxUserContentChars: PLANNING_USER_CONTENT_MAX_CHARS,
    redact: redactSecretLikeContent,
  })
  const result = await runOpenAICompatibleRuntimeTurn({
    provider,
    model,
    baseUrl: ctx.settings.openaiCompatibleBaseUrl,
    apiKey: ctx.settings.openaiCompatibleApiKey,
    userContent: input.userMessage,
    tools: input.tools.map(providerTool),
    messages,
    stream: true,
    maxTokens: runtimeMaxTokens(input),
    requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal as AbortSignal } : {}),
    onEvent: (event) => addRuntimeStreamRunEvent(ctx, agentServerStreamEvent(event, state.plannerSource)),
  })
  if (result.error) {
    await persistRuntimeFailure({ ctx, state, error: result.error })
    return { error: runtimeErrorMessage(result.error) }
  }
  const output: OsRuntimeTurnOutput = {}
  if (result.assistantText !== undefined) output.assistantText = result.assistantText
  if (result.toolCalls.length > 0) {
    output.toolCalls = result.toolCalls.map(agentToolCall)
  }
  return output
}

function openAIAgentsModel(settings: PlannerContext['settings']) {
  return settings.openaiModel || settings.openaiCompatibleModel
}

function openAIAgentsApiKey(settings: PlannerContext['settings']) {
  return settings.openaiApiKey ?? settings.openaiCompatibleApiKey ?? undefined
}

function openAIAgentsBaseUrl(settings: PlannerContext['settings']) {
  return settings.openaiBaseUrl || settings.openaiCompatibleBaseUrl
}

async function recordOpenAIAgentsEvent(ctx: XoxAgentRunContext, event: OpenAIAgentsRuntimeEvent) {
  if (event.kind === 'run_started') {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'provider_stream_started',
      title: 'OpenAI Agents runtime 已启动',
      message: `正在通过 openai-agents-js runtime 调用 ${event.model}。`,
      status: 'running',
      data: { ...event, source: 'openai_agents' },
    })
    return
  }
  if (event.kind === 'tool_call') {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'provider_stream_delta',
      title: '工具调用已捕获',
      message: `${event.toolName}: ${event.argumentsPreview}`,
      status: 'running',
      channel: 'tool',
      data: { ...event, source: 'openai_agents' },
    })
    return
  }
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'provider_stream_completed',
    title: 'OpenAI Agents runtime 已完成',
    message: `模型运行结束，工具调用 ${event.toolCallCount} 个。`,
    status: 'completed',
    data: { ...event, source: 'openai_agents' },
  })
}

async function runOpenAIAgentsRuntimeTurn(
  ctx: XoxAgentRunContext,
  input: OsRuntimeTurnInput,
): Promise<OsRuntimeTurnOutput> {
  const options = {
    model: openAIAgentsModel(ctx.settings),
    baseURL: openAIAgentsBaseUrl(ctx.settings),
    instructions: PLANNING_POLICY_PROMPT,
    includeFinalOutputWithToolCalls: false,
    onEvent: (event: OpenAIAgentsRuntimeEvent) => recordOpenAIAgentsEvent(ctx, event),
  }
  const apiKey = openAIAgentsApiKey(ctx.settings)
  const result = await runOpenAIAgentsTurn({
    userMessage: input.userMessage,
    tools: input.tools,
    context: {
      facts: input.context.facts,
      observations: input.observations,
    },
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  }, apiKey === undefined ? options : { ...options, apiKey })
  return result
}

function createXoxHostProfile(
  ctx: XoxAgentRunContext,
  options: { beforeStateWrite: () => Promise<boolean> },
  state: XoxHostState,
): AgentHostAdapter {
  const store: AgentStorePort = {
    createRun: async () => {
      const run = await ctx.db.selectFrom('agent_runs').selectAll().where('id', '=', ctx.runId).executeTakeFirst()
      return osRunRecord(ctx, run ?? null)
    },
    claimRunLane: async ({ run }) => ({
      leaseId: `${run.runId}:xox-worker-lease`,
      runId: run.runId,
      threadId: run.threadId,
    }),
    refreshRunLease: async (lease): Promise<OsRunLeaseCheck> => {
      const active = await options.beforeStateWrite()
      return active ? { status: 'active', lease } : { status: 'lost', reason: 'xox run lease is no longer active.' }
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
          title: `Agentic OS 循环 ${iteration ?? ''}`.trim(),
          message: iteration === 1 ? 'Agentic OS 开始第一轮模型运行。' : 'Agentic OS 基于 observation 继续推进。',
          status: 'running',
          data: { iteration, harness: 'agentic-os' },
        })
      }
      if (event.type.startsWith('action.')) {
        await addAgenticOsActionRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          event,
        })
      }
      if (event.type === 'tool.observed') {
        const payload = event.payload as Record<string, unknown>
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown_tool'
        const outcome = typeof payload.outcome === 'string' ? payload.outcome : null
        const failed = outcome === 'failed_repairable' ||
          outcome === 'failed_terminal' ||
          outcome === 'completed_invalid' ||
          outcome === 'policy_blocked'
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: failed ? 'tool_call_failed' : 'tool_call_completed',
          title: failed ? '工具调用失败' : '工具调用完成',
          message: `工具调用${failed ? '失败' : '完成'}：${toolName}`,
          status: failed ? 'failed' : 'completed',
          channel: 'tool',
          data: { ...payload, harness: 'agentic-os' },
        })
      }
      if (event.type === 'tool.guardrail') {
        const payload = event.payload as Record<string, unknown>
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'tool_loop_guardrail',
          title: '工具循环保护已触发',
          message: typeof payload.message === 'string' ? payload.message : 'Agentic OS 已阻断不安全或不可继续的工具循环。',
          status: 'failed',
          data: { ...payload, harness: 'agentic-os' },
        })
      }
    },
    finishRun: async (result) => {
      state.finishedResult = result
    },
  }

  const runtime: OsRuntimeAdapter = {
    runTurn: async (input) => {
      state.plannerSource = plannerSource(ctx.settings)
      await addRunEvent(ctx.db, agentServerRunLifecycleEvents.modelPlanning({
        threadId: ctx.thread.id,
        runId: ctx.runId,
        provider: ctx.settings.llmProvider,
        iteration: input.iteration,
        copy: {
          title: '模型运行中',
          message: 'Agentic OS 正在通过 runtime port 调用配置的模型。',
        },
      }))
      return state.plannerSource === 'openai_agents'
        ? runOpenAIAgentsRuntimeTurn(ctx, input)
        : runOpenAICompatibleTurn(ctx, state, input)
    },
  }

  const context: AgentContextPort = {
    assemble: async (input): Promise<OsAgentContext> => {
      const facts = await buildXoxHostContextFacts(ctx, input.request.userMessage)
      return {
        messages: [{ role: 'user', content: input.request.userMessage }],
        facts: compactJsonObject({
          ...facts,
          xoxRunId: ctx.runId,
          xoxObservationCount: input.observations.length,
        }),
      }
    },
  }

  const tools: AgentToolRegistryPort = {
    listTools: async () => AGENT_TOOL_REGISTRY.map((entry) => agenticOsToolDefinition(ctx, state, entry)),
  }

  const actions: AgentActionPort = {
    previewAction: async (input) => {
      const step = plannerStepFromToolCall(input.tool.name, input.toolCall.toolCallId, input.input)
      if (!step) throw new Error(`No xox planner step mapping exists for tool ${input.tool.name}.`)
      const graph = await storeSingleToolStep(ctx, state, step, {
        forceManualApproval: true,
        emitPlanReady: false,
      })
      const action = graph.actionRows.at(-1)
      if (!action) throw new Error(`Tool ${input.tool.name} did not create an xox action request.`)
      return osActionRequest(action, input.toolCall.toolCallId)
    },
    executeAction: async (input: OsActionExecutionInput): Promise<OsActionExecutionResult> => {
      const action = await ctx.db
        .selectFrom('agent_action_requests')
        .selectAll()
        .where('id', '=', input.actionRequest.actionRequestId)
        .executeTakeFirstOrThrow()
      let result: unknown
      try {
        result = await executeAgentActionRequest(ctx.db, ctx.settings, ctx.user, action)
      } catch (executionError) {
        if (input.reason === undefined) {
          throw executionError
        }
        const message = safeAgentActionErrorMessage(executionError)
        await ctx.db.updateTable('agent_action_requests')
          .set({ status: 'failed', executed_at: null, error_message: message })
          .where('id', '=', action.id)
          .execute()
          .catch(() => undefined)
        await ctx.db.updateTable('agent_plan_steps')
          .set({ status: 'failed', updated_at: utcNow() })
          .where('action_request_id', '=', action.id)
          .execute()
          .catch(() => undefined)
        const failed = await ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
        state.lastActionExecutionResult = null
        replaceActionRow(state, failed)
        const xoxObservation = actionFailureObservation({
          action: failed,
          reason: input.reason ?? 'Action execution failed.',
          error: message,
        })
        state.xoxObservations.push(xoxObservation)
        const observation = state.observationBridge.toCanonical(xoxObservation, state.xoxObservations.length - 1)
        return {
          actionRequest: osActionRequest(failed, input.actionRequest.toolCallId),
          observation,
          audit: osAudit({
            runId: failed.run_id,
            threadId: failed.thread_id,
            actionRequestId: failed.id,
            toolCallId: input.actionRequest.toolCallId,
            toolName: failed.kind,
            actorId: ctx.user.id,
            outcome: 'failed',
            reason: message,
          }),
        }
      }
      const updated = await ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
      state.lastActionExecutionResult = result
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
      actionRequest: { ...input.actionRequest, status: 'edited', preview: input.preview },
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
      actionRequest: { ...input.actionRequest, status: 'rejected' },
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
      const step = plannerStepFromToolCall(input.tool.name, input.toolCall.toolCallId, input.input)
      if (!step) {
        return {
          content: { error: `No xox planner step mapping exists for sandbox tool ${input.tool.name}.` },
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
    reviewFinal: async () => ({ pass: true }),
  }

  return { store, runtime, context, tools, actions, sandbox, completion }
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

async function finalizeAgenticOsResult(
  ctx: XoxAgentRunContext,
  state: XoxHostState,
  result: OsRunResult,
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgenticOsKernelRunResult | null> {
  let assistantMessage: Row<'agent_messages'> | null = null
  if (result.status === 'completed') {
    if (!(await options.beforeStateWrite())) return null
    assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', result.assistantText)
  } else if (result.status === 'awaiting_clarification') {
    if (!(await options.beforeStateWrite())) return null
    assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', result.question)
  }

  const { actionRows, planRows } = await latestRunRows(ctx)
  if (!(await options.beforeStateWrite())) return null
  return {
    agenticOsResult: result,
    plannerSource: state.plannerSource,
    assistantMessage,
    navigationEvents: state.navigationEvents,
    actionRows,
    planRows,
    goalStatus: null,
  }
}

export async function resumeXoxAgentRunAfterActionConfirmation(input: {
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
  const [thread, run] = await Promise.all([
    input.db.selectFrom('agent_threads').selectAll().where('id', '=', input.action.thread_id).executeTakeFirstOrThrow(),
    input.db.selectFrom('agent_runs').selectAll().where('id', '=', input.action.run_id).executeTakeFirstOrThrow(),
  ])
  const objective = run.input_message?.trim() || input.action.title
  const planningCtx: XoxAgentRunContext = {
    db: input.db,
    settings: input.settings,
    user: input.user,
    workspace: input.workspace,
    threadId: thread.id,
    runId: run.id,
    message: objective,
    automationLevel: normalizeAgentAutomationLevel(run.automation_level),
    thread,
  }
  if (input.abortSignal) planningCtx.abortSignal = input.abortSignal

  const { actionRows, planRows } = await latestRunRows(planningCtx)
  const state = createXoxHostState({
    plannerSource: plannerSource(input.settings),
    actionRows,
    planRows,
  })
  const host = createXoxHostProfile(planningCtx, { beforeStateWrite }, state)
  const server = createAgentServer(host, {
    kitOptions: {
      engineOptions: {
        defaultMaxIterations: 5,
        pendingActionCollection: { enabledByDefault: true, maxActions: 8 },
      },
    },
  })
  const request = osRunInput(planningCtx, objective)
  const osRun: OsRunRecord = { ...osRunRecord(planningCtx, run), status: 'awaiting_confirmation' }
  const execution = await server.confirmAction({
    run: osRun,
    actionRequest: osActionRequest(input.action, `action_${input.action.id}`),
    actorId: input.user.id,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  })
  if (state.actionRows.some((row) => row.status === 'pending')) {
    const actionRequest = await input.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
    return {
      actionRequest,
      actionResult: state.lastActionExecutionResult,
      runResult: null,
    }
  }
  const result = await server.resumeRun({
    run: osRun,
    request,
    observations: [execution.observation],
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
  }, {
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  })
  const runResult = await finalizeAgenticOsResult(planningCtx, state, result, { beforeStateWrite })
  const actionRequest = await input.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
  return {
    actionRequest,
    actionResult: state.lastActionExecutionResult,
    runResult,
  }
}

export async function executeXoxAgentRun(
  ctx: XoxAgentRunContext,
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgenticOsKernelRunResult | null> {
  const providedWorkspaceBundle = ctx.providedWorkspaceBundle ?? extractWorkspaceBundleArtifact(ctx.message) ?? undefined
  const objective = providedWorkspaceBundle?.messageForModel ?? ctx.message
  const planningCtx: XoxAgentRunContext = {
    ...ctx,
    message: objective,
    ...(providedWorkspaceBundle ? { providedWorkspaceBundle } : {}),
  }
  const state = createXoxHostState({
    plannerSource: plannerSource(ctx.settings),
  })
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'agentic_os_run_started',
    title: 'Agentic OS 已接管',
    message: '本轮由 Agentic OS harness loop 执行，xox 仅提供工具、上下文和产品投影。',
    status: 'running',
    data: { harness: 'agentic-os' },
  })
  const run = await ctx.db.selectFrom('agent_runs').selectAll().where('id', '=', ctx.runId).executeTakeFirst()
  const request = osRunInput(planningCtx, objective)
  const host = createXoxHostProfile(planningCtx, options, state)
  const server = createAgentServer(host, {
    kitOptions: {
      engineOptions: {
        defaultMaxIterations: 5,
        pendingActionCollection: { enabledByDefault: true, maxActions: 8 },
      },
    },
  })
  const result = await server.resumeRun({
    run: osRunRecord(ctx, run ?? null),
    request,
    observations: [],
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
  }, {
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })
  return finalizeAgenticOsResult(planningCtx, state, result, options)
}
