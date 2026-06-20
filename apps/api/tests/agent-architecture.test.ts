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
      'agent/runtime/high-volume-tool-policy.ts',
      'agent/runtime/openai-agents-adapter.ts',
      'agent/runtime/openai-compatible-chat-adapter.ts',
      'agent/runtime/provider-probe.ts',
      'agent/runtime/runtime-adapter.ts',
      'agent/runtime/tool-call-repair.ts',
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
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-failover-policy.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'provider-request-shaper.ts'))).toBe(false)
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
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'adapter-router.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'tool-call-validator.ts'))).toBe(false)
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

  it('keeps provider boundary observation payloads in Agentic OS instead of xox read mapping', () => {
    const reader = source('agent/runtime-plan-reader.ts')
    expect(reader).toContain('providerToolCallBoundaryObservations')
    expect(reader).toContain("@agentic-os/runtime-openai-compatible")
    expect(reader).not.toContain("observationType: 'provider_tool_call_boundary'")
    expect(reader).not.toContain('"provider_tool_call_boundary"')
  })

  it('keeps OpenAI-compatible stream parsing in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(adapter).toContain('parseOpenAICompatibleStreamResponse')
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).not.toContain('response.body?.getReader')
    expect(adapter).not.toContain('ReadableStreamDefaultReader')
    expect(adapter).not.toContain('sseDataFromRecord')
    expect(adapter).not.toContain('readProviderStreamChunk')
    expect(adapter).not.toContain('new ProviderToolCallStreamAssembler')
    expect(adapter).not.toContain('buffer.split(/\\r?\\n\\r?\\n/')
  })

  it('keeps OpenAI-compatible chat transport in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(adapter).toContain('requestOpenAICompatibleChatCompletion')
    expect(adapter).toContain('shapeOpenAICompatibleChatRequest')
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).not.toContain('new AbortController')
    expect(adapter).not.toContain('fetch(')
    expect(adapter).not.toContain('/chat/completions')
    expect(adapter).not.toContain('classifyProviderHttpError')
    expect(adapter).not.toContain('providerRejectsToolChoice')
  })

  it('keeps OpenAI-compatible provider turn normalization in Agentic OS runtime', () => {
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(adapter).toContain('normalizeOpenAICompatibleJsonTurnResult')
    expect(adapter).toContain('normalizeOpenAICompatibleStreamTurnResult')
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
    const planningSession = source('agent/planning-session.ts')
    expect(planningSession).toContain("@agentic-os/core")
    expect(planningSession).toContain('runToolCallSupervisor')
    expect(planningSession).not.toContain('createToolSupervisorCall')
    expect(planningSession).not.toContain('toolSupervisorInventoryByName')
    expect(planningSession).not.toContain('shouldBlockToolCallOutsideInventory')
    expect(planningSession).not.toContain('buildToolSupervisorFailureObservation')
    expect(planningSession).not.toContain('summarizeToolSupervisorObservation')
    expect(planningSession).not.toContain('function safeToolArguments')
    expect(planningSession).not.toContain('function resolvedToolName')
    expect(planningSession).not.toContain('function resultPreview')
    expect(planningSession).not.toContain('for (const [index, step] of input.steps.entries())')
    expect(planningSession).not.toContain("observationType: 'tool_supervisor_failure'")
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

  it('keeps provider tool-call normalization in Agentic OS runtime', () => {
    const repair = source('agent/runtime/tool-call-repair.ts')
    const adapter = source('agent/runtime/openai-compatible-chat-adapter.ts')
    expect(repair).toContain("@agentic-os/runtime-openai-compatible")
    expect(repair).toContain('normalizeProviderToolCallsForExecution')
    expect(repair).not.toContain('extractBalancedJson')
    expect(repair).not.toContain('parseToolArgumentsWithRepair')
    expect(repair).not.toContain('argumentBoundaryCode')
    expect(repair).not.toContain('outside the current effective tool inventory')
    expect(repair).not.toContain('before the tool schema was materialized')
    expect(adapter).toContain('plannerStepsFromProviderToolCalls')
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
    expect(adapter).toContain('planWithRuntimeAdapter')
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'adapter-router.ts'))).toBe(false)
  })

  it('keeps provider probing runtime mechanics in Agentic OS runtime', () => {
    const probe = source('agent/runtime/provider-probe.ts')
    expect(probe).toContain("@agentic-os/runtime-openai-compatible")
    expect(probe).toContain('probeProviderOpenAICompatibleProvider')
    expect(probe).not.toContain('fetch(')
    expect(probe).not.toContain('AbortController')
    expect(probe).not.toContain('classifyProviderHttpError')
    expect(probe).not.toContain('safeProviderErrorMessage')
    expect(probe).not.toContain('shapeOpenAICompatibleChatRequest')
    expect(probe).not.toContain('response.json')
    expect(probe).not.toContain('choices?.')
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
