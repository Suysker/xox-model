import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(testDir, '..')
const srcRoot = join(apiRoot, 'src')

function source(path: string) {
  return readFileSync(join(srcRoot, path), 'utf8')
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
      'agent/runtime/adapter-router.ts',
      'agent/runtime/balanced-json.ts',
      'agent/runtime/high-volume-tool-policy.ts',
      'agent/runtime/openai-agents-adapter.ts',
      'agent/runtime/openai-compatible-chat-adapter.ts',
      'agent/runtime/provider-error-classifier.ts',
      'agent/runtime/provider-failover-policy.ts',
      'agent/runtime/provider-model-profile.ts',
      'agent/runtime/provider-model-ref.ts',
      'agent/runtime/provider-probe.ts',
      'agent/runtime/provider-request-shaper.ts',
      'agent/runtime/provider-tool-schema.ts',
      'agent/runtime/runtime-adapter.ts',
      'agent/runtime/tool-call-argument-repair.ts',
      'agent/runtime/tool-call-name-normalizer.ts',
      'agent/runtime/tool-call-repair.ts',
      'agent/runtime/tool-call-stream-assembler.ts',
      'agent/runtime/tool-call-validator.ts',
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

  it('keeps AgentActionRuntime as the Agent-owned write lifecycle boundary', () => {
    expect(existsSync(join(srcRoot, 'agent', 'agent-action-runtime.ts'))).toBe(true)
    expectNoImports('agent/action-graph-store.ts', [
      /approval-executor/,
      /autoExecuteAgentActionRequest/,
      /resolveActionAuthority/,
    ])
    const runtime = source('agent/agent-action-runtime.ts')
    expect(runtime).toContain('addAgentActionRequest')
    expect(runtime).toContain('autoExecuteAgentActionRequest')
    expectNoImports('agent/agent-action-runtime.ts', [
      /runtime\//,
      /tool-gateway/,
      /planner/,
    ])
  })

  it('routes provider planning through ContextEngine instead of ad hoc context pack assembly', () => {
    expect(existsSync(join(srcRoot, 'agent', 'context-engine', 'index.ts'))).toBe(true)
    const planningCall = source('agent/runtime-planning-call.ts')
    expect(planningCall).toContain("from './context-engine/index.js'")
    expect(planningCall).not.toContain("from './context-pack.js'")
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
