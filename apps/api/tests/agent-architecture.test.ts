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

  it('keeps M142 lifecycle event drafts in Agentic OS server instead of xox host adapters', () => {
    expect(existsSync(join(srcRoot, 'agent', 'memory-kernel.ts'))).toBe(false)

    const hostLifecycleFiles = [
      'agent/agentic-os/xox-agentic-os-host-kit.ts',
      'agent/agentic-os/xox-action-graph-adapter.ts',
      'agent/agentic-os/xox-runtime-adapter.ts',
      'agent/agentic-os/xox-tool-observation-adapter.ts',
      'agent/memory.ts',
    ]
    const forbiddenDirectTypeLiterals = [
      'goal_contract_created',
      'goal_iteration_started',
      'model_planning',
      'goal_evaluated',
      'final_answer_candidate',
      'goal_iteration_exhausted',
      'runner_obligation_materializing',
      'runner_obligation_materialized',
      'action_auto_executed',
      'action_auto_execution_failed',
      'action_execution_failed',
      'action_executed',
      'action_cancelled',
      'action_updated',
      'provider_stable_long_tool_mode',
      'provider_retrying',
      'model_continuation',
      'model_continuation_completed',
      'model_continuation_failed',
      'memory_candidate_stored',
      'memory_context_flushed',
      'memory_dreaming_reported',
      'direct_answer_provider_failed',
      'response_evaluated',
      'runtime_evidence_required',
      'observation_assistant_continuation_requested',
      'observation_continuation_requested',
    ]

    for (const file of hostLifecycleFiles) {
      const content = source(file)
      expect(content, `${file} should consume Agentic OS lifecycle draft helpers`).toContain('agentServerRunLifecycleEvents')
      for (const type of forbiddenDirectTypeLiterals) {
        expect(content, `${file} must not construct ${type} directly`).not.toContain(`type: '${type}'`)
      }
    }
  })

  it('keeps Agentic OS host kit as the single harness run-loop entrypoint and deletes the host kernel facade', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-agentic-os-host-kit.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'run-worker.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agent-run-engine.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'goal-run-engine.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agent-kernel.ts'))).toBe(false)

    const worker = source('agent/agentic-os/xox-run-worker-adapter.ts')
    expect(worker).toContain("from './xox-agentic-os-host-kit.js'")
    expect(worker).not.toContain("from './xox-direct-answer-adapter.js'")
    expect(worker).not.toContain("from './xox-turn-intake-adapter.js'")
    expect(worker).not.toContain("from './agent-run-engine.js'")
    expect(worker).not.toContain('goal-run-engine')
  })

  it('keeps single-entry agent helper files collapsed into real host boundaries', () => {
    const deletedHelpers = [
      'agent/config-patch.ts',
      'agent/provider-key-codec.ts',
      'agent/tool-coverage.ts',
      'agent/sandbox-file-adapters.ts',
      'agent/memory/daily-notes.ts',
      'agent/memory/dreaming-worker.ts',
      'agent/memory/memory-backend.ts',
      'agent/memory/memory-center.ts',
      'agent/memory/memory-tools.ts',
      'agent/memory/recall-signals.ts',
    ]
    for (const file of deletedHelpers) {
      expect(existsSync(join(srcRoot, file)), `${file} must stay deleted`).toBe(false)
    }

    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      expect(content, `${file} must not import deleted provider key codec`).not.toContain('provider-key-codec')
      expect(content, `${file} must not import deleted config patch helper`).not.toContain('config-patch')
      expect(content, `${file} must not import deleted tool coverage helper`).not.toContain('tool-coverage')
      expect(content, `${file} must not import deleted sandbox file adapter`).not.toContain('sandbox-file-adapters')
      expect(content, `${file} must not import deleted memory helper subdirectory files`).not.toMatch(/memory\/(daily-notes|dreaming-worker|memory-backend|memory-center|memory-tools|recall-signals)/)
    }
  })

  it('keeps host prompt assets in host profile instead of a generic agent prompt framework', () => {
    expect(existsSync(join(srcRoot, 'agent', 'prompts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'prompts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'runtime-goal-facts.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'xox-goal-facts.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'prompts', 'xox-planning-policy.md'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'prompts', 'xox-turn-lane-policy.md'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'prompts', 'xox-direct-answer-policy.md'))).toBe(true)

    const deletedPromptAssets = [
      'planner.system.md',
      'turn-lane.system.md',
      'direct-answer.system.md',
      'memory.system.md',
      'tool-observation-finalizer.system.md',
    ]
    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      for (const prompt of deletedPromptAssets) {
        expect(content, `${file} must not reference the deleted ${prompt} prompt asset`).not.toContain(prompt)
      }
      expect(content, `${file} must not load prompts from the old generic agent prompt directory`).not.toContain('../prompts/')
      expect(content, `${file} must not load prompts from the old generic agent prompt directory`).not.toContain('..\\prompts\\')
      expect(content, `${file} must not import the deleted root runtime goal facts file`).not.toContain('runtime-goal-facts')
    }
  })

  it('deletes misleading root agent data and planning facades', () => {
    expect(existsSync(join(srcRoot, 'agent', 'data-agent.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'planning-context.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime-intent-handlers.ts'))).toBe(false)

    const draftBuilder = source('agent/action-draft-builder.ts')
    expect(draftBuilder).toContain('export type PlannerContext')

    const executor = source('agent/tool-executor.ts')
    expect(executor).toContain('WorkspaceDataQueryStep')
    expect(executor).toContain('answerWorkspaceDataQuestion')
    expect(executor).toContain('WORKSPACE_DATA_QUERY_SCOPE')
    expect(executor).toContain('isWorkspaceDataQueryScope')
    expect(executor).not.toContain('DataAgentQueryStep')
    expect(executor).not.toContain("from './data-agent.js'")
    expect(executor).not.toContain("step.scope === '")
    expect(executor).not.toContain("metricSet.has('")
    expect(executor).not.toContain("metrics.includes('")

    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      expect(content, `${file} must not import the deleted runtime intent handler facade`).not.toContain('runtime-intent-handlers')
    }

    const catalog = source('agent/tool-catalog.ts')
    expect(catalog).toContain('WORKSPACE_DATA_QUERY_SCOPES')
    expect(catalog).toContain('WORKSPACE_DATA_QUERY_METRICS')
    expect(catalog).toContain('enum: [...WORKSPACE_DATA_QUERY_SCOPES]')
    expect(catalog).toContain('enum: [...WORKSPACE_DATA_QUERY_METRICS]')
  })

  it('keeps real-provider smoke outside the production agent runtime tree', () => {
    expect(existsSync(join(srcRoot, 'agent', 'real-provider-smoke.ts'))).toBe(false)
    expect(existsSync(join(apiRoot, 'scripts', 'agent-real-provider-smoke.ts'))).toBe(true)
    const apiPackage = readFileSync(join(apiRoot, 'package.json'), 'utf8')
    expect(apiPackage).toContain('tsx scripts/agent-real-provider-smoke.ts')
  })

  it('keeps runtime adapters provider-only and free of DB, routes, approvals, and domain execution', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'runtime-adapter.ts'))).toBe(false)
    const runtimeFiles = [
      'agent/agentic-os/xox-runtime-adapter.ts',
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
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-compatible-chat-adapter.ts'))).toBe(false)
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

  it('keeps the run worker adapter out of HTTP, provider runtime, and tool execution implementation details', () => {
    expectNoImports('agent/agentic-os/xox-run-worker-adapter.ts', [
      /fastify/i,
      /runtime\//,
      /tool-executor/,
      /tool-gateway/,
      /context-pack/,
      /action-graph-store/,
    ])
  })

  it('keeps turn intake protocol in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'turn-intake-resolver.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-turn-intake-adapter.ts'))).toBe(false)
    const worker = source('agent/agentic-os/xox-run-worker-adapter.ts')
    expect(worker).toContain("@agentic-os/core")
    expect(worker).toContain('resolveAgentTurnIntake')
    expect(worker).toContain('AGENT_TURN_LANE_RESOLUTION_TOOL_SCHEMA')
    expect(worker).not.toContain("from './xox-turn-intake-adapter.js'")
    expect(worker).not.toContain("name: 'turn_lane_resolve'")
    expect(worker).not.toContain("enum: ['direct_answer', 'agent_goal']")
    expect(worker).not.toContain("reasonCode: 'provider_unavailable'")
  })

  it('keeps direct answer lane state machine in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'direct-answer-runtime.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-direct-answer-adapter.ts'))).toBe(false)
    const worker = source('agent/agentic-os/xox-run-worker-adapter.ts')
    expect(worker).toContain("@agentic-os/core")
    expect(worker).toContain('runDirectAnswerLane')
    expect(worker).not.toContain("from './xox-direct-answer-adapter.js'")
    expect(worker).not.toContain("from './direct-answer-runtime.js'")
    expect(worker).not.toContain('function usableAssistantText')
    expect(worker).not.toContain('result?.steps.length === 0')
    expect(worker).not.toContain('if (!assistantText)')
  })

  it('keeps ambient session context facts in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'ambient-context.ts'))).toBe(false)

    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted ambient-context helper`).not.toContain('ambient-context')
    }

    for (const file of [
      'agent/agentic-os/xox-run-worker-adapter.ts',
    ]) {
      const content = source(file)
      expect(content).toContain("@agentic-os/core")
      expect(content).toContain('buildAgentAmbientSessionContext')
      expect(content).toContain('agentAmbientSessionContextFacts')
    }
  })

  it('keeps clarification resume scaffold in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'clarification-resume.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-clarification-resume-adapter.ts'))).toBe(false)
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain("from './xox-goal-store-adapter.js'")
    expect(hostKit).toContain('buildXoxClarificationResumeContext')
    expect(hostKit).not.toContain("from '../clarification-resume.js'")

    const goalStore = source('agent/agentic-os/xox-goal-store-adapter.ts')
    expect(goalStore).toContain("@agentic-os/core")
    expect(goalStore).toContain('buildClarificationResumeScaffold')
    expect(goalStore).not.toContain('const objective = [')
    expect(goalStore).not.toContain(".join('\\n')")
  })

  it('keeps loop readiness status priority in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'loop-readiness-check.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'observation-collector.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-loop-readiness-adapter.ts'))).toBe(false)

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain("from './xox-goal-store-adapter.js'")
    expect(hostKit).toContain('evaluateAgentGoal')
    expect(hostKit).not.toContain("from './xox-loop-readiness-adapter.js'")
    expect(hostKit).not.toContain("from '../loop-readiness-check.js'")
    expect(hostKit).not.toContain("from '../observation-collector.js'")

    expect(existsSync(join(srcRoot, 'agent', 'approval-executor.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-action-approval-adapter.ts'))).toBe(false)

    const goalStore = source('agent/agentic-os/xox-goal-store-adapter.ts')
    expect(goalStore).toContain("@agentic-os/core")
    expect(goalStore).toContain('decideAgentReadiness')
    expect(goalStore).toContain('function collectAgentObservation')
    expect(goalStore).not.toContain('policyFindings.some')
    expect(goalStore).not.toContain("let status:")
    expect(goalStore).not.toContain("status = 'blocked'")
    expect(goalStore).not.toContain("status = 'needs_confirmation'")
  })

  it('keeps action confirmation resume inside Agentic OS instead of the xox approval adapter', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-action-approval-adapter.ts'))).toBe(false)
    const routes = source('agent/routes.ts')
    for (const forbidden of [
      'continueModelAfterToolObservations',
      'actionExecutionObservation',
      'evaluateAssistantResponse',
      'buildEvidenceLedger',
      'evaluateAgentGoal',
      'readRuntimeGoalFacts',
      'loopObligationsFromResponseEvaluation',
      'planLoopObligations',
      'updateGoalStatus',
      'getGoalForRun',
    ]) {
      expect(routes, `routes must not own ${forbidden}`).not.toContain(forbidden)
    }

    const actionGraph = source('agent/agentic-os/xox-action-graph-adapter.ts')
    expect(actionGraph).toContain("from '../tool-executor.js'")
    expect(actionGraph).toContain("from '../action-draft-builder.js'")
    expect(actionGraph).not.toContain("from './xox-action-approval-adapter.js'")
    expect(actionGraph).not.toContain('function confirmAgentActionRequest')

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('createAgentHostKit')
    expect(hostKit).toContain('confirmAction')
    expect(hostKit).toContain('resumeXoxAgenticOsRunAfterActionConfirmation')
  })

  it('keeps initial prerequisite observation selection in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'prerequisite-observations.ts'))).toBe(false)

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain("@agentic-os/core")
    expect(hostKit).toContain('selectAgentPrerequisiteObservations')
    expect(hostKit).toContain('ENTITY_SUMMARY_PREREQUISITE')
    expect(hostKit).not.toContain("from '../prerequisite-observations.js'")
    expect(hostKit).not.toContain('runPrerequisiteObservations')
  })

  it('keeps final review obligation projection merge in Agentic OS core', () => {
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('serializeObligationLedgerForResponseEvent')
    expect(hostKit).not.toContain('function responseEvaluationObligationLedger')
    expect(hostKit).not.toContain('function responseEventObligationLedger')
    expect(hostKit).not.toContain('projection.openCount = projection.obligations.filter')

    expect(existsSync(join(srcRoot, 'agent', 'loop-obligation-ledger.ts'))).toBe(false)
    const adapter = source('agent/agentic-os/xox-final-review-adapter.ts')
    expect(adapter).toContain("@agentic-os/core")
    expect(adapter).toContain('evaluateAgentFinalResponseReview')
    expect(adapter).toContain('projectObligationLedgerWithAdditionalObligations')
    expect(adapter).not.toContain('evaluateAgentFinalResponseGate')
  })

  it('keeps runtime-boundary missing-observation repair projection out of the host kit', () => {
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('runtimeBoundaryMissingObservationRepair')
    expect(hostKit).not.toContain('runtime_boundary_sandbox_calculation')
    expect(hostKit).not.toContain('response.sandbox_evidence_missing')
    expect(hostKit).not.toContain('Provider 已产生 sandbox_run_code 工具意图')

    expect(existsSync(join(srcRoot, 'agent', 'loop-obligation-ledger.ts'))).toBe(false)
    const adapter = source('agent/agentic-os/xox-final-review-adapter.ts')
    expect(adapter).toContain('projectObligationStateWithAdditionalObligations')
  })

  it('deletes the local loop-obligations facade and keeps obligation runtime in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'loop-obligations.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'loop-obligation-ledger.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'response-evaluator.test.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'loop-obligation-ledger.test.ts'))).toBe(false)

    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted loop-obligations facade`).not.toContain('loop-obligations')
    }

    const adapter = source('agent/agentic-os/xox-final-review-adapter.ts')
    expect(adapter).toContain("@agentic-os/core")
    expect(adapter).toContain('ledgerToObligationPlan')
    expect(adapter).toContain('projectObligationLedgerWithAdditionalObligations')
    expect(adapter).toContain('projectObligationStateWithAdditionalObligations')
    expect(adapter).not.toContain('  projectObligationLedger,')
    expect(adapter).not.toContain('projectObligationLedger(ledger')

    for (const deletedExport of [
      'evidenceContainsKey',
      'buildEvidenceRequirements',
      'loopObligationsFromResponseEvaluation',
      'planLoopObligations',
      'activeLedgerObligations',
      'canAttemptFinalAnswer',
      'serializeObligationLedger',
      'osEvidenceRecordsFromXoxEvidence',
      'osEvidenceRequirementFromXoxRequirement',
    ]) {
      expect(adapter, `${deletedExport} must not remain as a xox public harness API`).not.toContain(`export function ${deletedExport}(`)
    }
    expect(adapter).not.toContain('function loopObligationsFromResponseEvaluation')

    expect(existsSync(join(srcRoot, 'agent', 'obligation-materializer.ts'))).toBe(false)
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain("@agentic-os/core")
    expect(hostKit).toContain('planObligationMaterialization')
    expect(hostKit).not.toContain("from '../obligation-materializer.js'")
  })

  it('keeps structured evidence key matching in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'structured-evidence-utils.ts'))).toBe(false)
    for (const file of [
      'agent/evidence-ledger.ts',
      'agent/loop-obligation-ledger.ts',
      'agent/response-evaluator.ts',
    ]) {
      expect(existsSync(join(srcRoot, file))).toBe(false)
    }
    const adapter = source('agent/agentic-os/xox-final-review-adapter.ts')
    expect(adapter).toContain("@agentic-os/core")
    expect(adapter).toContain('evidenceFactsContainKey')
    expect(adapter).not.toContain('structured-evidence-utils')
    expect(adapter).not.toContain('function objectHasKey')
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
    expect(existsSync(join(srcRoot, 'agent', 'agent-kernel.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'prompt-registry.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'real-provider-smoke.ts'))).toBe(false)
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
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'runtime-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-compatible-chat-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-agents-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'direct-answer-runtime.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'ambient-context.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'clarification-resume.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'loop-obligations.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'obligation-materializer.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'approval-executor.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-action-approval-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'run-worker.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'thread-store.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'tool-runtime', 'approval-policy-composer.ts'))).toBe(false)

    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      expect(content, `${file} must not import the deleted approval executor facade`).not.toContain("from './approval-executor.js'")
      expect(content, `${file} must not import the deleted approval executor facade`).not.toContain("from '../approval-executor.js'")
    }

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

    expect(existsSync(join(srcRoot, 'agent', 'tool-gateway.ts'))).toBe(false)
    const catalog = source('agent/tool-catalog.ts')
    expect(catalog).toContain("from './tool-surface-manifest.js'")
    expect(catalog).not.toContain('tool-context-engine')

    expect(existsSync(join(srcRoot, 'agent', 'tool-discovery-tool.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime-intent-handlers.ts'))).toBe(false)
    const handlers = source('agent/tool-executor.ts')
    expect(handlers).toContain("@agentic-os/core")
    expect(handlers).toContain('buildToolSurfaceDiscoveryObservation')
    expect(handlers).toContain('buildToolSurfaceManifestSearchObservation')
    expect(handlers).toContain("from './tool-surface-manifest.js'")
    expect(handlers).not.toContain('createToolSearchIndex')
    expect(handlers).not.toContain('function searchDocument')
    expect(handlers).not.toContain('tool-context-engine')
  })

  it('deletes the runtime plan reader facade while keeping provider boundary payloads in Agentic OS', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime-plan-reader.ts'))).toBe(false)
    const draftBuilder = source('agent/action-draft-builder.ts')
    const runtimeAdapter = source('agent/agentic-os/xox-runtime-adapter.ts')
    expect(draftBuilder).toContain('providerToolCallBoundaryObservations')
    expect(draftBuilder).toContain("@agentic-os/runtime-openai-compatible")
    expect(draftBuilder).not.toContain("observationType: 'provider_tool_call_boundary'")
    expect(draftBuilder).not.toContain('"provider_tool_call_boundary"')
    expect(runtimeAdapter).toContain('configuredRuntimePlannerSource')
  })

  it('keeps OpenAI-compatible runtime turn execution in Agentic OS runtime', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-compatible-chat-adapter.ts'))).toBe(false)
    const adapter = source('agent/agentic-os/xox-runtime-adapter.ts')
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
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-compatible-chat-adapter.ts'))).toBe(false)
    const adapter = source('agent/agentic-os/xox-runtime-adapter.ts')
    expect(adapter).toContain('runOpenAICompatibleRuntimeTurn')
    expect(adapter).toContain("@agentic-os/runtime-openai-compatible")
    expect(adapter).not.toContain('new AbortController')
    expect(adapter).not.toContain('fetch(')
    expect(adapter).not.toContain('/chat/completions')
    expect(adapter).not.toContain('classifyProviderHttpError')
    expect(adapter).not.toContain('providerRejectsToolChoice')
  })

  it('keeps OpenAI-compatible provider turn normalization in Agentic OS runtime', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-compatible-chat-adapter.ts'))).toBe(false)
    const adapter = source('agent/agentic-os/xox-runtime-adapter.ts')
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
    expect(existsSync(join(srcRoot, 'agent', 'tool-observation-continuation.ts'))).toBe(false)
    const continuation = source('agent/agentic-os/xox-tool-observation-adapter.ts')
    expect(continuation).toContain("@agentic-os/core")
    expect(continuation).toContain('buildActionPreviewObservation')
    expect(continuation).toContain('buildActionResultObservation')
    expect(continuation).not.toContain("observationType: 'action_preview'")
    expect(continuation).not.toContain("observationType: 'action_result'")

    const actionGraph = source('agent/agentic-os/xox-action-graph-adapter.ts')
    expect(actionGraph).toContain('actionFailureObservation')
    expect(actionGraph).not.toContain("observationType: 'action_result'")
  })

  it('keeps action graph materialization in Agentic OS server', () => {
    expect(existsSync(join(srcRoot, 'agent', 'action-graph-store.ts'))).toBe(false)
    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      expect(content, `${file} must not import the deleted action graph facade`).not.toContain("from './action-graph-store.js'")
      expect(content, `${file} must not import the deleted action graph facade`).not.toContain("from '../action-graph-store.js'")
    }
    const actionGraph = source('agent/agentic-os/xox-action-graph-adapter.ts')
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
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-observation-adapter.ts'))).toBe(false)
    const toolObservation = source('agent/agentic-os/xox-tool-observation-adapter.ts')
    expect(toolObservation).toContain("@agentic-os/core")
    expect(toolObservation).toContain('createHostObservationBridge')
    expect(toolObservation).toContain('createXoxObservationBridge')

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('createXoxObservationBridge')
    expect(hostKit).not.toContain('osObservationById')
    expect(hostKit).not.toContain('function rememberObservationMapping')
    expect(hostKit).not.toContain('function xoxObservationFromOs')
    expect(hostKit).not.toContain('function combinedXoxObservations')
    expect(hostKit).not.toContain('function mergeXoxObservationsIntoState')

    const actionGraph = source('agent/agentic-os/xox-action-graph-adapter.ts')
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
    expect(existsSync(join(srcRoot, 'agent', 'tool-gateway.ts'))).toBe(false)
    const catalog = source('agent/tool-catalog.ts')
    expect(catalog).toContain("@agentic-os/runtime-openai-compatible")
    expect(catalog).toContain('buildOpenAICompatibleEffectiveToolInventorySnapshot')
    expect(catalog).not.toContain('inferToolAuthorityClass')
    expect(catalog).not.toContain('providerCompatibilityFlags')
    expect(catalog).not.toContain('resolveProviderModelProfile')
    expect(catalog).not.toContain("tool.capability === 'sandbox'")

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

  it('keeps tool supervisor failure envelopes out of the host kit', () => {
    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain('toolSupervisorFailureReadDraft')
    expect(hostKit).toContain('toolSupervisorFailureObservation')
    expect(hostKit).not.toContain('function fallbackToolObservation')
    expect(hostKit).not.toContain("observationType: 'tool_supervisor_failure'")
    expect(hostKit).not.toContain('Tool did not produce a business result.')

    const draftBuilder = source('agent/action-draft-builder.ts')
    expect(draftBuilder).toContain("@agentic-os/core")
    expect(draftBuilder).toContain('buildToolSupervisorEmptyResultFailureObservation')
    expect(draftBuilder).not.toContain('did not produce an action or observation')

    const continuation = source('agent/agentic-os/xox-tool-observation-adapter.ts')
    expect(continuation).toContain("@agentic-os/core")
    expect(continuation).toContain('buildToolSupervisorEmptyResultFailureObservation')
    expect(continuation).not.toContain('did not produce an action or observation')
  })

  it('deletes the prompt registry facade and keeps the tool observation continuation prompt in Agentic OS core', () => {
    expect(existsSync(join(srcRoot, 'agent', 'prompt-registry.ts'))).toBe(false)
    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted prompt registry facade`).not.toContain('prompt-registry')
    }
    const continuation = source('agent/agentic-os/xox-tool-observation-adapter.ts')
    expect(continuation).toContain("@agentic-os/core")
    expect(continuation).toContain('toolObservationContinuationSystemPrompt')
    expect(continuation).not.toContain('tool-observation-finalizer.system.md')
    expect(existsSync(join(srcRoot, 'agent', 'prompts', 'tool-observation-finalizer.system.md'))).toBe(false)
  })

  it('keeps provider observation continuation message assembly in Agentic OS runtime', () => {
    const continuation = source('agent/agentic-os/xox-tool-observation-adapter.ts')
    expect(continuation).toContain("@agentic-os/runtime-openai-compatible")
    expect(continuation).toContain('buildProviderToolObservationContinuationMessages')
    expect(continuation).not.toContain('providerToolObservationReplayMessages')
    expect(continuation).not.toContain("role: 'tool'")
    expect(continuation).not.toContain('tool_calls')
  })

  it('keeps provider observation planning message assembly in Agentic OS runtime', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime-planning-call.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-runtime-planning-adapter.ts'))).toBe(false)
    const planningCall = source('agent/agentic-os/xox-runtime-adapter.ts')
    expect(planningCall).toContain("@agentic-os/runtime-openai-compatible")
    expect(planningCall).toContain("@agentic-os/core")
    expect(planningCall).toContain('buildProviderToolObservationTurnMessages')
    expect(planningCall).toContain('runtimeMessagesFromConversationLog')
    expect(planningCall).toContain('contextWithoutRuntimeConversationLog')
    expect(planningCall).not.toContain('providerToolObservationReplayMessages')
  })

  it('keeps runtime planning recovery orchestration in Agentic OS runtime', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-runtime-planning-adapter.ts'))).toBe(false)
    const planningCall = source('agent/agentic-os/xox-runtime-adapter.ts')
    expect(planningCall).toContain("@agentic-os/runtime-openai-compatible")
    expect(planningCall).toContain('runOpenAICompatibleRuntimePlanningRecovery')
    expect(planningCall).not.toContain('shouldRetryProviderRuntimeResult')
    expect(planningCall).not.toContain('buildProviderRuntimeRetryPatch')
    expect(planningCall).not.toContain('applyProviderRuntimeRetryPatch')
    expect(planningCall).not.toContain('deferredToolNamesFromBoundary')
    expect(planningCall).not.toContain('missingObservationToolNames')
  })

  it('deletes the provider tool-call repair facade and keeps normalization in Agentic OS runtime', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-compatible-chat-adapter.ts'))).toBe(false)
    const adapter = source('agent/agentic-os/xox-runtime-adapter.ts')
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
    const planningCall = source('agent/agentic-os/xox-runtime-adapter.ts')
    const continuation = source('agent/agentic-os/xox-tool-observation-adapter.ts')
    expect(planningCall).toContain("@agentic-os/core")
    expect(planningCall).toContain('runtimeConversationLogFromContext')
    expect(planningCall).toContain('runtimeMessagesFromConversationLog')
    expect(planningCall).toContain('contextWithoutRuntimeConversationLog')
    expect(continuation).toContain("@agentic-os/core")
    expect(continuation).toContain('runtimeMessagesFromConversationLog')
    expect(existsSync(join(srcRoot, 'agent', 'runtime-conversation-log.ts'))).toBe(false)
  })

  it('keeps runtime adapter routing in Agentic OS core', () => {
    const adapter = source('agent/agentic-os/xox-runtime-adapter.ts')
    expect(adapter).toContain("@agentic-os/core")
    expect(adapter).toContain('createRuntimePlanRouter')
    expect(adapter).toContain("@agentic-os/runtime-openai-agents")
    expect(adapter).toContain('runOpenAIAgentsTurn')
    expect(adapter).toContain('planWithRuntimeAdapter')
    expect(adapter).not.toContain("from './openai-agents-adapter.js'")
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'adapter-router.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'runtime-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'runtime', 'openai-agents-adapter.ts'))).toBe(false)
  })

  it('keeps provider runtime stream trace projection in Agentic OS server', () => {
    expect(existsSync(join(srcRoot, 'agent', 'runtime-trace-events.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'run-events.ts'))).toBe(false)

    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted runtime trace wrapper`).not.toContain('runtime-trace-events')
    }

    const runEvents = source('agent/agentic-os/xox-run-event-store-adapter.ts')
    expect(runEvents).toContain("@agentic-os/server")
    expect(runEvents).toContain('addAgentServerRuntimeStreamRunEvent')
    expect(runEvents).toContain('createAgentServerSequencedRunEventAppender')
    expect(runEvents).not.toContain('runtimeStreamEventPayload')
  })

  it('keeps thread signaling, SSE state streams, and run lease helpers outside the root host agent frame', () => {
    const deletedRootFiles = [
      'run-worker.ts',
      'thread-store.ts',
      'thread-events.ts',
      'thread-state-stream.ts',
      'run-lease.ts',
    ]
    for (const file of deletedRootFiles) {
      expect(existsSync(join(srcRoot, 'agent', file)), `${file} should live under the xox Agentic OS adapter boundary`).toBe(false)
    }

    const importPatterns = [
      "from './thread-events.js'",
      "from './thread-state-stream.js'",
      "from './run-lease.js'",
      "from './run-events.js'",
      "from './run-worker.js'",
      "from './thread-store.js'",
      "from '../run-events.js'",
      "from '../run-worker.js'",
      "from '../thread-store.js'",
    ]
    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      for (const pattern of importPatterns) {
        expect(content, `${file} must not import deleted root run-plane adapter ${pattern}`).not.toContain(pattern)
      }
    }

    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-thread-signal-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-thread-state-stream-adapter.ts'))).toBe(false)
    const routes = source('agent/routes.ts')
    const runLease = source('agent/agentic-os/xox-run-lease-store-adapter.ts')
    const runWorker = source('agent/agentic-os/xox-run-worker-adapter.ts')
    const runEvents = source('agent/agentic-os/xox-run-event-store-adapter.ts')
    expect(runEvents).toContain("@agentic-os/server")
    expect(runEvents).toContain('AgentServerSignalBus')
    expect(routes).toContain("@agentic-os/server")
    expect(routes).toContain('openAgentServerSignalStateStream')
    expect(runLease).toContain("@agentic-os/server")
    expect(runLease).toContain('startAgentServerRunLeaseHeartbeat')
    expect(runLease).toContain('assertAgentServerRunLease')
    expect(runWorker).toContain("@agentic-os/server")
    expect(runWorker).toContain('createAgentServerRunScheduler')
    const threadStore = source('agent/agentic-os/xox-thread-store-adapter.ts')
    expect(threadStore).toContain('buildXoxThreadStateView')
    expect(threadStore).toContain('serializeRunEvent')
  })

  it('keeps AG-UI event projection in Agentic OS server', () => {
    expect(existsSync(join(srcRoot, 'agent', 'ag-ui-projection.ts'))).toBe(false)
    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted AG-UI projection wrapper`).not.toContain('ag-ui-projection')
      expect(source(file), `${file} must not rebuild the deleted AG-UI projection wrapper`).not.toContain('buildAgentAgUiEvents')
    }

    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-run-submission-view.ts'))).toBe(false)
    const runView = source('agent/agentic-os/xox-run-submission-adapter.ts')
    const threadView = source('agent/agentic-os/xox-thread-state-view.ts')
    for (const content of [runView, threadView]) {
      expect(content).toContain("@agentic-os/server")
      expect(content).toContain('projectAgentServerAgUiEvents')
      expect(content).toContain("eventNamePrefix: 'xox'")
    }
  })

  it('deletes local transcript and timeline projection engines in favor of Agentic OS projection facts', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-thread-transcript-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-thread-timeline-adapter.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'agent-transcript.test.ts'))).toBe(false)

    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      expect(content, `${file} must not import the deleted transcript projector`).not.toContain('xox-thread-transcript-adapter')
      expect(content, `${file} must not import the deleted timeline projector`).not.toContain('xox-thread-timeline-adapter')
      expect(content, `${file} must not rebuild local transcript item projection`).not.toContain('buildAgentTranscriptItems')
      expect(content, `${file} must not rebuild local timeline projection`).not.toContain('buildAgentTimelineItems')
      expect(content, `${file} must not rebuild local transcript tree projection`).not.toContain('buildAgentTranscriptNodes')
    }

    const threadView = source('agent/agentic-os/xox-thread-state-view.ts')
    expect(threadView).toContain('AgentServerThreadStateProjector')
    expect(threadView).toContain('osTranscriptItems')
    expect(threadView).toContain('buildXoxProjectionViews')
    expect(threadView).not.toContain('toolActionKindAliases')
    expect(threadView).not.toContain('mergeProviderToolCallsIntoActionNodes')
    expect(threadView).not.toContain('groupRunSegment')
  })

  it('keeps final-answer claim extraction runtime in Agentic OS server', () => {
    expect(existsSync(join(srcRoot, 'agent', 'final-answer-claim-extractor.ts'))).toBe(false)
    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted final-answer claim extractor`).not.toContain('final-answer-claim-extractor')
    }

    const hostKit = source('agent/agentic-os/xox-agentic-os-host-kit.ts')
    expect(hostKit).toContain("@agentic-os/server")
    expect(hostKit).toContain('runAgentServerFinalAnswerClaimExtraction')
    expect(hostKit).toContain('XOX_FINAL_ANSWER_CLAIM_SUBJECT_TYPES')
    expect(hostKit).not.toContain('const FINAL_ANSWER_CLAIM_TOOL')
    expect(hostKit).not.toContain('const CLAIM_KINDS')
    expect(hostKit).not.toContain("name: 'final_answer_extract_claims'")
    expect(hostKit).not.toContain('function normalizeClaims')
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

  it('routes provider planning through the xox host-profile context pack without an obsolete local context wrapper', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agentic-os', 'xox-runtime-planning-adapter.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'context-pack.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'xox-context-pack.ts'))).toBe(true)
    const planningCall = source('agent/agentic-os/xox-runtime-adapter.ts')
    expect(planningCall).toContain("from '../host-profile/xox-context-pack.js'")
    expect(planningCall).not.toContain("from './context-engine/index.js'")
    for (const file of sourceFilesUnder('agent')) {
      const content = source(file)
      expect(content, `${file} must not import the deleted root context pack facade`).not.toContain("from './context-pack.js'")
      expect(content, `${file} must not import the deleted root context pack facade`).not.toContain("from '../context-pack.js'")
    }
  })

  it('keeps historical Agent route imports pointed at current boundaries', () => {
    const apiTest = source(relative(srcRoot, join(apiRoot, 'tests', 'api.test.ts')))
    expect(apiTest).toContain("../src/agent/agentic-os/xox-run-worker-adapter.js")
    expect(apiTest).not.toContain("../src/modules/agent.js")
  })

  it('keeps memory writes model-selected instead of submission-time regex capture', () => {
    expect(existsSync(join(srcRoot, 'agent', 'run-submission.ts'))).toBe(false)
    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted root run submission adapter`).not.toContain("from './run-submission.js'")
    }
    expectNoImports('agent/agentic-os/xox-run-submission-adapter.ts', [
      /rememberFromUserMessage/,
    ])
    const memory = source('agent/memory.ts')
    expect(memory).not.toContain('memoryCandidateFromMessage')
    expect(memory).not.toContain('rememberFromUserMessage')
    expect(memory).not.toContain('message.match')
  })

  it('keeps active memory recall runtime in Agentic OS core instead of xox root agent files', () => {
    expect(existsSync(join(srcRoot, 'agent', 'memory-safety.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'active-memory-recall.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'memory', 'active-memory-subagent.ts'))).toBe(false)
    expect(existsSync(join(srcRoot, 'agent', 'prompts', 'memory.system.md'))).toBe(false)
    const memory = source('agent/memory.ts')
    expect(memory).toContain("@agentic-os/core")
    expect(memory).toContain('normalizeSecretSafeText')
    expect(memory).not.toContain("from './memory-safety.js'")
    const contextPack = source('agent/host-profile/xox-context-pack.ts')
    expect(contextPack).toContain("@agentic-os/core")
    expect(contextPack).toContain('createAgentActiveMemoryRecallRuntime')
    expect(contextPack).toContain('appendRunEvent')
    expect(contextPack).toContain('recordRecalledMemories')
    expect(contextPack).not.toContain("from './active-memory-recall.js'")
    expect(contextPack).not.toContain("from './memory/active-memory-subagent.js'")
    expect(contextPack).not.toContain('onStarted')
    expect(contextPack).not.toContain('onSkipped')
    expect(contextPack).not.toContain('onCompleted')
    expect(contextPack).not.toContain('onInjected')
    expect(contextPack).not.toContain("type: 'memory_recall_started'")
    expect(contextPack).not.toContain("type: 'memory_recall_completed'")
    expect(contextPack).not.toContain("type: 'memory_recall_skipped'")
    expect(contextPack).not.toContain("type: 'memory_injected'")

    for (const file of sourceFilesUnder('agent')) {
      expect(source(file), `${file} must not import the deleted active memory recall harness`).not.toContain("from './active-memory-recall.js'")
      expect(source(file), `${file} must not import the deleted active memory recall harness`).not.toContain("from '../active-memory-recall.js'")
      expect(source(file), `${file} must not import the deleted active memory prompt pack`).not.toContain("from './memory/active-memory-subagent.js'")
      expect(source(file), `${file} must not import the deleted active memory prompt pack`).not.toContain("from '../memory/active-memory-subagent.js'")
      expect(source(file), `${file} must not reference the deleted local memory prompt`).not.toContain('memory.system.md')
    }

    const deletedMemoryFacades = [
      'agent/memory-events.ts',
      'agent/memory-consolidator.ts',
      'agent/memory-retriever.ts',
      'agent/memory-candidate-detector.ts',
      'agent/memory-promotion-policy.ts',
      'agent/memory/daily-notes.ts',
      'agent/memory/dreaming-worker.ts',
      'agent/memory/memory-backend.ts',
      'agent/memory/memory-center.ts',
      'agent/memory/memory-tools.ts',
      'agent/memory/recall-signals.ts',
    ]
    for (const file of deletedMemoryFacades) {
      expect(existsSync(join(srcRoot, file))).toBe(false)
    }

    const memoryFiles = [
      'agent/memory.ts',
    ]
    expect(existsSync(join(srcRoot, 'agent', 'memory-kernel.ts'))).toBe(false)
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

  it('keeps sandbox runtime in Agentic OS instead of a host-owned runtime subtree', () => {
    const sandboxRuntimeDir = join(srcRoot, 'agent', 'sandbox')
    expect(existsSync(join(srcRoot, 'agent', 'sandbox-file-adapters.ts'))).toBe(false)
    if (existsSync(sandboxRuntimeDir)) {
      expect(sourceFilesUnder('agent/sandbox')).toEqual([])
    }

    for (const file of [
      'backend.ts',
      'backend-registry.ts',
      'sandbox-broker.ts',
      'sandbox-policy.ts',
      'result-parser.ts',
      'backends/local-script-backend.ts',
      'backends/docker-backend.ts',
      'backends/process-runner.ts',
      'backends/staged-sandbox-io.ts',
      'backends/tool-rpc-files.ts',
    ]) {
      expect(existsSync(join(sandboxRuntimeDir, file))).toBe(false)
    }

    const service = source('agent/sandbox-service.ts')
    expect(service).toContain("@agentic-os/sandbox")
    expect(service).not.toContain("from './sandbox/")

    const sandboxTest = testSource('sandbox-tool.test.ts')
    expect(sandboxTest).toContain("@agentic-os/sandbox")
    expect(sandboxTest).not.toContain("../src/agent/sandbox/")
    expect(sandboxTest).not.toContain("../src/agent/sandbox-file-adapters.js")
  })
})
