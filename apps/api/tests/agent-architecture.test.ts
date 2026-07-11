import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(testDir, '..')
const repoRoot = resolve(apiRoot, '..', '..')
const srcRoot = join(apiRoot, 'src')

function source(path: string) {
  return readFileSync(join(srcRoot, path), 'utf8')
}

function sourceFilesUnder(path: string) {
  const root = join(srcRoot, path)
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(relative(srcRoot, fullPath).replaceAll('\\', '/'))
      }
    }
  }
  walk(root)
  return files
}

function expectAbsent(paths: string[]) {
  for (const path of paths) {
    expect(existsSync(join(srcRoot, path)), `${path} must stay deleted`).toBe(false)
  }
}

function expectNoSourceReferences(patterns: string[]) {
  for (const file of sourceFilesUnder('agent')) {
    const content = source(file)
    for (const pattern of patterns) {
      expect(content, `${file} must not reference ${pattern}`).not.toContain(pattern)
    }
  }
}

describe('Agentic OS downstream boundary', () => {
  it('keeps xox as host wiring instead of a local harness agent', () => {
    expectAbsent([
      'agent/host-profile/xox-agent-run-profile.ts',
      'agent/host-profile/xox-provider-runtime.ts',
      'agent/host-profile/xox-final-review-policy.ts',
      'agent/host-profile/xox-goal-facts.ts',
      'agent/host-profile/xox-context-pack.ts',
      'agent/tool-surface-manifest.ts',
      'agent/agentic-os/xox-goal-store-adapter.ts',
      'agent/agent-kernel.ts',
      'agent/run-worker.ts',
      'agent/thread-store.ts',
      'agent/run-events.ts',
      'agent/run-lease.ts',
      'agent/thread-state-stream.ts',
      'agent/loop-obligations.ts',
      'agent/loop-obligation-ledger.ts',
      'agent/obligation-materializer.ts',
      'agent/response-evaluator.ts',
      'agent/approval-executor.ts',
      'agent/direct-answer-runtime.ts',
      'agent/final-answer-claim-extractor.ts',
      'agent/runtime/openai-compatible-chat-adapter.ts',
      'agent/runtime/openai-agents-adapter.ts',
      'agent/runtime/runtime-adapter.ts',
      'agent/agentic-os/xox-agentic-os-host-kit.ts',
      'agent/agentic-os/xox-final-review-adapter.ts',
      'agent/agentic-os/xox-runtime-adapter.ts',
      'agent/agentic-os/xox-runtime-planning-adapter.ts',
      'agent/agentic-os/xox-tool-observation-adapter.ts',
      'agent/agentic-os/xox-action-approval-adapter.ts',
      'agent/agentic-os/xox-run-worker-adapter.ts',
      'agent/xox-tool-result-config.ts',
    ])

    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'xox-host-profile.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'xox-runtime-items.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'prompts', 'xox-agent-turn-policy.md'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'tool-catalog.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'tool-executor.ts'))).toBe(true)
  })

  it('routes durable run storage and action confirmation through Agentic OS host APIs only', () => {
    const runStore = source('agent/agentic-os/xox-run-store-adapter.ts')
    const routes = source('agent/routes.ts')

    expect(runStore).toContain("from '../host-profile/xox-host-profile.js'")
    expect(runStore).toContain('executeXoxAgentRun')
    expect(runStore).toContain('createAgentServerSaaSDurableRunHostProfileRegistry')
    expect(routes).toContain("from './host-profile/xox-host-profile.js'")
    expect(routes).toContain('resumeXoxAgentRunAfterActionConfirmation')
    expect(routes).toContain('applyAgentServerSaaSActionCancellation')
    expect(routes).toContain('applyAgentServerSaaSActionUpdate')
    expect(routes).toContain('applyAgentServerSaaSActionExecutionFailure')
    expect(routes).not.toContain('projectAgentServerActionCancellation')
    expect(routes).not.toContain('projectAgentServerActionUpdate')
    expect(routes).not.toContain('projectAgentServerActionExecutionFailure')
    expect(routes).not.toContain('agentServerRunLifecycleEvents.actionCancelled')
    expect(routes).not.toContain('agentServerRunLifecycleEvents.actionUpdated')

    for (const content of [runStore, routes]) {
      expect(content).not.toContain('xox-agent-run-profile')
      expect(content).not.toContain('xox-provider-runtime')
      expect(content).not.toContain('evaluateAgentGoal')
      expect(content).not.toContain('buildEvidenceLedger')
      expect(content).not.toContain('runAgentServerFinalResponseReviewCycle')
      expect(content).not.toContain('planWithRuntimeAdapter')
      expect(content).not.toContain('callRuntimePlanner')
    }
  })

  it('keeps xox-host-profile as ports and DTO projection, not a harness loop owner', () => {
    const host = source('agent/host-profile/xox-host-profile.ts')

    expect(host).toContain('createOpenAIRuntimePlane')
    expect(host).toContain('createAgentServer')
    expect(host).toContain('createXoxHarnessControlPlane')
    expect(host).toContain('storeProfile')
    expect(host).toContain('AgentHookPlanePorts')
    expect(host).not.toContain('AgentHookRunner')
    expect(host).not.toContain('AgentRunEngine')
    expect(host).not.toContain('runBeforeAgentRun')
    expect(host).not.toContain('runBeforeToolCall')
    expect(host).not.toContain('AgentStorePort')
    expect(host).not.toContain('claimRunLane')
    expect(host).not.toContain('refreshRunLease')
    expect(host).not.toContain('releaseRunLane')
    expect(host).not.toContain('createAgentServerSaaSHostComputer')
    expect(host).not.toContain('createOpenAISaaSHostRuntimeAdapter')
    expect(host).not.toContain('createOpenAISaaSHostComputer<')
    expect(host).not.toContain('selectAdapter:')
    expect(host).not.toContain('selectRuntimeAdapter')
    expect(host).toContain('server.confirmAction')
    expect(host).toContain('server.resumeRun')
    expect(host).toContain('createAgentServerSaaSHostExecutionPorts')
    expect(host).not.toContain('createAgentServerSaaSRuntimeEventHandlers')
    expect(host).not.toContain('createOpenAISaaSRuntimeAdapter')
    expect(host).not.toContain('createOpenAICompatiblePlanningRuntimeAdapter')
    expect(host).not.toContain('createOpenAIAgentsRuntimeAdapter')
    expect(host).not.toContain('createAgentServerSaaSRunPlane')
    expect(host).not.toContain('createAgentServerSaaSHostAdapter')
    expect(host).not.toContain('confirmAgentServerActionAndResume')
    expect(host).not.toContain('resumeAgentServerRun')
    expect(host).toContain('storePlannedActionGraph')
    expect(host).not.toContain('executeAgentActionRequest')

    for (const forbidden of [
      'createAgentHostLoopCoordinator',
      'evaluateAgentGoal',
      'createGoalContract',
      'buildEvidenceLedger',
      'evaluateAssistantResponse',
      'responseEvaluationSummary',
      'xoxEvidenceFailureEvaluation',
      'buildEvidenceRequirements',
      'runAgentServerFinalResponseReviewCycle',
      'runAgentServerFinalAnswerClaimExtraction',
      'planObligationMaterialization',
      'planWithRuntimeAdapter',
      'callRuntimePlanner',
      'runMemoryDreamingSweep',
      'flushThreadContextToMemoryIfNeeded',
      'consolidateExecutedActionMemory',
      'executeXoxDirectAnswerLane',
      'objectiveImpliesForecastOnly',
      'objectiveRequiresActionWrite',
      'shouldCollectPendingActionsBeforePause',
      'ENTITY_SUMMARY_TOOL_ARGUMENTS',
      'readableObservationText',
      'createAgentHostKit',
      'createAgentActiveMemoryRecallRuntime',
      'buildAgentContextPack',
      'buildToolContextPack',
      'tool_discover',
      'HIGH_VOLUME_RUNTIME_TOOL_NAMES',
      'buildProviderRuntimeStableToolPatch',
      'provider_stable_long_tool_mode',
      'workspace_configure_operating_model',
      'runOpenAICompatiblePlanningRuntimeTurn',
      'runOpenAIAgentsTurn',
      'runOpenAICompatibleRuntimeTurn',
      'runOpenAICompatibleRuntimePlanningRecovery',
      'buildProviderToolObservationTurnMessages',
      'resolveProviderRuntimeProfile',
      'runtimeMaxTokens',
      'runtimeErrorMessage',
      'runtimeRetryTool',
      'providerReplayObservation',
      'agentToolCall(',
      'createAgentHostAdapterFromProfile',
      'createXoxRuntimeAdapter',
      'recordOpenAIAgentsEvent',
      'appendOpenAIAgentsRuntimeEvent',
      'appendEvent: async (event: OsRunEvent)',
      'createAgentServerActiveMemoryContextSource',
      'createAgentServerFinalReviewCompletionPort',
      'buildPlannedItemFromRuntimeStep',
      'createXoxObservationBridge',
      'toolResultPort',
      'hostToolResults',
      'createAgentServerHostToolResultPort',
      'createAgentServerRuntimeSwitchAdapter',
      'createAgentServerSaaSRuntimePort',
      'runAgenticSandboxToolLoop',
      'projectAgenticSandboxObservationRead',
      'function xoxRuntimePort',
      'const actions: AgentActionPort',
      'const sandbox: AgentSandboxPort',
      'AgentActionPort',
      'AgentSandboxPort',
      'AgentToolRegistryPort',
      'projectAgentServerRuntimePlanningRecoveryRunEvent',
      'projectAgentServerModelPlanningRunEvent',
      'sourceAgentServerRuntimeStreamEvent',
      'openAICompatibleRuntimeInputFirstToolName',
      'parseToolObservationModelFacts',
      'sandboxExecutionModeFromFacts',
      'sandboxExecutionStatusFromFacts',
    ]) {
      expect(host, `${forbidden} must not return to xox host wiring`).not.toContain(forbidden)
    }
  })

  it('does not keep local memory lifecycle orchestration in xox agent code', () => {
    expectNoSourceReferences([
      'memoryCandidatesFromExecutedActions',
      'memoryCandidateFromEditedAction',
      'memoryCandidateFromCancelledAction',
      'memoryCandidateFromEvaluatorFinding',
      'memoryCandidateFromCompletedGoal',
      'storeMemoryCandidates',
      'consolidateAgentMemoryCandidates',
      'consolidateExecutedActionMemory',
      'compactThreadContextIfNeeded',
      'flushThreadContextToMemoryIfNeeded',
      'recordMemoryRecallSignals',
      'listPromotionCandidatesFromSignals',
      'runMemoryDreamingSweep',
      'OpenClaw-style memory dreaming sweep',
      'openclaw_pre_compaction_flush',
      'active_memory_consolidator',
    ])
  })

  it('does not leave deleted harness file references in production agent code', () => {
    expectNoSourceReferences([
      'xox-agent-run-profile',
      'xox-provider-runtime',
      'xox-final-review-policy',
      'xox-goal-facts',
      'xox-context-pack',
      'tool-surface-manifest',
      'runtime-planning-call',
      'xox-runtime-planning-adapter',
      'xox-tool-observation-adapter',
      'xox-action-approval-adapter',
      'xox-run-worker-adapter',
      'xox-tool-result-config',
      'createXoxToolObservationBridge',
      'runXoxBusinessToolStep',
      'xoxEmptyToolResultRead',
      'xoxToolResultRuntime',
      'agenticOsObservationFromXox',
      'xoxObservationFromAgenticOs',
      'runSandboxCode',
      'planSandboxRunCode',
      'rememberAgentMemory',
      'createAgentHostToolResultRuntime',
      'createAgentServerHostToolResultPort',
      'createAgentServerSaaSHostToolResultPort',
      'createAgentServerTenantMemoryToolHandlers',
      'createAgentMemoryToolRuntime',
      'createSandboxToolRuntimeBridge',
      'createAgenticSandboxHostToolPeripheral',
      'planSandboxAggregateToolActions',
      'executeXoxSandboxTool',
      'projectAgentServerAgUiEvents',
      'projectAgentServerRunSubmissionView',
      'runAgenticSandboxToolExecution',
      'AgentLoopObligationPlan',
      'loopObligationPlan',
      'RuntimePlanResult',
      'RuntimePlanError',
      'classifyToolObservationOutcome',
      'buildToolSupervisorEmptyResultFailureObservation',
      'final_answer_extract_claims',
      'readRuntimeGoalFacts',
      'goalFactsFromRunEvent',
      'createAgentActiveMemoryRecallRuntime',
      'buildToolContextPack',
      'tool_discover',
      "name: 'rg'",
      'buildXoxProjectionViews',
      'timelineItemFromTranscriptItem',
      'transcriptNodeFromTimelineItem',
      'transcriptKindFromOs',
      'sandboxToolRuntimeHandler',
      'aggregateSandboxActions',
      'runMemorySearchTool',
      'runMemoryGetTool',
      'rankAgentMemoryRecords',
      'lexicalRelevance',
      'applyMmr',
      'buildMemoryCitation',
      'materializerItemFromPlannedItem',
      'observationFromRead',
      'readPlannedItem',
      'clarificationTitle',
      'accountForbiddenTitle',
      'emptyResultTitle',
      'emptyResultMessage',
      'readStatus:',
      'resultRuntime:',
      'serializableNestedAction',
      'nestedActions: actions.map',
      'details: actions.map',
      'runXoxSubmittedRun',
      'startXoxReadyRuns',
      'requestXoxRunQueueDrain',
      'startXoxRunQueue',
    ])
  })

  it('keeps provider mechanics and run-plane primitives sourced from Agentic OS packages', () => {
    const host = source('agent/host-profile/xox-host-profile.ts')
    const runEvents = source('agent/agentic-os/xox-run-event-store-adapter.ts')
    const runStore = source('agent/agentic-os/xox-run-store-adapter.ts')
    const runLease = source('agent/agentic-os/xox-run-lease-store-adapter.ts')
    const threadStore = source('agent/agentic-os/xox-thread-store-adapter.ts')

    expect(host).toContain("@agentic-os/core")
    expect(host).toContain("@agentic-os/server")
    expect(host).not.toContain("@agentic-os/runtime-openai-compatible")
    expect(host).toContain("@agentic-os/integration-openai")
    expect(host).not.toContain("@agentic-os/runtime-openai-agents")
    expect(host).toContain('createOpenAIRuntimePlane')
    expect(host).toContain('createAgentServer')
    expect(host).toContain('createXoxHarnessControlPlane')
    expect(host).toContain('storeProfile')
    expect(host).not.toContain('AgentStorePort')
    expect(host).not.toContain('claimRunLane')
    expect(host).not.toContain('refreshRunLease')
    expect(host).not.toContain('releaseRunLane')
    expect(host).not.toContain('createAgentServerSaaSHostComputer')
    expect(host).not.toContain('createOpenAISaaSHostRuntimeAdapter')
    expect(host).toContain('createAgentServerSaaSHostExecutionPorts')
    expect(host).not.toContain('createAgentServerSaaSRuntimeEventHandlers')
    expect(host).not.toContain('createOpenAISaaSRuntimeAdapter')
    expect(host).toContain('.run(')
    expect(host).not.toContain('createAgentHostAdapterFromProfile')
    expect(runEvents).toContain('@agentic-os/server')
    expect(runEvents).toContain('addAgentServerRuntimeStreamRunEvent')
    expect(runStore).toContain('@agentic-os/server')
    expect(runStore).toContain('createAgentServerSaaSDurableRunHostProfileRegistry')
    expect(runStore).not.toContain('createAgentServerSaaSDurableRunHostRegistry')
    expect(runStore).not.toContain('AgentServerDurableRunQueueStore')
    expect(runStore).not.toContain('claimPendingRuns')
    expect(runStore).not.toContain('claimRecoverableRuns')
    expect(runStore).not.toContain('markRunStarted')
    expect(runStore).not.toContain('markRunCompleted')
    expect(runStore).not.toContain('markRunFailed')
    expect(runStore).not.toContain('failClosedRecovery')
    expect(runStore).not.toContain('createAgentServerDurableRunCoordinatorRegistry')
    expect(runStore).not.toContain('createAgentServerDurableRunWorker')
    expect(runStore).not.toContain('createAgentServerRunWorker')
    expect(runStore).not.toContain('createDurableRunQueuePort')
    expect(runStore).not.toContain('runXoxSubmittedRun')
    expect(runStore).not.toContain('startXoxReadyRuns')
    expect(runStore).not.toContain('requestXoxRunQueueDrain')
    expect(runStore).not.toContain('startXoxRunQueue')
    expect(runStore).not.toContain('completeAgentRun')
    expect(runStore).not.toContain('recoverRunningAgentRuns')
    expect(runStore).not.toContain('scheduleAgentRunQueueDrain')
    expect(runStore).not.toContain('getAgentRunWorker')
    expect(runStore).toContain('applyAgentServerSaaSRunInterruption')
    expect(runStore).not.toContain('projectAgentServerInterruptedRunCompletion')
    expect(runStore).not.toContain('applyAgentServerRunInterruptionProjection')
    expect(runStore).not.toContain('projectAgentServerSaaSRunRecoveryFailClosed')
    expect(runStore).not.toContain('projectAgentServerSaaSQueuedRunCompletion')
    expect(runStore).not.toContain('projectAgentServerRunRecoveryFailClosedInterruption')
    expect(runStore).not.toContain('projectAgentServerQueuedRunCompletion')
    expect(runStore).not.toContain('projectAgentServerRunFailureCompletion')
    expect(runStore).not.toContain('projectAgentServerRunCancellationCompletion')
    expect(runStore).not.toContain('hasAgentServerSaaSRunDurableOutput')
    expect(runStore).not.toContain('hasAgentServerRunPartialOutput')
    expect(runStore).not.toContain('agentServerRunRecoveryFailClosedMessage')
    expect(runStore).not.toContain('projectAgentServerRunCompletion')
    expect(runStore).not.toContain('failInterruptedAgentRun')
    expect(runStore).not.toContain('createAgentServerRunScheduler')
    expect(runStore).not.toContain('agent_goals')
    expect(runStore).not.toContain('goal_status')
    expect(runLease).toContain('@agentic-os/server')
    expect(threadStore).toContain('@agentic-os/server')
    expect(threadStore).toContain('AgentServerThreadStateProjector')
    expect(threadStore).toContain('projectAgentServerLegacyTranscriptViews')
    expect(threadStore).not.toContain('buildXoxProjectionViews')
    expect(threadStore).not.toContain('timelineItemFromTranscriptItem')
    expect(threadStore).not.toContain('transcriptNodeFromTimelineItem')
    expect(threadStore).not.toContain('agent_goals')
    expect(threadStore).not.toContain('agent_evaluations')
    expect(threadStore).not.toContain('normalizeGoalStatus')
    expect(threadStore).not.toContain('serializeEvaluation')
  })

  it('keeps action graph adapter free of concrete tool-name runtime policy', () => {
    const actionGraph = source('agent/agentic-os/xox-action-graph-adapter.ts')

    expect(actionGraph).toContain('projectAgentServerHostPlannedItems')
    for (const forbidden of [
      'workspace_configure_operating_model',
      'redundantWorkspaceRename',
      'removeRedundantWorkspaceRename',
      'materializerItemFromPlannedItem',
      'observationFromRead',
      'readPlannedItem',
    ]) {
      expect(actionGraph, `${forbidden} must not return to action graph adapter`).not.toContain(forbidden)
    }
  })

  it('keeps memory and sandbox runtime mechanics out of xox host files', () => {
    const memory = source('agent/memory.ts')
    const sandbox = source('agent/sandbox-service.ts')
    const toolExecutor = source('agent/tool-executor.ts')

    expect(toolExecutor).toContain('createAgentServerSaaSTenantMemoryToolRuntime')
    expect(toolExecutor).toContain('createAgentServerSaaSBusinessToolRuntime')
    expect(toolExecutor).not.toContain('agentServerSaaSTenantMemoryToolHandlers')
    expect(toolExecutor).not.toContain('planAgentServerSaaSBusinessToolStep')
    expect(toolExecutor).not.toContain('createAgentServerSaaSTenantMemoryToolHandlers')
    expect(toolExecutor).not.toContain('createAgentServerSaaSBusinessToolPlanner')
    expect(toolExecutor).not.toContain('createAgentServerTenantMemoryToolHandlers')
    expect(toolExecutor).not.toContain('createAgentServerSaaSHostToolResultPort')
    expect(toolExecutor).not.toContain('createAgentServerHostToolResultPort')
    expect(toolExecutor).not.toContain('createAgentServerMemoryToolHandlers')
    expect(toolExecutor).not.toContain('rememberFromToolCall')
    expect(toolExecutor).not.toContain('clarificationTitle')
    expect(toolExecutor).not.toContain('accountForbiddenTitle')
    expect(toolExecutor).not.toContain('emptyResultTitle')
    expect(toolExecutor).not.toContain('readStatus:')
    expect(toolExecutor).not.toContain('resultRuntime:')
    expect(toolExecutor).toContain('planWorkspaceDataQueryRead')
    expect(toolExecutor).not.toContain('answerWorkspaceDataQuestion')
    expect(memory).toContain('createAgentServerSaaSTenantMemoryRepository')
    expect(memory).not.toContain('createAgentServerTenantMemoryCaptureRuntime')
    expect(memory).not.toContain('createAgentMemoryCaptureRuntime')
    expect(memory).not.toContain('rankAgentServerTenantMemoryRecords')
    expect(memory).not.toContain('projectAgentServerTenantMemorySearch')
    expect(memory).not.toContain('projectAgentServerTenantMemoryGet')
    expect(memory).not.toContain('createXoxActiveMemoryProfileInput')
    expect(memory).not.toContain('summarizeAgentMemoryToolItems')
    expect(memory).not.toContain('runMemorySearchTool')
    expect(memory).not.toContain('runMemoryGetTool')
    expect(memory).not.toContain('rankAgentMemoryRecords')
    expect(memory).not.toContain('lexicalRelevance')
    expect(memory).not.toContain('applyMmr')
    expect(memory).not.toContain('buildMemoryCitation')

    for (const forbidden of [
      'AgentRuntimeContext',
      'loadAgentRuntimeContext',
      'markAgentMemoriesRecalled',
      'touchAgentMemories',
      'storeDailyMemoryNote',
      'createAgentActiveMemoryRecallRuntime',
      'memory_recall_started',
      'memory_injected',
    ]) {
      expect(memory, `${forbidden} must not return to xox memory peripheral`).not.toContain(forbidden)
    }

    expect(sandbox).toContain('createAgenticSandboxSaaSPeripheral')
    expect(sandbox).not.toContain('runAgenticSandboxSaaSPeripheralRead')
    expect(sandbox).not.toContain('runAgenticSandboxPeripheralRead')
    expect(sandbox).not.toContain('createAgenticSandboxSaaSHostToolPeripheral')
    expect(sandbox).not.toContain('createAgenticSandboxAggregateActionDraft')
    expect(sandbox).not.toContain('createAgenticSandboxHostToolPeripheral')
    expect(sandbox).not.toContain('function serializableNestedAction')
    expect(sandbox).not.toContain('nestedActions: actions.map')
    expect(sandbox).not.toContain('details: actions.map')
    expect(sandbox).not.toContain('clarificationTitle')
    expect(sandbox).not.toContain('accountForbiddenTitle')
    expect(sandbox).not.toContain('emptyResultTitle')
    expect(sandbox).not.toContain('readStatus:')
    expect(sandbox).not.toContain('resultRuntime:')
    expect(sandbox).not.toContain('runAgenticSandboxToolLoop')
    expect(sandbox).not.toContain('runAgenticSandboxToolExecution')
    expect(sandbox).not.toContain('createSandboxToolRuntimeBridge')
    expect(sandbox).not.toContain('planSandboxAggregateToolActions')
    expect(sandbox).not.toContain('projectAgenticSandboxObservationRead')
    expect(sandbox).not.toContain('projectSandboxStructuredToolCalls')
    expect(sandbox).not.toContain('sandboxObservationEvidenceProof')
    expect(sandbox).not.toContain('sandboxObservationHasModelReadableOutput')
    expect(sandbox).not.toContain('sandboxObservationStatus')
    expect(sandbox).not.toContain('collectSandboxStructuredToolCalls')
    expect(sandbox).not.toContain('function sandboxToolCalls')
    expect(sandbox).not.toContain('function sandboxToolCallsFrom')
    expect(sandbox).not.toContain('function buildSandboxEvidenceProof')
    expect(sandbox).not.toContain('function sandboxOutputHash')
    expect(sandbox).not.toContain('function hasModelReadableSandboxOutput')
    expect(sandbox).not.toContain('function sandboxObservationStatus')
    expect(sandbox).not.toContain('sandboxToolRuntimeHandler')
    expect(sandbox).not.toContain('aggregateSandboxActions')
    expect(sandbox).not.toContain('SandboxBroker')
  })

  it('does not advertise sandbox as a business-tool gateway to the model', () => {
    const planningPolicy = source('agent/host-profile/prompts/xox-agent-turn-policy.md')
    const toolCatalog = source('agent/tool-catalog.ts')
    const modelVisibleContract = `${planningPolicy}\n${toolCatalog}`

    expect(modelVisibleContract).toContain('顶层业务工具提供用户可见的事实 observation')
    expect(modelVisibleContract).toContain('agentic_os_sandbox.load_structured()')
    expect(modelVisibleContract).toContain('agentic_os_sandbox.emit({...})')
    expect(modelVisibleContract).toContain('先在 sandbox 外调用顶层业务工具')

    for (const forbidden of [
      'xox_sandbox',
      'xox_sandbox.data_query_workspace',
      '通过同名工具 SDK 请求受控业务工具',
      '同名、同参、同返回契约',
      '读写都必须通过 `xox_sandbox.<tool_name>(...)`',
      '不是业务数据的首选模型接口',
      '/input/bundle.json',
      '/output/result.json',
      'XOX_SANDBOX_OUTPUT_DIR',
    ]) {
      expect(modelVisibleContract, `${forbidden} must not return to model-visible sandbox guidance`).not.toContain(forbidden)
    }
  })

  it('keeps xox-owned surface to tools, prompts, context, sandbox bundle, projection, and transport', () => {
    expect(existsSync(join(srcRoot, 'agent', 'tool-catalog.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'tool-executor.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'sandbox-service.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-thread-store-adapter.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-run-submission-adapter.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'routes.ts'))).toBe(true)

    const promptsDir = join(srcRoot, 'agent', 'host-profile', 'prompts')
    expect(readdirSync(promptsDir).filter((name) => name.endsWith('.md')).sort()).toEqual([
      'xox-agent-turn-policy.md',
      'xox-direct-answer-policy.md',
      'xox-turn-lane-policy.md',
    ])
  })

  it('removes host provider runtime tests instead of testing a deleted local runner', () => {
    expect(existsSync(join(testDir, 'provider-runtime.test.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'agentic-os-adapter.test.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'tool-context-engine.test.ts'))).toBe(false)

    const apiPackage = readFileSync(join(apiRoot, 'package.json'), 'utf8')
    const packageLock = readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')
    expect(apiPackage).toContain('@agentic-os/integration-openai')
    expect(apiPackage).toContain('@agentic-os/runtime-openai-compatible')
    expect(apiPackage).toContain('@agentic-os/runtime-openai-agents')
    expect(packageLock).not.toContain('@xox/agent-memory-core')
  })
})
