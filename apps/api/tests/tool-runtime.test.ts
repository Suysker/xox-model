import { describe, expect, it } from 'vitest'
import type { AgentToolInventorySnapshot } from '@xox/contracts'
import type { Settings } from '../src/core/settings.js'
import { buildEffectiveToolInventorySnapshot } from '../src/agent/tool-runtime/effective-tool-inventory.js'
import { sanitizeOpenAICompatibleRequestBody } from '../src/agent/runtime/provider-payload-sanitizer.js'
import { resolveProviderModelProfile } from '../src/agent/runtime/provider-model-profile.js'
import { superviseRuntimeToolCalls } from '../src/agent/tool-runtime/tool-call-supervisor.js'
import { evaluateToolLoopGuardrails } from '../src/agent/tool-runtime/tool-loop-guardrails.js'
import { composeAgentWriteApprovalPolicy } from '../src/agent/tool-runtime/approval-policy-composer.js'
import type { PlannerContext } from '../src/agent/planning-context.js'
import type { AgentToolObservation } from '../src/agent/tool-observation-continuation.js'

function settings(provider = 'deepseek', model = 'deepseek-v4-pro'): Settings {
  return {
    databaseUrl: 'sqlite:///:memory:',
    sessionCookieName: 'xox_session',
    sessionTtlDays: 14,
    corsOrigin: 'http://127.0.0.1:5173',
    llmProvider: provider,
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-5.4-mini',
    openaiApiKey: null,
    openaiCompatibleProvider: provider,
    openaiCompatibleBaseUrl: 'https://provider.example/v1',
    openaiCompatibleModel: model,
    openaiCompatibleApiKey: 'test-key',
    agentProviderKeyEncryptionSecret: null,
    agentWorkerId: 'test-worker',
    agentRunLeaseTtlMs: 10_000,
    agentRunWorkerPollMs: 10_000,
    agentProviderRequestTimeoutMs: 10_000,
  }
}

