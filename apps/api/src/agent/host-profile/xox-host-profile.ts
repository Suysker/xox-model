import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  AgentContext as OsAgentContext,
  AgentObservation as OsObservation,
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
  type HostObservationBridge,
} from '@agentic-os/core'
import {
  agentServerRuntimeUserContent,
  createAgentServerSaaSToolDefinition,
  confirmAgentServerSaaSProfileActionAndResume,
  projectAgentServerSaaSRunEventDrafts,
  runAgentServerSaaSProfileRun,
  type AgentServerSaaSHostProfile,
  type AgentServerSaaSHostStoreProfile,
} from '@agentic-os/server'
import {
  createOpenAISaaSHostComputerFromProfile,
} from '@agentic-os/integration-openai'
import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import { hydrateModelConfig } from '@xox/domain'
import { parseJson } from '../../db/database.js'
import type { Row } from '../../db/schema.js'
import { utcNow } from '../../core/time.js'
import { listPeriods, listSubjectsForPeriod } from '../../modules/ledger.js'
import { getWorkspaceDraft, listVersions } from '../../modules/workspace.js'
import {
  executeXoxConfirmedBusinessActionForOs,
  planXoxBusinessToolStep,
  xoxOsActionAudit,
  xoxOsActionRequest,
} from '../tool-executor.js'
import {
  type AgentToolObservation,
  type PlannerContext,
  type ReadDraft,
  type RuntimePlannerStep,
} from './xox-planned-items.js'
import {
  storePlannedActionGraph,
  type StoredActionGraph,
} from '../agentic-os/xox-action-graph-adapter.js'
import {
  addAgenticOsActionRunEvent,
  addRunEvent,
} from '../agentic-os/xox-run-event-store-adapter.js'
import { addMessage } from '../agentic-os/xox-thread-store-adapter.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCallStep,
  type ChatTool,
} from '../tool-catalog.js'
import { buildAgentWritableConfigContext } from '../tool-catalog.js'
import {
  redactSecretLikeContent,
} from '../memory.js'
import { extractWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'

export type AgenticOsKernelRunResult = {
  agenticOsResult: OsRunResult
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
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
  observationBridge: HostObservationBridge<AgentToolObservation>
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

function applyStoredGraph(state: XoxHostState, graph: StoredActionGraph): void {
  state.plannerSource = graph.plannerSource ?? state.plannerSource
  state.navigationEvents.push(...graph.navigationEvents)
  state.actionRows.push(...graph.actionRows)
  state.planRows.push(...graph.planRows)
  state.xoxObservations.push(...graph.observations)
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
  const items = await planXoxBusinessToolStep(ctx, step)
  const graph = await storePlannedActionGraph(
    options.forceManualApproval ? { ...ctx, automationLevel: 'manual' } : ctx,
    {
      items,
      plannerSource: state.plannerSource,
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
      finalReviewed: ({ payload, passed }) => ({
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
  options: { beforeStateWrite: () => Promise<boolean> },
  state: XoxHostState,
): AgentServerSaaSHostProfile {
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
    appendEvent: (event) => appendXoxAgenticOsRunEvent(ctx, event),
    finishRun: async (result) => {
      state.finishedResult = result
    },
  } satisfies AgentServerSaaSHostStoreProfile

  const provider = ctx.settings.openaiCompatibleProvider || ctx.settings.llmProvider
  const model = ctx.settings.openaiCompatibleModel
  const runtimeEvents = {
    source: () => state.plannerSource,
    provider: () => provider,
    appendRunEvent: async (draft: Parameters<typeof addRunEvent>[1]) => {
      await addRunEvent(ctx.db, draft)
    },
    copy: {
      modelPlanning: {
        title: '模型规划中',
        message: 'Agentic OS 正在调用模型规划下一步。',
      },
    },
  }
  return createOpenAISaaSHostComputerFromProfile<
    (typeof AGENT_TOOL_REGISTRY)[number],
    AgentToolCallStep,
    Row<'agent_action_requests'>,
    AgentToolObservation,
    {
      id: string
      key: string
      value: string
      kind: string
      lane: string
      status: string
    }
  >({
    storeProfile,
    runtimeProfile: {
      provider,
      model,
      baseUrl: ctx.settings.openaiCompatibleBaseUrl,
      apiKey: ctx.settings.openaiCompatibleApiKey,
      systemPrompt: PLANNING_POLICY_PROMPT,
      userContent: agentServerRuntimeUserContent,
      observations: (input) => state.observationBridge.combine(state.xoxObservations, input.observations),
      toReplayObservation: (observation) => ({
        toolName: observation.toolName,
        toolCallId: observation.toolCallId,
        toolArguments: observation.toolArguments,
        modelContent: observation.modelContent,
        lane: observation.lane === 'runner_evidence' || observation.lane === 'runner_obligation'
          ? observation.lane
          : 'provider_tool',
      }),
      replaySuffix: 'planning_observation',
      maxObservations: 12,
      maxUserContentChars: PLANNING_USER_CONTENT_MAX_CHARS,
      redact: redactSecretLikeContent,
      stream: true,
      requestTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
      runtimeEvents,
      openAIAgents: {
        model: () => ctx.settings.openaiModel || ctx.settings.openaiCompatibleModel,
        apiKey: () => ctx.settings.openaiApiKey ?? ctx.settings.openaiCompatibleApiKey ?? undefined,
        baseURL: () => ctx.settings.openaiBaseUrl || ctx.settings.openaiCompatibleBaseUrl,
        instructions: PLANNING_POLICY_PROMPT,
        includeFinalOutputWithToolCalls: false,
        copy: {
          run_started: {
            title: 'OpenAI Agents runtime 已启动',
          },
          tool_call: {
            title: '工具调用已捕获',
          },
          run_completed: {
            title: 'OpenAI Agents runtime 已完成',
          },
        },
        onRunEventDraft: async (draft) => {
          await addRunEvent(ctx.db, {
            threadId: ctx.thread.id,
            runId: ctx.runId,
            ...draft,
          })
        },
      },
      selectRuntimeAdapter: () => {
        state.plannerSource = plannerSource(ctx.settings)
        return state.plannerSource === 'openai_agents' ? 'openai_agents' : 'openai_compatible'
      },
    },
    tools: AGENT_TOOL_REGISTRY,
    toolName: (entry) => entry.name,
    createTool: ({ entry, executeRead }) => agenticOsToolDefinition(entry, executeRead),
    shouldExecuteRead: ({ entry, definition }) =>
      definition.authorityClass === 'read' || entry.name === 'workspace_update_online_factor',
    toStep: ({ toolName, toolCallId, input }) => plannerStepFromToolCall(toolName, toolCallId, input),
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
    toActionRequest: ({ action, toolCallId }) => xoxOsActionRequest(action, toolCallId),
    executeAction: (actionInput) => executeXoxConfirmedBusinessActionForOs({
      ctx,
      state,
      actionInput,
    }),
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
    baseContext: async (input): Promise<Partial<OsAgentContext>> => {
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
  })
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
  const request = osRunInput(planningCtx, objective)
  const osRun: OsRunRecord = { ...osRunRecord(planningCtx, run), status: 'awaiting_confirmation' }
  const execution = await confirmAgentServerSaaSProfileActionAndResume({
    profile: createXoxHostProfile(planningCtx, { beforeStateWrite }, state),
    run: osRun,
    request,
    actionRequest: xoxOsActionRequest(input.action, `action_${input.action.id}`),
    actorId: input.user.id,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
    shouldResume: async () => !state.actionRows.some((row) => row.status === 'pending'),
  })
  if (!execution.runResult) {
    const actionRequest = await input.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
    return {
      actionRequest,
      actionResult: state.lastActionExecutionResult,
      runResult: null,
    }
  }
  const runResult = await finalizeAgenticOsResult(planningCtx, state, execution.runResult, { beforeStateWrite })
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
  const result = await runAgentServerSaaSProfileRun({
    profile: createXoxHostProfile(planningCtx, options, state),
    run: osRunRecord(ctx, run ?? null),
    request,
    observations: [],
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
    ...(ctx.abortSignal ? { control: { abortSignal: ctx.abortSignal } } : {}),
  })
  return finalizeAgenticOsResult(planningCtx, state, result, options)
}
