import { describe, expect, it } from 'vitest'
import {
  resolveRuntimePlannerResult,
  runtimePlannerResultToTurnOutput,
} from '@agentic-os/core'
import { validateRuntimeTurnOutputContract } from '@agentic-os/testing'
import type { RuntimePlanResult } from '../src/agent/host-profile/xox-provider-runtime.js'

function plan(overrides: Partial<RuntimePlanResult> = {}): RuntimePlanResult {
  return {
    source: 'openai_compatible_tool_calls',
    steps: [],
    ...overrides,
  }
}

const xoxBridgeOptions = {
  unknownToolNamePrefix: 'xox_unknown_tool_',
  unknownToolCallIdPrefix: 'xox_step_',
} as const

describe('xox Agentic OS compatibility adapter', () => {
  it('projects xox runtime tool steps into Agentic OS tool calls', () => {
    const output = runtimePlannerResultToTurnOutput(plan({
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
    }), xoxBridgeOptions)

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
    expect(resolveRuntimePlannerResult(plan({
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
    }), xoxBridgeOptions)).toEqual({
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
    expect(resolveRuntimePlannerResult(plan({
      assistantText: '你好，我可以帮你维护经营模型。',
    }), xoxBridgeOptions)).toEqual({
      type: 'final_candidate',
      assistantText: '你好，我可以帮你维护经营模型。',
    })
  })

  it('classifies provider errors as failed next steps', () => {
    expect(resolveRuntimePlannerResult(plan({
      error: {
        kind: 'missing_api_key',
        message: 'missing provider key',
      },
    }), xoxBridgeOptions)).toEqual({
      type: 'failed',
      reason: 'missing provider key',
      evidence: [],
    })
  })
})