describe('Tool Runtime Maturity Layer', () => {
  it('builds effective tool inventory snapshots with authority classes and provenance', () => {
    const snapshot = buildEffectiveToolInventorySnapshot({
      userId: 'user_1',
      workspaceId: 'workspace_1',
      automationLevel: 'high',
      settings: settings(),
      strategy: 'router_fallback_business_core',
      selectedCapabilities: ['data', 'draft'],
      snapshotId: 'snapshot_1',
      createdAt: '2026-05-30T00:00:00.000Z',
      toolCapabilities: [
        { name: 'data_query_workspace', capability: 'data', riskLevel: 'read', confirmationMode: 'never', navigationTarget: null },
        { name: 'sandbox_run_code', capability: 'sandbox', riskLevel: 'read', confirmationMode: 'never', navigationTarget: null },
        { name: 'workspace_patch_config', capability: 'draft', riskLevel: 'medium', confirmationMode: 'always', navigationTarget: 'inputs' },
        { name: 'account_forbidden', capability: 'account', riskLevel: 'read', confirmationMode: 'never', navigationTarget: null },
        { name: 'memory_remember', capability: 'memory', riskLevel: 'low', confirmationMode: 'never', navigationTarget: null },
      ],
      routerReason: 'fallback for test',
    })

    expect(snapshot).toMatchObject({
      snapshotId: 'snapshot_1',
      source: 'business_core_fallback',
      freshness: 'fallback',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      automationLevel: 'high',
      capabilities: ['data', 'sandbox', 'draft', 'account', 'memory'],
    })
    expect(Object.fromEntries(snapshot.tools.map((tool) => [tool.name, tool.authorityClass]))).toMatchObject({
      data_query_workspace: 'read',
      sandbox_run_code: 'sandbox_compute',
      workspace_patch_config: 'confirmation_write',
      account_forbidden: 'manual_only',
      memory_remember: 'confirmation_write',
    })
    expect(snapshot.tools.every((tool) => tool.provenance === 'xox')).toBe(true)
    expect(snapshot.tools[0]?.providerCompatibility).toContain('tools')
  })

  it('sanitizes strict provider payloads without changing business tool schemas', () => {
    const profile = resolveProviderModelProfile({ provider: 'deepseek', model: 'deepseek-reasoner' })
    const body = sanitizeOpenAICompatibleRequestBody({
      model: 'deepseek-reasoner',
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'data_query_workspace', arguments: '{"question":"x"}' },
          x_internal: 'drop',
        }],
        x_trace: 'drop',
      }],
      tools: [{ type: 'function', function: { name: 'data_query_workspace', description: 'x', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      x_internal_debug: true,
    }, profile)

    expect(body.tool_choice).toBeUndefined()
    expect(body.parallel_tool_calls).toBeUndefined()
    expect(body.x_internal_debug).toBeUndefined()
    expect(body.messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'data_query_workspace', arguments: '{"question":"x"}' },
      }],
    }])
    expect(body.tools).toBeTruthy()
  })

  it('supervises model-selected tool calls and blocks tools outside the effective inventory', async () => {
    const inventory: AgentToolInventorySnapshot = {
      snapshotId: 'inventory_1',
      userId: 'user_1',
      workspaceId: 'workspace_1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      automationLevel: 'manual',
      source: 'model_selected_capabilities',
      freshness: 'fresh',
      capabilities: ['data'],
      tools: [{
        name: 'data_query_workspace',
        capability: 'data',
        risk: 'read',
        confirmationMode: 'never',
        navigationTarget: null,
        authorityClass: 'read',
        providerCompatibility: ['tools'],
        provenance: 'xox',
      }],
      createdAt: '2026-05-30T00:00:00.000Z',
    }
    const ctx = {
      runId: 'run_1',
      threadId: 'thread_1',
    } as PlannerContext

    const supervised = await superviseRuntimeToolCalls(ctx, {
      inventorySnapshot: inventory,
      emitRunEvents: false,
      steps: [
        {
          intent: 'data.query_workspace',
          providerToolName: 'data_query_workspace',
          providerToolCallId: 'call_data',
          providerToolArguments: { question: '回本' },
        },
        {
          intent: 'workspace.patch_config',
          providerToolName: 'workspace_patch_config',
          providerToolCallId: 'call_patch',
          providerToolArguments: { patches: [] },
        },
      ],
      handlers: {
        'data.query_workspace': async () => ({
          title: '查询工作区数据',
          message: '回本周期未出现。',
          readKind: 'tool_observation',
          status: 'info',
        }),
      },
    })

    expect(supervised.items).toHaveLength(2)
    expect(supervised.observations).toEqual([
      expect.objectContaining({ toolName: 'data_query_workspace', status: 'completed', authorityClass: 'read' }),
      expect.objectContaining({ toolName: 'workspace_patch_config', status: 'failed', authorityClass: 'manual_only' }),
    ])
    const secondItem = supervised.items[1]
    expect(secondItem && 'readKind' in secondItem ? secondItem.status : null).toBe('failed')
  })

  it('detects repeated failures and no-progress loops as guardrail findings', () => {
    const failed: AgentToolObservation = {
      title: '失败',
      toolName: 'data_query_workspace',
      toolCallId: 'call_1',
      toolArguments: { question: 'x' },
      displayPreview: 'failed',
      modelContent: '{}',
      status: 'failed',
    }

    expect(evaluateToolLoopGuardrails({
      iteration: 2,
      priorObservations: [failed],
      newObservations: [{ ...failed, toolCallId: 'call_2' }],
      planRows: [],
      actionRows: [],
    })).toEqual([
      expect.objectContaining({ severity: 'block', pattern: 'repeated_failure', toolName: 'data_query_workspace' }),
    ])

    expect(evaluateToolLoopGuardrails({
      iteration: 2,
      priorObservations: [],
      newObservations: [],
      planRows: [],
      actionRows: [],
    })).toEqual([
      expect.objectContaining({ severity: 'warn', pattern: 'no_progress' }),
    ])
  })

  it('composes automation authority separately from planning effort', () => {
    expect(composeAgentWriteApprovalPolicy({
      automationLevel: 'manual',
      riskLevel: 'low',
    })).toMatchObject({ mode: 'require_confirmation' })
    expect(composeAgentWriteApprovalPolicy({
      automationLevel: 'medium',
      riskLevel: 'medium',
    })).toMatchObject({ mode: 'auto_execute' })
    expect(composeAgentWriteApprovalPolicy({
      automationLevel: 'high',
      riskLevel: 'high',
    })).toMatchObject({ mode: 'require_confirmation' })
    expect(composeAgentWriteApprovalPolicy({
      automationLevel: 'high',
      riskLevel: 'high',
      highRiskAutoAllowed: true,
    })).toMatchObject({ mode: 'auto_execute' })
    expect(composeAgentWriteApprovalPolicy({
      automationLevel: 'high',
      riskLevel: 'low',
      accountImpacting: true,
    })).toMatchObject({ mode: 'forbidden' })
  })
})
