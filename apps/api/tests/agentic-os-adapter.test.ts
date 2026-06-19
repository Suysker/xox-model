import { describe, expect, it } from 'vitest'
import { validateRuntimeTurnOutputContract } from '@agentic-os/testing'
import type { RuntimePlanResult } from '../src/agent/runtime/runtime-adapter.js'
import {
  resolveRuntimePlanWithAgenticOs,
  runtimePlanResultToAgenticOsTurnOutput,
} from '../src/agent/agentic-os/xox-runtime-turn-output.js'

function plan(overrides: Partial<RuntimePlanResult> = {}): RuntimePlanResult {
  return {
    source: 'openai_compatible_tool_calls',
    steps: [],
    ...overrides,
  }
}

describe('xox Agentic OS compatibility adapter', () => {
  it('projects xox runtime tool steps into Agentic OS tool calls', () => {
    const output = runtimePlanResultToAgenticOsTurnOutput(plan({
      assistantText: '我会先读取工作区。',
      steps: [
        {
          providerToolCallId: 'call_1',
          providerToolName: 'data_query_workspace',
          providerToolArguments: {
            scope: 'workspace_summary',
          },
          intent: 'data.query_workspace',
        },
      ],
    }))

    expect(output).toEqual({
      assistantText: '我会先读取工作区。',
      toolCalls: [
        {
          toolCallId: 'call_1',
          name: 'data_query_workspace',
          input: {
            scope: 'workspace_summary',
          },
        },
      ],
    })

    const contract = validateRuntimeTurnOutputContract(output)
    expect(contract.valid).toBe(true)
    expect(contract.nextStep).toEqual({
      type: 'tool_calls',
      toolCalls: output.toolCalls,
    })
  })

  it('uses Agentic OS TurnResolver so tool calls dominate assistant text', () => {
    expect(resolveRuntimePlanWithAgenticOs(plan({
      assistantText: '工具调用后再回答。',
      steps: [
        {
          providerToolCallId: 'call_1',
          providerToolName: 'data_query_workspace',
          providerToolArguments: {
            scope: 'workspace_summary',
          },
        },
      ],
    }))).toEqual({
      type: 'tool_calls',
      toolCalls: [
        {
          toolCallId: 'call_1',
          name: 'data_query_workspace',
          input: {
            scope: 'workspace_summary',
          },
        },
      ],
    })
  })

  it('classifies assistant text without tool calls as a final candidate', () => {
    expect(resolveRuntimePlanWithAgenticOs(plan({
      assistantText: '你好，我可以帮你维护经营模型。',
    }))).toEqual({
      type: 'final_candidate',
      assistantText: '你好，我可以帮你维护经营模型。',
    })
  })

  it('classifies provider errors as failed next steps', () => {
    expect(resolveRuntimePlanWithAgenticOs(plan({
      error: {
        kind: 'missing_api_key',
        message: 'missing provider key',
      },
    }))).toEqual({
      type: 'failed',
      reason: 'missing provider key',
      evidence: [],
    })
  })
})
