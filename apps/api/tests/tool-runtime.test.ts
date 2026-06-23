import { describe, expect, it } from 'vitest'
import type { AgentToolInventorySnapshot } from '@xox/contracts'
import {
  resolveProviderModelProfile,
  sanitizeOpenAICompatibleRequestBody,
} from '@agentic-os/runtime-openai-compatible'
import {
  composeAgentWriteApprovalPolicy,
  evaluateToolLoopGuardrails,
  runToolCallSupervisor,
  type ToolSupervisorStepLike,
} from '@agentic-os/core'
import type { AgentToolObservation } from '../src/agent/host-profile/xox-planned-items.js'

describe('Tool Runtime Maturity Layer', () => {
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
    const supervised = await runToolCallSupervisor<ToolSupervisorStepLike, {
      title: string
      message: string
      status?: string
      observationStatus?: 'completed' | 'failed'
      modelContent?: string
    }, AgentToolInventorySnapshot['tools'][number], AgentToolInventorySnapshot>({
      runId: 'run_1',
      inventoryTools: inventory.tools,
      inventorySnapshot: inventory,
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
      executeToolCall: ({ call }) => {
        if (call.toolName !== 'data_query_workspace') return []
        return {
          title: '查询工作区数据',
          message: '回本周期未出现。',
          status: 'info',
          observationStatus: 'completed' as const,
        }
      },
      createFailureItem: (failure) => ({
        title: failure.title,
        message: failure.message,
        status: failure.status,
        observationStatus: failure.observationStatus,
        modelContent: failure.modelContent,
      }),
      toProducedItem: (item) => ({
        kind: 'observation',
        title: item.title,
        message: item.message,
        preview: item.message,
        ...(item.status ? { status: item.status } : {}),
        ...(item.observationStatus ? { observationStatus: item.observationStatus } : {}),
        ...(item.modelContent ? { modelContent: item.modelContent } : {}),
      }),
    })

    expect(supervised.items).toHaveLength(2)
    expect(supervised.observations).toEqual([
      expect.objectContaining({ toolName: 'data_query_workspace', status: 'completed', authorityClass: 'read' }),
      expect.objectContaining({ toolName: 'workspace_patch_config', status: 'failed', authorityClass: 'manual_only' }),
    ])
    const secondItem = supervised.items[1]
    expect(secondItem?.status).toBe('failed')
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
    const failedAgain: AgentToolObservation = { ...failed, toolCallId: 'call_2' }

    expect(evaluateToolLoopGuardrails({
      iteration: 2,
      priorObservations: [failed],
      newObservations: [failedAgain],
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

  it('does not treat a final assistant candidate after observations as no progress', () => {
    const completed: AgentToolObservation = {
      title: '查询工作区数据',
      toolName: 'data_query_workspace',
      toolCallId: 'call_data',
      toolArguments: { question: 'roi' },
      displayPreview: '已读取数据。',
      modelContent: '{"roi":1.2}',
      status: 'completed',
    }

    expect(evaluateToolLoopGuardrails({
      iteration: 2,
      priorObservations: [completed],
      newObservations: [],
      planRows: [],
      actionRows: [],
      hasFinalAssistantCandidate: true,
    })).toEqual([])
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
