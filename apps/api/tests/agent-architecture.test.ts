import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(testDir, '..')
const srcRoot = join(apiRoot, 'src')

function source(path: string) {
  return readFileSync(join(srcRoot, path), 'utf8')
}

function testSource(path: string) {
  return readFileSync(join(testDir, path), 'utf8')
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

function expectNoImports(path: string, forbidden: RegExp[]) {
  const content = source(path)
  for (const pattern of forbidden) {
    expect(content, `${path} must not match ${pattern}`).not.toMatch(pattern)
  }
}

describe('Agent ADR architecture boundaries', () => {
  it('keeps the Agent API boundary under apps/api/src/agent instead of modules', () => {
    expect(existsSync(join(srcRoot, 'modules', 'agent.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'routes.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'tool-projector.ts'))).toBe(false)
  })

  it('keeps Agentic OS host kit as the single harness run-loop entrypoint', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-agentic-os-host-kit.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'agent-run-engine.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'goal-run-engine.ts'))).toBe(false)
    const kernel = source('agent/agent-kernel.ts')
    expect(kernel).toContain("from './agentic-os/xox-agentic-os-host-kit.js'")
    expect(kernel).not.toContain("from './agent-run-engine.js'")
    expect(kernel).not.toContain('goal-run-engine')
  })

  it('keeps runtime adapters provider-only and free of DB, routes, approvals, and domain execution', () => {
    const runtimeFiles = [
      'agent/runtime/openai-compatible-chat-adapter.ts',
      'agent/runtime/runtime-adapter.ts',
    ]
    const forbidden = [
      /['"]\.\.\/\.\.\/db\//,
      /['"]\.\.\/\.\.\/modules\//,
      /approval-executor/,
      /tool-executor/,
      /action-graph-store/,
      /thread-store/,
    ]
    for (const file of runtimeFiles) expectNoImports(file, forbidden)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-agents-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-failover-policy.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-request-shaper.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-probe.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-repair.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'high-volume-tool-policy.ts'))).toBe(false)
  })

  it('keeps routes as transport glue instead of a planner/runtime/executor owner', () => {
    expectNoImports('agent/routes.ts', [
      /planner/,
      /runtime\//,
      /tool-executor/,
      /tool-gateway/,
      /context-pack/,
      /action-graph-store/,
    ])
  })

  it('keeps the Lean Agent Kernel out of HTTP and provider implementation details', () => {
    expectNoImports('agent/agent-kernel.ts', [
      /fastify/i,
      /['"]\.\.\/modules\//,
      /runtime\//,
      /provider-settings/,
      /tool-executor/,
    ])
  })

  it('keeps turn intake protocol in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'turn-intake-resolver.ts'))).toBe(false)
    const kernel = source('agent/agent-kernel.ts')
    expect(kernel).toContain("from './agentic-os/xox-turn-intake-adapter.js'")
    expect(kernel).not.toContain('planWithRuntimeAdapter')
    expect(kernel).not.toContain("name: 'turn_lane_resolve'")
    const intakeAdapter = source('agent/agentic-os/xox-turn-intake-adapter.ts')
    expect(intakeAdapter).toContain("@agentic-os/core")
    expect(intakeAdapter).toContain('resolveAgentTurnIntake')
    expect(intakeAdapter).toContain('AGENT_TURN_LANE_RESOLUTION_TOOL_SCHEMA')
    expect(intakeAdapter).not.toContain("name: 'turn_lane_resolve'")
    expect(intakeAdapter).not.toContain("enum: ['direct_answer', 'agent_goal']")
    expect(intakeAdapter).not.toContain("reasonCode: 'provider_unavailable'")
  })

  it('keeps direct answer lane state machine in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'direct-answer-runtime.ts'))).toBe(false)
    const kernel = source('agent/agent-kernel.ts')
    expect(kernel).toContain("from './agentic-os/xox-direct-answer-adapter.js'")
    expect(kernel).not.toContain("from './direct-answer-runtime.js'")

    const adapter = source('agent/agentic-os/xox-direct-answer-adapter.ts')
    expect(adapter).toContain("@agentic-os/core")
    expect(adapter).toContain('runDirectAnswerLane')
    expect(adapter).not.toContain('function usableAssistantText')
    expect(adapter).not.toContain('result?.steps.length === 0')
    expect(adapter).not.toContain('if (!assistantText)')
  })

  it('keeps the tool executor independent from provider SDKs and runtime adapters', () => {
    expectNoImports('agent/tool-executor.ts', [
      /@openai\/agents/,
      /openai-compatible/i,
      /runtime\//,
      /tool-gateway/,
      /planner/,
    ])
  })

  it('does not keep obsolete local harness helper boundaries after Agentic OS replacement', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agent-action-runtime.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'context-engine', 'index.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'turn-resolver.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'balanced-json.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-error-classifier.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-capability.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-capability-registry.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-families'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-model-profile.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-model-ref.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-payload-sanitizer.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-transcript-replay.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-tool-schema.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-argument-repair.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-name-normalizer.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-stream-assembler.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-runtime-turn-output.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime-conversation-log.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime-plan-reader.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'adapter-router.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-validator.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-repair.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'high-volume-tool-policy.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-agents-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'direct-answer-runtime.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'tool-runtime', 'approval-policy-composer.ts'))).toBe(false)

    const obsoleteToolContextDir = join(srcRoot, 'agent', 'tool-context-engine')
    expect(existsSync(join(obsoleteToolContextDir, 'index.ts'))).toBe(false)
    if (existsSync(obsoleteToolContextDir)) {
      expect(readdirSync(obsoleteToolContextDir).filter((name) => name.endsWith('.ts'))).toEqual([])
    }
  })

  it('keeps progressive tool surface runtime in Agentic OS core', () => {
    const manifest = source('agent/tool-surface-manifest.ts')
    expect(manifest).toContain("@agentic-os/core")
    expect(manifest).toContain('buildToolSurfacePack')
    expect(manifest).toContain('buildToolSurfaceManifests')
    expect(manifest).not.toContain('function tokenizeToolText')
    expect(manifest).not.toContain('function createToolSearchIndex')
    expect(manifest).not.toContain('function rankTool')
    expect(manifest).not.toContain('function materializeTool')

    const gateway = source('agent/tool-gateway.ts')
    expect(gateway).toContain("from './tool-surface-manifest.js'")
    expect(gateway).not.toContain('tool-context-engine')

    const discovery = source('agent/tool-discovery-tool.ts')
    expect(discovery).toContain("@agentic-os/core")
    expect(discovery).toContain('createToolSearchIndex')
    expect(discovery).not.toContain('tool-context-engine')
  })

  it('deletes the runtime plan reader facade while keeping provider boundary payloads in Agentic OS', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime-plan-reader.ts'))).toBe(false)
    const draftBuilder = source('agent/action-draft-builder.ts')
    const runtimeAdapter = source('agent/runtime/runtime-adapter.ts')
    expect(draftBuilder).toContain('providerToolCallBoundaryObservations')
    expect(draftBuilder).toContain("@agentic-os/runtime-openai-compatible")
    expect(draftBuilder).not.toContain("observationType: 'provider_tool_call_boundary'")
    expect(draftBuilder).not.toContain('"provider_tool_call_boundary"')
    expect(runtimeAdapter).toContain('configuredRuntimePlannerSource')
  })

  it('keeps OpenAI-compatible runtime turn execution in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(adapter).toContain('runOpenAICompatibleRuntimeTurn')
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).not.toContain('requestOpenAICompatibleChatCompletion')
    expect(adapter).not.toContain('shapeOpenAICompatibleChatRequest')
    expect(adapter).not.toContain('parseOpenAICompatibleStreamResponse')
    expect(adapter).not.toContain('normalizeOpenAICompatibleJsonTurnResult')
    expect(adapter).not.toContain('normalizeOpenAICompatibleStreamTurnResult')
    expect(adapter).not.toContain('normalizeProviderToolCallsForExecution')
    expect(adapter).not.toContain('OpenAICompatibleProviderStreamTimeoutError')
    expect(adapter).not.toContain('OpenAICompatibleProviderStreamInterruptedError')
    expect(adapter).not.toContain('OpenAICompatibleChatTransportTimeoutError')
    expect(adapter).not.toContain('response.body?.getReader')
    expect(adapter).not.toContain('ReadableStreamDefaultReader')
    expect(adapter).not.toContain('sseDataFromRecord')
    expect(adapter).not.toContain('readProviderStreamChunk')
    expect(adapter).not.toContain('new ProviderToolCallStreamAssembler')
    expect(adapter).not.toContain('buffer.split(/\\r?\\n\\r?\\n/')
  })

  it('keeps OpenAI-compatible chat transport in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(adapter).toContain('runOpenAICompatibleRuntimeTurn')
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).not.toContain('new AbortController')
    expect(adapter).not.toContain('fetch(')
    expect(adapter).not.toContain('/chat/completions')
    expect(adapter).not.toContain('classifyProviderHttpError')
    expect(adapter).not.toContain('providerRejectsToolChoice')
  })

  it('keeps OpenAI-compatible provider turn normalization in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(adapter).toContain('runOpenAICompatibleRuntimeTurn')
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).not.toContain('function textContentFromMessage')
    expect(adapter).not.toContain('function reasoningTextFromObject')
    expect(adapter).not.toContain('function providerAssistantMessage')
    expect(adapter).not.toContain('function providerArtifact')
    expect(adapter).not.toContain('function validatePromotedPlainTextToolCalls')
    expect(adapter).not.toContain('recoverProviderPlainTextToolCalls')
    expect(adapter).not.toContain('detectProviderPlainTextToolCallArtifact')
  })

  it('keeps runtime result to canonical turn output bridging in Agentic OS core', () => {
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain("@agentic-os/core")
    expect(hostKit).toContain('runtimePlannerResultToTurnOutput')
    expect(hostKit).not.toContain('runtimePlanResultToAgenticOsTurnOutput')
    expect(hostKit).not.toContain('new TurnResolver')
    expect(hostKit).not.toContain('function xoxStepToAgentToolCall')
  })

  it('deletes host-owned tool observation outcome classification', () => {
    expect(existsSync(join(srcRoot, 'agent', 'tool-observation-outcome.ts'))).toBe(false)
    const agentFiles = sourceFilesUnder('agent')
    for (const file of agentFiles) {
      expect(source(file), `${file} must consume @agentic-os/core directly`).not.toContain('tool-observation-outcome')
    }
  })

  it('keeps action observation envelopes in Agentic OS core', () => {
    const continuation = source('agent/tool-observation-continuation.ts')
    expect(continuation).toContain("@agentic-os/core")
    expect(continuation).toContain('buildActionPreviewObservation')
    expect(continuation).toContain('buildActionResultObservation')
    expect(continuation).not.toContain("observationType: 'action_preview'")
    expect(continuation).not.toContain("observationType: 'action_result'")

    const actionGraph = source('agent/action-graph-store.ts')
    expect(actionGraph).toContain('actionFailureObservation')
    expect(actionGraph).not.toContain("observationType: 'action_result'")
  })

  it('keeps action graph materialization in Agentic OS server', () => {
    const actionGraph = source('agent/action-graph-store.ts')
    expect(actionGraph).toContain("@agentic-os/server")
    expect(actionGraph).toContain('materializeAgentServerActionGraph')
    expect(actionGraph).toContain('AgentServerActionGraphStore')
    expect(actionGraph).not.toContain('for (const [index, item] of input.items.entries())')
    expect(actionGraph).not.toContain('const sequenceOffset')
    expect(actionGraph).not.toContain('pendingActionCount = actionRows.filter')
    expect(actionGraph).not.toContain('executedActionCount = actionRows.filter')
    expect(actionGraph).not.toContain('if (pendingActionCount > 0 && input.emitPlanReady')
  })

  it('keeps host observation bridging in Agentic OS core', () => {
    const observationAdapter = source('agent/agentic-os/xox-observation-adapter.ts')
    expect(observationAdapter).toContain("@agentic-os/core")
    expect(observationAdapter).toContain('createHostObservationBridge')
    expect(observationAdapter).toContain('createXoxObservationBridge')

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('createXoxObservationBridge')
    expect(hostKit).not.toContain('osObservationById')
    expect(hostKit).not.toContain('function rememberObservationMapping')
    expect(hostKit).not.toContain('function xoxObservationFromOs')
    expect(hostKit).not.toContain('function combinedXoxObservations')
    expect(hostKit).not.toContain('function mergeXoxObservationsIntoState')

    const actionGraph = source('agent/action-graph-store.ts')
    expect(actionGraph).toContain('createXoxObservationBridge')
    expect(actionGraph).not.toContain('const observationsById = new Map')
    expect(actionGraph).not.toContain('function rememberObservation')
    expect(actionGraph).not.toContain('function fallbackObservationFromOs')
  })

  it('keeps tool observation loop semantics in Agentic OS core', () => {
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('parseToolObservationModelFacts')
    expect(hostKit).toContain('isActionToolObservation')
    expect(hostKit).toContain('isSandboxToolObservation')
    expect(hostKit).not.toContain('JSON.parse(observation.modelContent)')

    expect(existsSync(join(srcRoot, 'agent', 'tool-runtime', 'tool-loop-guardrails.ts'))).toBe(false)
    const runtimeTests = testSource('tool-runtime.test.ts')
    expect(runtimeTests).toContain("@agentic-os/core")
    expect(runtimeTests).toContain('evaluateToolLoopGuardrails')
  })

  it('keeps tool inventory metadata in Agentic OS packages', () => {
    expect(existsSync(join(srcRoot, 'agent', 'tool-runtime', 'effective-tool-inventory.ts'))).toBe(false)
    const gateway = source('agent/tool-gateway.ts')
    expect(gateway).toContain("@agentic-os/runtime-openai-compatible")
    expect(gateway).toContain('buildOpenAICompatibleEffectiveToolInventorySnapshot')
    expect(gateway).not.toContain('inferToolAuthorityClass')
    expect(gateway).not.toContain('providerCompatibilityFlags')
    expect(gateway).not.toContain('resolveProviderModelProfile')
    expect(gateway).not.toContain("tool.capability === 'sandbox'")

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('inferToolAuthorityClass')
    expect(hostKit).not.toContain("input.riskLevel === 'read'")
    expect(hostKit).not.toContain("input.confirmationMode === 'always'")
  })

  it('keeps tool call supervision and runtime event payloads in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'tool-runtime'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'planner.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'planning-session.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'tool-runtime', 'tool-execution-events.ts'))).toBe(false)
  })

  it('keeps the tool observation continuation prompt in Agentic OS core', () => {
    const registry = source('agent/prompt-registry.ts')
    expect(registry).toContain("@agentic-os/core")
    expect(registry).toContain('toolObservationContinuationSystemPrompt')
    expect(registry).not.toContain('tool-observation-finalizer.system.md')
    expect(existsSync(join(srcRoot, 'agent', 'prompts', 'tool-observation-finalizer.system.md'))).toBe(false)
  })

  it('keeps provider observation continuation message assembly in Agentic OS runtime', () => {
    const continuation = source('agent/tool-observation-continuation.ts')
    expect(continuation).toContain("@agentic-os/runtime-openai-compatible")
    expect(continuation).toContain('buildProviderToolObservationContinuationMessages')
    expect(continuation).not.toContain('providerToolObservationReplayMessages')
    expect(continuation).not.toContain("role: 'tool'")
    expect(continuation).not.toContain('tool_calls')
  })

  it('keeps provider observation planning message assembly in Agentic OS runtime', () => {
    const planningCall = source('agent/runtime-planning-call.ts')
    expect(planningCall).toContain("@agentic-os/runtime-openai-compatible")
    expect(planningCall).toContain("@agentic-os/core")
    expect(planningCall).toContain('buildProviderToolObservationTurnMessages')
    expect(planningCall).toContain('runtimeMessagesFromConversationLog')
    expect(planningCall).toContain('contextWithoutRuntimeConversationLog')
    expect(planningCall).not.toContain('providerToolObservationReplayMessages')
    expect(planningCall).not.toContain("role: 'tool'")
    expect(planningCall).not.toContain('tool_calls')
  })

  it('keeps runtime planning recovery orchestration in Agentic OS runtime', () => {
    const planningCall = source('agent/runtime-planning-call.ts')
    expect(planningCall).toContain("@agentic-os/runtime-openai-compatible")
    expect(planningCall).toContain('runOpenAICompatibleRuntimePlanningRecovery')
    expect(planningCall).not.toContain('shouldRetryProviderRuntimeResult')
    expect(planningCall).not.toContain('buildProviderRuntimeRetryPatch')
    expect(planningCall).not.toContain('applyProviderRuntimeRetryPatch')
    expect(planningCall).not.toContain('deferredToolNamesFromBoundary')
    expect(planningCall).not.toContain('missingObservationToolNames')
  })

  it('deletes the provider tool-call repair facade and keeps normalization in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-repair.ts'))).toBe(false)
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).toContain('runOpenAICompatibleRuntimeTurn')
    expect(adapter).toContain('plannerStepsFromProviderToolCalls')
    expect(adapter).toContain('toolCallToPlannerStep')
    expect(adapter).not.toContain('normalizeProviderToolCallsForExecution')
    expect(adapter).not.toContain('extractBalancedJson')
    expect(adapter).not.toContain('parseToolArgumentsWithRepair')
    expect(adapter).not.toContain('argumentBoundaryCode')
    expect(adapter).not.toContain('outside the current effective tool inventory')
    expect(adapter).not.toContain('before the tool schema was materialized')
    expect(adapter).not.toContain('validateProviderToolCallsForExecution')
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-validator.ts'))).toBe(false)
  })

  it('keeps same-thread runtime conversation replay in Agentic OS core', () => {
    const planningCall = source('agent/runtime-planning-call.ts')
    const continuation = source('agent/tool-observation-continuation.ts')
    expect(planningCall).toContain("@agentic-os/core")
    expect(planningCall).toContain('runtimeConversationLogFromContext')
    expect(planningCall).toContain('runtimeMessagesFromConversationLog')
    expect(planningCall).toContain('contextWithoutRuntimeConversationLog')
    expect(continuation).toContain("@agentic-os/core")
    expect(continuation).toContain('runtimeMessagesFromConversationLog')
    expect(existsSync(join(srcRoot, 'agent', 'runtime-conversation-log.ts'))).toBe(false)
  })

  it('keeps runtime adapter routing in Agentic OS core', () => {
    const adapter = source('agent/runtime/runtime-adapter.ts')
    expect(adapter).toContain("@agentic-os/core")
    expect(adapter).toContain('createRuntimePlanRouter')
    expect(adapter).toContain("@agentic-os/runtime-openai-agents")
    expect(adapter).toContain('runOpenAIAgentsTurn')
    expect(adapter).toContain('planWithRuntimeAdapter')
    expect(adapter).not.toContain("from './openai-agents-adapter.js'")
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'adapter-router.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-agents-adapter.ts'))).toBe(false)
  })

  it('keeps provider probing runtime mechanics in Agentic OS runtime', () => {
    const settings = source('agent/provider-settings.ts')
    expect(settings).toContain("@agentic-os/runtime-openai-compatible")
    expect(settings).toContain('probeProviderOpenAICompatibleProvider')
    expect(settings).not.toContain('fetch(')
    expect(settings).not.toContain('AbortController')
    expect(settings).not.toContain('classifyProviderHttpError')
    expect(settings).not.toContain('safeProviderErrorMessage')
    expect(settings).not.toContain('shapeOpenAICompatibleChatRequest')
    expect(settings).not.toContain('response.json')
    expect(settings).not.toContain('choices?.')
  })

  it('routes provider planning through the xox context pack without an obsolete local context wrapper', () => {
    const planningCall = source('agent/runtime-planning-call.ts')
    expect(planningCall).toContain("from './context-pack.js'")
    expect(planningCall).not.toContain("from './context-engine/index.js'")
  })

  it('keeps historical Agent route imports pointed at current boundaries', () => {
    const apiTest = source(relative(srcRoot, join(apiRoot, 'tests', 'api.test.ts')))
    expect(apiTest).toContain("../src/agent/run-worker.js")
    expect(apiTest).not.toContain("../src/modules/agent.js")
  })

  it('keeps memory writes model-selected instead of submission-time regex capture', () => {
    expectNoImports('agent/run-submission.ts', [
      /rememberFromUserMessage/,
    ])
    const memory = source('agent/memory.ts')
    expect(memory).not.toContain('memoryCandidateFromMessage')
    expect(memory).not.toContain('rememberFromUserMessage')
    expect(memory).not.toContain('message.match')
  })

  it('keeps active memory recall as a harness context subsystem, not a business executor', () => {
    const memoryFiles = [
      'agent/active-memory-recall.ts',
      'agent/memory-events.ts',
      'agent/memory-kernel.ts',
      'agent/memory-retriever.ts',
      'agent/memory-safety.ts',
    ]
    const forbidden = [
      /approval-executor/,
      /tool-executor/,
      /workspace-action-drafts/,
      /ledger-action-drafts/,
      /version-action-drafts/,
      /model-structure-action-drafts/,
      /runtime\//,
    ]
    for (const file of memoryFiles) expectNoImports(file, forbidden)
  })
})
