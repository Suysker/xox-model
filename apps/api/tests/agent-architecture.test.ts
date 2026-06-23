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
    ])

    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'xox-host-profile.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'xox-planned-items.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'host-profile', 'prompts', 'xox-planning-policy.md'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'tool-catalog.ts'))).toBe(true)
    expect(existsSync(join(srcRoot, 'agent', 'tool-executor.ts'))).toBe(true)
  })

  it('routes worker and action confirmation through the thin host profile only', () => {
    const worker = source('agent/agentic-os/xox-run-worker-adapter.ts')
    const routes = source('agent/routes.ts')

    expect(worker).toContain("from '../host-profile/xox-host-profile.js'")
    expect(worker).toContain('executeXoxAgentRun')
    expect(routes).toContain("from './host-profile/xox-host-profile.js'")
    expect(routes).toContain('resumeXoxAgentRunAfterActionConfirmation')

    for (const content of [worker, routes]) {
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

    expect(host).toContain('createAgentServer')
    expect(host).toContain('runOpenAICompatibleRuntimeTurn')
    expect(host).toContain('runOpenAIAgentsTurn')
    expect(host).toContain('storePlannedActionGraph')
    expect(host).toContain('executeAgentActionRequest')

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
      'AgentLoopObligationPlan',
      'loopObligationPlan',
      'RuntimePlanResult',
      'RuntimePlanError',
      'readRuntimeGoalFacts',
      'goalFactsFromRunEvent',
      'createAgentActiveMemoryRecallRuntime',
      'buildToolContextPack',
      'tool_discover',
      "name: 'rg'",
    ])
  })

  it('keeps provider mechanics and run-plane primitives sourced from Agentic OS packages', () => {
    const host = source('agent/host-profile/xox-host-profile.ts')
    const runEvents = source('agent/agentic-os/xox-run-event-store-adapter.ts')
    const runWorker = source('agent/agentic-os/xox-run-worker-adapter.ts')
    const runLease = source('agent/agentic-os/xox-run-lease-store-adapter.ts')
    const threadStore = source('agent/agentic-os/xox-thread-store-adapter.ts')

    expect(host).toContain("@agentic-os/core")
    expect(host).toContain("@agentic-os/server")
    expect(host).toContain("@agentic-os/runtime-openai-compatible")
    expect(host).toContain("@agentic-os/runtime-openai-agents")
    expect(runEvents).toContain('@agentic-os/server')
    expect(runEvents).toContain('addAgentServerRuntimeStreamRunEvent')
    expect(runWorker).toContain('@agentic-os/server')
    expect(runWorker).toContain('createAgentServerRunScheduler')
    expect(runWorker).toContain('projectAgentServerRunCompletion')
    expect(runLease).toContain('@agentic-os/server')
    expect(threadStore).toContain('@agentic-os/server')
    expect(threadStore).toContain('AgentServerThreadStateProjector')
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
      'xox-direct-answer-policy.md',
      'xox-planning-policy.md',
      'xox-turn-lane-policy.md',
    ])
  })

  it('removes host provider runtime tests instead of testing a deleted local runner', () => {
    expect(existsSync(join(testDir, 'provider-runtime.test.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'agentic-os-adapter.test.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'tool-context-engine.test.ts'))).toBe(false)

    const apiPackage = readFileSync(join(apiRoot, 'package.json'), 'utf8')
    const packageLock = readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')
    expect(apiPackage).toContain('@agentic-os/runtime-openai-compatible')
    expect(apiPackage).toContain('@agentic-os/runtime-openai-agents')
    expect(packageLock).not.toContain('@xox/agent-memory-core')
  })
})
