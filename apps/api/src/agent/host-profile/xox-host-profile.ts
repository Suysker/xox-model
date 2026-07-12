import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  AgentContext as OsAgentContext,
  AgentRunEvent as OsRunEvent,
  AgentRunInput as OsRunInput,
  AgentRunRecord as OsRunRecord,
  AgentRunResult as OsRunResult,
  AgentScope as OsScope,
  AgentToolDefinition as OsToolDefinition,
  JsonObject as OsJsonObject,
} from '@agentic-os/contracts'
import {
  createAgentHostToolObservationBridge,
  normalizeAgentAutomationLevel,
  type AgentHostProfile,
  type AgentHookPlanePorts,
  type HostObservationBridge,
} from '@agentic-os/core'
import {
  createSaaSAgentHost,
  createAgentServerSaaSHostExecutionPorts,
  createAgentServerSaaSHostStorePort,
  createAgentServerSaaSToolDefinition,
  projectAgentServerSaaSRunEventDrafts,
  type AgentServerSaaSHostStoreProfile,
} from '@agentic-os/server'
import { createOpenAIRuntimePlane } from '@agentic-os/integration-openai'
import type { AgentNavigationEvent, AgentRuntimeSource } from '@xox/contracts'
import { hydrateModelConfig } from '@xox/domain'
import { parseJson } from '../../db/database.js'
import type { Row } from '../../db/schema.js'
import { utcNow } from '../../core/time.js'
import { listPeriods, listSubjectsForPeriod } from '../../modules/ledger.js'
import { getWorkspaceDraft, listVersions } from '../../modules/workspace.js'
import {
  executeXoxConfirmedBusinessActionForOs,
  executeXoxBusinessToolStep,
  xoxOsActionAudit,
  xoxOsActionRequest,
} from '../tool-executor.js'
import {
  type AgentToolObservation,
  type AgentTurnContext,
  type ReadDraft,
  type RuntimeToolStep,
} from './xox-runtime-items.js'
import {
  storePlannedActionGraph,
  type StoredActionGraph,
} from '../agentic-os/xox-action-graph-adapter.js'
import {
  addAgenticOsActionRunEvent,
  addRunEvent,
  commitReservedAgenticOsRunEvent,
  reserveAgenticOsRunEvent,
} from '../agentic-os/xox-run-event-store-adapter.js'
import { createXoxHarnessControlInfrastructure } from '../agentic-os/xox-harness-control-store-adapter.js'
import { addMessage } from '../agentic-os/xox-thread-store-adapter.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToRuntimeStep,
  type AgentToolCallStep,
  type ChatTool,
} from '../tool-catalog.js'
import { buildAgentWritableConfigContext } from '../tool-catalog.js'
import {
  redactSecretLikeContent,
} from '../memory.js'
import { executeXoxSandboxForAgenticOs } from '../sandbox-service.js'
import { extractWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'

export type AgenticOsKernelRunResult = {
  agenticOsResult: OsRunResult
  runtimeSource: AgentRuntimeSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
}

type XoxAgentRunContext = AgentTurnContext & {
  thread: Row<'agent_threads'>
}

type XoxHostState = {
  runtimeSource: AgentRuntimeSource
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  xoxObservations: AgentToolObservation[]
  observationBridge: HostObservationBridge<AgentToolObservation>
  finishedResult: OsRunResult | null
  lastActionExecutionResult: unknown | null
}

type XoxAgentHarnessOptions = {
  beforeStateWrite: () => Promise<boolean>
  hooks?: AgentHookPlanePorts
}

const AGENT_TURN_POLICY_PROMPT = readFileSync(
  fileURLToPath(new URL('./prompts/xox-agent-turn-policy.md', import.meta.url)),
  'utf8',
).trim()
const THREAD_LOG_LIMIT = 8
const THREAD_LOG_CONTENT_LIMIT = 800

function createXoxHostState(input: {
  runtimeSource: AgentRuntimeSource
  actionRows?: Row<'agent_action_requests'>[]
  planRows?: Row<'agent_plan_steps'>[]
}): XoxHostState {
  return {
    runtimeSource: input.runtimeSource,
    navigationEvents: [],
    actionRows: input.actionRows ?? [],
    planRows: input.planRows ?? [],
    xoxObservations: [],
    observationBridge: createAgentHostToolObservationBridge<AgentToolObservation>({
      contentKey: 'xoxObservation',
    }),
    finishedResult: null,
    lastActionExecutionResult: null,
  }
}

function compactJsonObject(value: unknown): OsJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
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

function osScope(ctx: AgentTurnContext): OsScope {
  return {
    tenantId: ctx.user.id,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
  }
}

function osRunRecord(ctx: AgentTurnContext, run: Row<'agent_runs'> | null): OsRunRecord {
  return {
    runId: ctx.runId,
    threadId: ctx.threadId,
    scope: osScope(ctx),
    status: 'running',
    createdAt: run?.created_at ?? utcNow(),
  }
}

function osRunInput(ctx: AgentTurnContext, objective: string): OsRunInput {
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

function runtimeSource(settings: AgentTurnContext['settings']): AgentRuntimeSource {
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

function applyStoredGraph(state: XoxHostState, graph: StoredActionGraph): void {
  state.runtimeSource = graph.runtimeSource ?? state.runtimeSource
  state.navigationEvents.push(...graph.navigationEvents)
  state.actionRows.push(...graph.actionRows)
  state.planRows.push(...graph.planRows)
  state.xoxObservations.push(...graph.observations)
}

function toolSchema(tool: ChatTool): OsJsonObject {
  return compactJsonObject(tool.function.parameters)
}

function runtimeStepFromToolCall(
  toolName: string,
  toolCallId: string,
  input: OsJsonObject,
): AgentToolCallStep | null {
  const args = compactJsonObject(input)
  const step = toolCallToRuntimeStep(toolName, args as Record<string, unknown>)
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
  if (!step.providerToolCallId) {
    throw new Error(`Tool step ${step.providerToolName ?? 'unknown'} is missing its canonical tool-call identity.`)
  }
  const items = await executeXoxBusinessToolStep(ctx, step)
  const graph = await storePlannedActionGraph(
    options.forceManualApproval ? { ...ctx, automationLevel: 'manual' } : ctx,
    {
      items,
      runtimeSource: state.runtimeSource,
      toolCallId: step.providerToolCallId,
      ...(options.emitPlanReady !== undefined ? { emitPlanReady: options.emitPlanReady } : {}),
    },
  )
  applyStoredGraph(state, graph)
  return graph
}

function agenticOsToolDefinition(
  entry: (typeof AGENT_TOOL_REGISTRY)[number],
  executeRead?: OsToolDefinition['executeRead'],
): OsToolDefinition {
  return createAgentServerSaaSToolDefinition({
    name: entry.name,
    title: entry.name,
    description: entry.tool.function.description,
    inputJsonSchema: toolSchema(entry.tool),
    capability: entry.capability,
    riskLevel: entry.riskLevel,
    confirmationMode: entry.confirmationMode,
    manualBoundaryNotice: isManualBoundaryNoticeToolName(entry.name),
    harnessManagedObservation: isHarnessManagedObservationToolName(entry.name),
    navigationTarget: entry.navigationTarget,
    validate: (input) => ({ value: compactJsonObject(input) }),
    ...(entry.name === 'workspace_update_online_factor'
      ? {
          resolveAuthorityClassWithDefault: (input, defaultAuthorityClass) =>
            input.mode === 'forecast' ? 'read' : defaultAuthorityClass,
        }
      : {}),
    ...(executeRead !== undefined ? { executeRead } : {}),
  })
}

function xoxObservationIndex(state: XoxHostState, observation: AgentToolObservation): number {
  const index = state.xoxObservations.indexOf(observation)
  return index >= 0 ? index : state.xoxObservations.length
}

async function appendXoxAgenticOsRunEvent(ctx: XoxAgentRunContext, event: OsRunEvent) {
  const scope = osScope(ctx)
  if (event.scope.tenantId !== scope.tenantId || event.scope.workspaceId !== scope.workspaceId ||
      event.scope.userId !== scope.userId) {
    throw new Error('Agentic OS run event scope does not belong to the xox request context.')
  }
  await commitReservedAgenticOsRunEvent(ctx.db, event)
  if (event.type.startsWith('action.')) {
    await addAgenticOsActionRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      event,
    })
    return
  }
  const drafts = projectAgentServerSaaSRunEventDrafts({
    threadId: ctx.thread.id,
    runId: ctx.runId,
    event,
    copy: {
      turnStarted: ({ iteration }) => ({
        title: `Agentic OS 循环 ${iteration ?? ''}`.trim(),
        message: iteration === 1 ? 'Agentic OS 开始第一轮模型运行。' : 'Agentic OS 基于 observation 继续推进。',
      }),
      toolObserved: ({ toolName, failed }) => ({
        title: failed ? '工具调用失败' : '工具调用完成',
        message: `工具调用${failed ? '失败' : '完成'}：${toolName}`,
      }),
      toolGuardrail: ({ payload }) => ({
        title: '工具循环保护已触发',
        message: typeof payload.message === 'string' ? payload.message : 'Agentic OS 已阻断不安全或不可继续的工具循环。',
      }),
      evaluatorReviewed: ({ payload, passed }) => ({
        title: 'Agentic OS final review 已完成',
        message: typeof payload.reason === 'string'
          ? payload.reason
          : passed
            ? '最终回答通过 Agentic OS review。'
            : '最终回答未通过 Agentic OS review。',
      }),
    },
  })
  for (const draft of drafts) {
    await addRunEvent(ctx.db, {
      ...draft,
    })
  }
}

function createXoxHostProfile(
  ctx: XoxAgentRunContext,
  options: XoxAgentHarnessOptions,
  state: XoxHostState,
  infrastructure: ReturnType<typeof createXoxHarnessControlInfrastructure>,
): AgentHostProfile {
  const storeProfile = {
    loadRun: async () => {
      const run = await ctx.db.selectFrom('agent_runs').selectAll().where('id', '=', ctx.runId).executeTakeFirst()
      return osRunRecord(ctx, run ?? null)
    },
    leaseId: ({ run }) => `${run.runId}:xox-worker-lease`,
    checkLease: async ({ lease }) => {
      const active = await options.beforeStateWrite()
      return active ? { status: 'active', lease } : { status: 'lost', reason: 'xox run lease is no longer active.' }
    },
    reserveRunEventSequence: ({ run, type }) => reserveAgenticOsRunEvent(ctx.db, {
      threadId: run.threadId, runId: run.runId, type,
    }),
    appendEvent: (event) => appendXoxAgenticOsRunEvent(ctx, event),
    finishRun: async (result) => {
      state.finishedResult = result
    },
  } satisfies AgentServerSaaSHostStoreProfile

  const useOpenAIAgents = state.runtimeSource === 'openai_agents'
  const provider = useOpenAIAgents
    ? ctx.settings.llmProvider
    : ctx.settings.openaiCompatibleProvider || ctx.settings.llmProvider
  const model = useOpenAIAgents
    ? ctx.settings.openaiModel
    : ctx.settings.openaiCompatibleModel
  const adapterName = useOpenAIAgents ? 'openai_agents' : 'openai_compatible'
  const apiFamily = useOpenAIAgents ? 'openai-responses' : 'openai-chat-completions'
  const runtime = createOpenAIRuntimePlane({
    executionStore: infrastructure.runtimeExecutionStore,
    modelControl: {
      catalog: [{
        schemaVersion: 'agentic-os.model_catalog_entry.v1',
        catalogEntryId: `${provider}:${model}:${apiFamily}`,
        provider,
        model,
        requestModel: model,
        displayName: model,
        apiFamily,
        inputModalities: ['text'],
        outputModalities: ['text'],
        contextWindow: 128_000,
        toolCalling: {
          supported: true,
          parallelToolCalls: false,
          toolChoicePolicy: 'auto',
          schemaProfile: 'generic-json-schema',
        },
        routing: { apiMode: useOpenAIAgents ? 'responses' : 'chat-completions', transport: 'https' },
        availability: 'available',
        source: 'host_override',
        timeouts: { requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs },
      }],
      providerProfiles: [{
        schemaVersion: 'agentic-os.provider_profile.v1',
        providerProfileId: `${provider}:${apiFamily}`,
        provider,
        apiFamily,
        authMode: 'host_managed',
        baseUrlRef: `${provider}:base-url`,
        explicitProviderOnly: true,
        tenantScoped: true,
      }],
      policy: {
        allowedModels: [{ provider, model }],
        unknownContextPolicy: 'require_known',
      },
      selectionByPurpose: Object.fromEntries([
        'agent_turn', 'online_evaluation', 'offline_evaluation', 'context_compaction', 'auxiliary',
      ].map((purpose) => [purpose, { provider, model, adapterName }])),
      maxAttemptsPerProfile: 1,
    },
    compatible: {
      stream: true,
      resolveConnection: () => ({
        baseUrl: ctx.settings.openaiCompatibleBaseUrl,
        apiKey: ctx.settings.openaiCompatibleApiKey,
      }),
    },
    agents: {
      resolveConnection: () => {
        const apiKey = ctx.settings.openaiApiKey ?? ctx.settings.openaiCompatibleApiKey ?? undefined
        return {
          ...(apiKey === undefined ? {} : { apiKey }),
          baseURL: ctx.settings.openaiBaseUrl || ctx.settings.openaiCompatibleBaseUrl,
        }
      },
    },
  })
  const executionPorts = createAgentServerSaaSHostExecutionPorts({
    tools: AGENT_TOOL_REGISTRY,
    toolName: (entry) => entry.name,
    createTool: ({ entry, executeRead }) => agenticOsToolDefinition(entry, executeRead),
    shouldExecuteRead: ({ entry, definition }) =>
      definition.authorityClass === 'read' || entry.name === 'workspace_update_online_factor',
    toStep: ({ toolName, toolCallId, input }) => runtimeStepFromToolCall(toolName, toolCallId, input),
    storeStep: async ({ step, forceManualApproval, emitPlanReady }) => {
      const graph = await storeSingleToolStep(ctx, state, step, {
        ...(forceManualApproval !== undefined ? { forceManualApproval } : {}),
        ...(emitPlanReady !== undefined ? { emitPlanReady } : {}),
      })
      return {
        observations: graph.observations,
        actionRequests: graph.actionRows,
      }
    },
    observationBridge: state.observationBridge,
    observationIndex: ({ observation }) => xoxObservationIndex(state, observation),
    toActionRequest: ({ action }) => xoxOsActionRequest(action),
    executeAction: (actionInput) => executeXoxConfirmedBusinessActionForOs({
      ctx,
      state,
      actionInput,
    }),
    sandboxPort: {
      executeSandbox: (sandboxInput) => executeXoxSandboxForAgenticOs(ctx, sandboxInput),
    },
    createEditAudit: (input) => xoxOsActionAudit({
      runId: input.run.runId,
      threadId: input.run.threadId,
      actionRequestId: input.actionRequest.actionRequestId,
      toolCallId: input.actionRequest.toolCallId,
      toolName: input.actionRequest.toolName,
      actorId: input.actorId,
      outcome: 'edited',
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }),
    createRejectAudit: (input) => xoxOsActionAudit({
      runId: input.run.runId,
      threadId: input.run.threadId,
      actionRequestId: input.actionRequest.actionRequestId,
      toolCallId: input.actionRequest.toolCallId,
      toolName: input.actionRequest.toolName,
      actorId: input.actorId,
      outcome: 'rejected',
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }),
  })
  return {
    store: createAgentServerSaaSHostStorePort(storeProfile),
    runtime,
    control: infrastructure.control,
    tools: executionPorts.tools,
    actions: executionPorts.actions,
    sandbox: executionPorts.sandbox,
    baseContext: async (input): Promise<Partial<OsAgentContext>> => {
      const facts = await buildXoxHostContextFacts(ctx, input.request.userMessage)
      return {
        messages: [
          { role: 'system', content: AGENT_TURN_POLICY_PROMPT },
          { role: 'user', content: input.request.userMessage },
        ],
        facts: compactJsonObject({
          ...facts,
          xoxRunId: ctx.runId,
          xoxObservationCount: input.observations.length,
        }),
      }
    },
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  }
}

function createXoxAgentServer(
  ctx: XoxAgentRunContext,
  options: XoxAgentHarnessOptions,
  state: XoxHostState,
) {
  const infrastructure = createXoxHarnessControlInfrastructure(ctx.db)
  return createSaaSAgentHost(
    createXoxHostProfile(ctx, options, state, infrastructure),
    {
      trace: {
        journal: infrastructure.traceJournal,
        writerOwnerId: `${ctx.runId}:xox-worker`,
        contentPolicyId: 'agentic-os.metadata-only.v1',
        sourceRevisions: { host: 'xox-model.agentic-os.v1' },
      },
    },
  )
}

async function latestRunRows(ctx: AgentTurnContext) {
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
    runtimeSource: state.runtimeSource,
    assistantMessage,
    navigationEvents: state.navigationEvents,
    actionRows,
    planRows,
  }
}

