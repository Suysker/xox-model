import { describe, expect, it } from 'vitest'
import {
  resolveProviderModelProfile,
  sanitizeOpenAICompatibleRequestBody,
} from '@agentic-os/runtime-openai-compatible'
import {
  composeAgentWriteApprovalPolicy,
} from '@agentic-os/core'

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