export async function resumeXoxAgentRunAfterActionConfirmation(input: {
  db: AgentTurnContext['db']
  settings: AgentTurnContext['settings']
  user: AgentTurnContext['user']
  workspace: Row<'workspaces'>
  action: Row<'agent_action_requests'>
  abortSignal?: AbortSignal
  beforeStateWrite?: () => Promise<boolean>
  hooks?: AgentHookPlanePorts
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
  const turnCtx: XoxAgentRunContext = {
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
  if (input.abortSignal) turnCtx.abortSignal = input.abortSignal

  const { actionRows, planRows } = await latestRunRows(turnCtx)
  const state = createXoxHostState({
    runtimeSource: runtimeSource(input.settings),
    actionRows,
    planRows,
  })
  const request = osRunInput(turnCtx, objective)
  const osRun: OsRunRecord = { ...osRunRecord(turnCtx, run), status: 'awaiting_confirmation' }
  const server = createXoxAgentServer(turnCtx, {
      beforeStateWrite,
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    }, state)
  const actionExecution = await server.confirmAction({
    run: osRun,
    actionRequest: xoxOsActionRequest(input.action),
    actorId: input.user.id,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
  })
  const resumed = await server.resumeRun({
    run: osRun,
    request,
    observations: [actionExecution.observation],
  }, input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal })
  if (state.actionRows.some((row) => row.status === 'pending')) {
    const actionRequest = await input.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
    return {
      actionRequest,
      actionResult: state.lastActionExecutionResult,
      runResult: null,
    }
  }
  const runResult = await finalizeAgenticOsResult(turnCtx, state, resumed, { beforeStateWrite })
  const actionRequest = await input.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
  return {
    actionRequest,
    actionResult: state.lastActionExecutionResult,
    runResult,
  }
}

export async function executeXoxAgentRun(
  ctx: XoxAgentRunContext,
  options: XoxAgentHarnessOptions,
): Promise<AgenticOsKernelRunResult | null> {
  const providedWorkspaceBundle = ctx.providedWorkspaceBundle ?? extractWorkspaceBundleArtifact(ctx.message) ?? undefined
  const objective = providedWorkspaceBundle?.messageForModel ?? ctx.message
  const turnCtx: XoxAgentRunContext = {
    ...ctx,
    message: objective,
    ...(providedWorkspaceBundle ? { providedWorkspaceBundle } : {}),
  }
  const state = createXoxHostState({
    runtimeSource: runtimeSource(ctx.settings),
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
  const request = osRunInput(turnCtx, objective)
  const result = await createXoxAgentServer(turnCtx, options, state).run(
    request,
    ctx.abortSignal === undefined ? {} : { abortSignal: ctx.abortSignal },
  )
  return finalizeAgenticOsResult(turnCtx, state, result, options)
}
