import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/core/settings.js'
import type { ChatTool } from '../src/agent/tool-catalog.js'
import type { RuntimePlanningInput, RuntimePlanResult } from '../src/agent/runtime/runtime-adapter.js'
import { classifyProviderHttpError } from '../src/agent/runtime/provider-error-classifier.js'
import { retryRuntimeInput, shouldRetryRuntimePlan } from '../src/agent/runtime/provider-failover-policy.js'
import { resolveProviderModelProfile } from '../src/agent/runtime/provider-model-profile.js'
import { resolveProviderModelRef } from '../src/agent/runtime/provider-model-ref.js'
import { resolveProviderRuntimeCapability, resolveRuntimeThinkingLevel } from '../src/agent/runtime/provider-capability-registry.js'
import { shapeOpenAICompatibleChatRequest } from '../src/agent/runtime/provider-request-shaper.js'
import { providerToolObservationReplayMessages } from '../src/agent/runtime/provider-transcript-replay.js'
import { normalizeProviderToolSchemas } from '../src/agent/runtime/provider-tool-schema.js'
import { extractBalancedJson } from '../src/agent/runtime/balanced-json.js'
import { readDraftsFromRuntimeResult } from '../src/agent/runtime-plan-reader.js'
import { OpenAICompatibleChatAdapter } from '../src/agent/runtime/openai-compatible-chat-adapter.js'
import {
  parseToolArguments,
  plannerStepsFromProviderToolCalls,
  ProviderToolCallParseError,
  repairToolName,
} from '../src/agent/runtime/tool-call-repair.js'

function settings(provider: string, model: string): Settings {
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

function tool(name = 'ledger_create_member_income'): ChatTool {
  return {
    type: 'function',
    function: {
      name,
      description: 'Test tool',
      parameters: {
        type: 'object',
        properties: {
          monthLabel: { type: 'string' },
        },
      },
    },
  }
}

function runtimeInput(provider: string, model: string, tools: ChatTool[] = [tool()]): RuntimePlanningInput {
  return {
    settings: settings(provider, model),
    message: '测试 provider runtime',
    context: { test: true },
    tools,
    stream: false,
  }
}

describe('OpenClaw-inspired provider runtime compatibility layer', () => {
  it('canonicalizes provider/model refs without leaking vendor prefixes into request model ids', () => {
    expect(resolveProviderModelRef({
      provider: 'openai-compatible',
      model: 'deepseek/deepseek-v4-pro',
    })).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      requestModel: 'deepseek-v4-pro',
      canonicalRef: 'deepseek/deepseek-v4-pro',
    })

    expect(resolveProviderModelRef({
      provider: 'qwen',
      model: 'deepseek/deepseek-v4-pro',
    })).toMatchObject({
      provider: 'qwen',
      requestModel: 'deepseek/deepseek-v4-pro',
      canonicalRef: 'qwen/deepseek/deepseek-v4-pro',
    })
  })

  it('resolves per-provider model profiles for tool_choice, schema and context policy', () => {
    expect(resolveProviderModelProfile({ provider: 'deepseek', model: 'deepseek-reasoner' })).toMatchObject({
      provider: 'deepseek',
      toolChoicePolicy: 'omit',
      schemaProfile: 'deepseek',
    })
    expect(resolveProviderModelProfile({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toMatchObject({
      toolChoicePolicy: 'auto',
      replayPolicy: 'deepseek-v4-thinking',
      contextWindow: 1_000_000,
    })
    expect(resolveProviderModelProfile({ provider: 'vllm', model: 'qwen-tool-required' })).toMatchObject({
      toolChoicePolicy: 'required-allowed',
    })
    expect(resolveProviderModelProfile({ provider: 'gemini', model: 'gemini-3-pro' })).toMatchObject({
      schemaProfile: 'gemini',
    })
  })

  it('shapes OpenAI-compatible requests from profile facts instead of global tool_choice rules', () => {
    const generic = shapeOpenAICompatibleChatRequest(runtimeInput('qwen', 'qwen3.5-plus')).body
    expect(generic.model).toBe('qwen3.5-plus')
    expect(generic.tool_choice).toBe('auto')
    expect(generic.tools).toBeTruthy()

    const reasoner = shapeOpenAICompatibleChatRequest(runtimeInput('deepseek', 'deepseek-reasoner')).body
    expect(reasoner.tool_choice).toBeUndefined()

    const vllmRequired = shapeOpenAICompatibleChatRequest(runtimeInput('vllm', 'qwen-tool-required')).body
    expect(vllmRequired.tool_choice).toBe('required')

    const deepSeekDefault = shapeOpenAICompatibleChatRequest(
      runtimeInput('deepseek', 'deepseek-v4-pro'),
    ).body
    expect(deepSeekDefault).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })

    const deepSeekProbe = shapeOpenAICompatibleChatRequest(
      runtimeInput('deepseek', 'deepseek-v4-pro'),
      { thinkingLevel: 'off' },
    ).body
    expect(deepSeekProbe).toMatchObject({ thinking: { type: 'disabled' } })
    expect(deepSeekProbe.reasoning_effort).toBeUndefined()

    const qwenDefault = shapeOpenAICompatibleChatRequest(
      runtimeInput('qwen', 'qwen3.5-plus'),
    ).body
    expect(qwenDefault).toMatchObject({ enable_thinking: true })

    const qwenProbe = shapeOpenAICompatibleChatRequest(
      runtimeInput('qwen', 'qwen3.5-plus'),
      { thinkingLevel: 'off' },
    ).body
    expect(qwenProbe).toMatchObject({ enable_thinking: false })
  })

  it('uses provider replay policy for observation continuation instead of synthetic prompt shims', () => {
    const replay = providerToolObservationReplayMessages({
      settings: settings('deepseek', 'deepseek-v4-pro'),
      observations: [{
        toolName: 'data_query_workspace',
        toolCallId: 'call_data_query_workspace',
        toolArguments: { scope: 'workspace_summary' },
        modelContent: JSON.stringify({ paybackMonthLabel: '4月' }),
      }],
    })

    const assistantTurn = replay[0] as any
    expect(assistantTurn.role).toBe('assistant')
    expect(assistantTurn.reasoning_content).toBe('')
    expect(replay[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_data_query_workspace',
      name: 'data_query_workspace',
    })

    const shaped = shapeOpenAICompatibleChatRequest({
      ...runtimeInput('deepseek', 'deepseek-v4-pro', []),
      messages: [
        { role: 'system', content: 'test' },
        ...replay,
      ],
    }).body
    expect((shaped.messages as any[])[1]?.reasoning_content).toBe('')

    const genericReplay = providerToolObservationReplayMessages({
      settings: settings('doubao', 'doubao-pro'),
      observations: [{
        toolName: 'data_query_workspace',
        toolCallId: 'call_data_query_workspace',
        toolArguments: { scope: 'workspace_summary' },
        modelContent: JSON.stringify({ paybackMonthLabel: '4月' }),
      }],
    })
    expect((genericReplay[0] as any).reasoning_content).toBeUndefined()
  })

  it('resolves provider runtime capabilities across major model families', () => {
    const cases = [
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        family: 'deepseek',
        replayMode: 'deepseek-openai-compatible-thinking',
        defaultThinking: 'high',
      },
      {
        provider: 'moonshot',
        model: 'kimi-k2',
        family: 'moonshot',
        replayMode: 'moonshot-thinking',
        defaultThinking: 'low',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4.5',
        family: 'anthropic',
        replayMode: 'anthropic-native',
        defaultThinking: 'medium',
      },
      {
        provider: 'gemini',
        model: 'gemini-3-pro',
        family: 'google-gemini',
        replayMode: 'google-gemini',
        defaultThinking: 'medium',
      },
      {
        provider: 'qwen',
        model: 'qwen3.5-plus',
        family: 'qwen',
        replayMode: 'openai-compatible',
        defaultThinking: 'high',
      },
      {
        provider: 'unknown',
        model: 'unknown-model',
        family: 'generic',
        replayMode: 'generic',
        defaultThinking: 'off',
      },
    ]

    for (const item of cases) {
      const profile = resolveProviderModelProfile({ provider: item.provider, model: item.model })
      const capability = resolveProviderRuntimeCapability(profile)
      const thinkingLevel = resolveRuntimeThinkingLevel({ capability })
      expect(capability.family).toBe(item.family)
      expect(thinkingLevel).toBe(item.defaultThinking)
      expect(capability.buildReplayPolicy({ profile, thinkingLevel }).mode).toBe(item.replayMode)
    }
  })

  it('normalizes provider tool schemas without changing the business tool registry', () => {
    const schemaTool: ChatTool = {
      type: 'function',
      function: {
        name: 'test_schema_tool',
        description: 'Schema test',
        parameters: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
            },
          },
        },
      },
    }
    const strictProfile = resolveProviderModelProfile({ provider: 'openai', model: 'gpt-5.4-mini' })
    const [strictTool] = normalizeProviderToolSchemas([schemaTool], strictProfile)
    expect(strictTool?.function.parameters).toMatchObject({
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          required: [],
          additionalProperties: false,
        },
      },
    })

    const geminiProfile = resolveProviderModelProfile({ provider: 'gemini', model: 'gemini-3-pro' })
    const [geminiTool] = normalizeProviderToolSchemas([{
      ...schemaTool,
      function: {
        ...schemaTool.function,
        parameters: {
          ...schemaTool.function.parameters,
          additionalProperties: false,
          anyOf: [{ type: 'string' }],
        } as any,
      },
    }], geminiProfile)
    expect(JSON.stringify(geminiTool?.function.parameters)).not.toContain('additionalProperties')
    expect(JSON.stringify(geminiTool?.function.parameters)).not.toContain('anyOf')
  })

  it('repairs provider-emitted tool names and streamed arguments after semantic tool selection', () => {
    expect(repairToolName(
      'functions.ledger_create_member_income:0',
      ['ledger_create_member_income'],
    )).toBe('ledger_create_member_income')
    expect(repairToolName(
      '',
      ['workspace_configure_operating_model'],
      'call_0_workspace_configure_operating_model',
    )).toBe('workspace_configure_operating_model')

    expect(parseToolArguments('provider prefix {"monthLabel":"3月","offlineUnits":1} trailing text')).toEqual({
      monthLabel: '3月',
      offlineUnits: 1,
    })
    expect(() =>
      parseToolArguments('provider prefix {"monthLabel":"3月","offlineUnits":1} trailing text', { enabled: false }),
    ).toThrow(SyntaxError)
    expect(parseToolArguments(['not', 'object'])).toEqual({})

    const steps = plannerStepsFromProviderToolCalls({
      allowedToolNames: ['ledger_create_member_income'],
      toolCalls: [{
        id: 'call_0_ledger_create_member_income',
        type: 'function',
        function: {
          arguments: 'prefix {"monthLabel":"3月","memberName":"成员 A","offlineUnits":1}',
        },
      }],
    })
    expect(steps).toEqual([
      expect.objectContaining({
        intent: 'ledger.create_member_income',
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
      }),
    ])

    try {
      plannerStepsFromProviderToolCalls({
        allowedToolNames: ['workspace_rename', 'workspace_configure_operating_model'],
        toolCalls: [
          {
            id: 'call_0_workspace_rename',
            type: 'function',
            function: {
              name: 'workspace_rename',
              arguments: '{"workspaceName":"星河 50 期启动测算"}',
            },
          },
          {
            id: 'call_1_workspace_configure_operating_model',
            type: 'function',
            function: {
              name: 'workspace_configure_operating_model',
              arguments: '{"plan":{"workspaceName":"星河 50 期启动测算"',
            },
          },
        ],
      })
      throw new Error('Expected malformed second tool call to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderToolCallParseError)
      expect((error as ProviderToolCallParseError).failedToolName).toBe('workspace_configure_operating_model')
      expect((error as ProviderToolCallParseError).toolNames[0]).toBe('workspace_configure_operating_model')
      expect((error as ProviderToolCallParseError).boundaryViolation()).toMatchObject({
        code: 'tool_call_arguments_truncated',
        toolName: 'workspace_configure_operating_model',
      })
    }

    try {
      plannerStepsFromProviderToolCalls({
        allowedToolNames: ['workspace_patch_config'],
        toolCalls: [{
          id: 'call_0_data_query_workspace',
          type: 'function',
          function: {
            name: 'data_query_workspace',
            arguments: '{"scope":"workspace_summary"}',
          },
        }],
      })
      throw new Error('Expected unavailable tool call to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderToolCallParseError)
      expect((error as ProviderToolCallParseError).boundaryViolation()).toMatchObject({
        code: 'tool_call_not_in_effective_inventory',
        toolName: 'data_query_workspace',
        toolNames: ['data_query_workspace'],
        effectiveToolNames: ['workspace_patch_config'],
      })
    }

    try {
      plannerStepsFromProviderToolCalls({
        allowedToolNames: ['data_query_workspace'],
        materializableToolNames: ['workspace_patch_config'],
        toolCalls: [{
          id: 'call_0_workspace_patch_config',
          type: 'function',
          function: {
            name: 'workspace_patch_config',
            arguments: '{"patches":[]}',
          },
        }],
      })
      throw new Error('Expected deferred registered tool call to request materialization')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderToolCallParseError)
      expect((error as ProviderToolCallParseError).boundaryViolation()).toMatchObject({
        code: 'tool_call_registered_but_deferred',
        toolName: 'workspace_patch_config',
        toolNames: ['workspace_patch_config'],
        effectiveToolNames: ['data_query_workspace'],
      })
    }
  })

  it('extracts only complete balanced JSON and rejects unbounded streamed pollution', () => {
    const nested = extractBalancedJson('prefix .functions.read:0 {"x":[{"y":"}"}],"z":true}x')
    expect(nested).toMatchObject({
      jsonText: '{"x":[{"y":"}"}],"z":true}',
      leadingText: 'prefix .functions.read:0 ',
      trailingText: 'x',
      complete: true,
    })

    expect(extractBalancedJson('prefix {"x":{"y":1}')).toMatchObject({
      jsonText: '{"x":{"y":1}',
      complete: false,
    })

    expect(parseToolArguments('.functions.read:0 {"x":1}x', {
      enabled: true,
      maxLeadingChars: 64,
      maxTrailingChars: 2,
    })).toEqual({ x: 1 })

    expect(() =>
      parseToolArguments('this provider prefix is intentionally too long {"x":1}', {
        enabled: true,
        maxLeadingChars: 8,
        maxTrailingChars: 2,
      }),
    ).toThrow(/pollution exceeded bounds/)

    expect(() =>
      parseToolArguments('prefix {"x":1', { enabled: true }),
    ).toThrow(/complete balanced JSON/)
  })

  it('classifies provider errors and retries only recoverable provider failures', () => {
    expect(classifyProviderHttpError(400, 'deepseek-reasoner does not support this tool_choice')).toMatchObject({
      kind: 'provider_http_error',
      classification: 'unsupported_parameter',
    })
    expect(classifyProviderHttpError(401, 'invalid api key')).toMatchObject({ classification: 'auth' })
    expect(classifyProviderHttpError(429, 'rate limit exceeded')).toMatchObject({ classification: 'rate_limit' })
    expect(classifyProviderHttpError(500, 'server overloaded')).toMatchObject({ classification: 'server' })

    const serverFailure: RuntimePlanResult = {
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: { kind: 'provider_http_error', statusCode: 500, classification: 'server' },
    }
    const authFailure: RuntimePlanResult = {
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: { kind: 'provider_http_error', statusCode: 401, classification: 'auth' },
    }
    expect(shouldRetryRuntimePlan(serverFailure)).toBe(true)
    expect(shouldRetryRuntimePlan(authFailure)).toBe(false)

    const retry = retryRuntimeInput(runtimeInput('qwen', 'qwen3.5-plus', [
      tool('ledger_create_member_income'),
      tool('workspace_publish_release'),
    ]), {
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: {
        kind: 'provider_response_error',
        toolNames: ['workspace_publish_release'],
      },
    })
    expect(retry.stream).toBe(false)
    expect(retry.tools.map((item) => item.function.name)).toEqual(['workspace_publish_release'])
    expect(retry.requestTimeoutMs).toBeGreaterThanOrEqual(240_000)

    const operatingRetry = retryRuntimeInput(runtimeInput('deepseek', 'deepseek-v4-pro', [
      tool('workspace_configure_operating_model'),
      tool('workspace_rename'),
    ]), {
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: {
        kind: 'provider_response_error',
        toolNames: ['workspace_configure_operating_model'],
      },
    })
    expect(operatingRetry.stream).toBe(false)
    expect(operatingRetry.tools.map((item) => item.function.name)).toEqual(['workspace_configure_operating_model'])
    expect(operatingRetry.maxTokens).toBeGreaterThanOrEqual(48_000)
    expect(operatingRetry.requestTimeoutMs).toBeGreaterThanOrEqual(360_000)

    const sandboxRetry = retryRuntimeInput(runtimeInput('deepseek', 'deepseek-v4-pro', [
      tool('sandbox_run_code'),
      tool('data_query_workspace'),
    ]), {
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: {
        kind: 'provider_response_error',
        toolNames: ['sandbox_run_code'],
      },
    })
    expect(sandboxRetry.stream).toBe(false)
    expect(sandboxRetry.tools.map((item) => item.function.name)).toEqual(['sandbox_run_code'])
    expect(sandboxRetry.maxTokens).toBeGreaterThanOrEqual(48_000)
    expect(sandboxRetry.requestTimeoutMs).toBeGreaterThanOrEqual(360_000)

    expect(shouldRetryRuntimePlan({
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: {
        kind: 'provider_response_error',
        toolCallBoundary: {
          code: 'tool_call_not_in_effective_inventory',
          toolName: 'data_query_workspace',
          toolNames: ['data_query_workspace'],
          effectiveToolNames: ['workspace_patch_config'],
        },
        toolNames: ['data_query_workspace'],
      },
    })).toBe(false)

    expect(shouldRetryRuntimePlan({
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: {
        kind: 'provider_response_error',
        toolCallBoundary: {
          code: 'tool_call_arguments_truncated',
          toolName: 'sandbox_run_code',
          toolNames: ['sandbox_run_code'],
          effectiveToolNames: ['sandbox_run_code', 'data_query_workspace'],
        },
        toolNames: ['sandbox_run_code'],
      },
    })).toBe(true)
  })

  it('preserves provider-authored preface text on non-stream tool-call responses', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl_preface',
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '我先查询当前工作区数据，再给出回本结论。',
          tool_calls: [{
            id: 'call_ledger_create_member_income',
            type: 'function',
            function: {
              name: 'ledger_create_member_income',
              arguments: JSON.stringify({ monthLabel: '5月', memberName: '成员 A', onlineUnits: 10 }),
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro'))
      expect(result?.assistantText).toBe('我先查询当前工作区数据，再给出回本结论。')
      expect(result?.steps).toHaveLength(1)
      expect(result?.steps[0]).toEqual(expect.objectContaining({
        intent: 'ledger.create_member_income',
        memberName: '成员 A',
        onlineUnits: 10,
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('captures provider reasoning deltas during streamed tool calls without exposing them as user text', async () => {
    const originalFetch = globalThis.fetch
    const encoder = new TextEncoder()
    const event = {
      choices: [{
        delta: {
          reasoning_content: '先确认需要调用记账工具。',
          tool_calls: [{
            index: 0,
            id: 'call_ledger_create_member_income',
            type: 'function',
            function: {
              name: 'ledger_create_member_income',
              arguments: JSON.stringify({ monthLabel: '5月', memberName: '成员 A', onlineUnits: 10 }),
            },
          }],
        },
      }],
    }
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro'))
      expect(result?.steps).toHaveLength(1)
      expect(result?.assistantText).toBeUndefined()
      expect(result?.providerArtifact).toMatchObject({
        family: 'deepseek',
        thinkingLevel: 'high',
        reasoningText: '先确认需要调用记账工具。',
      })
      expect((result?.providerAssistantMessage as any)?.reasoning_content).toBe('先确认需要调用记账工具。')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('recovers DeepSeek DSML tool calls emitted as streamed assistant text', async () => {
    const originalFetch = globalThis.fetch
    const encoder = new TextEncoder()
    const dsml = [
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="sandbox_run_code">',
      '<｜DSML｜parameter name="purpose">计算第 2 个股东贷款口径 ROI</｜DSML｜parameter>',
      '<｜DSML｜parameter name="language">python</｜DSML｜parameter>',
      '<｜DSML｜parameter name="code">print("roi")</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('\n')
    const event = {
      choices: [{
        delta: {
          content: dsml,
        },
      }],
    }
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro', [
        tool('sandbox_run_code'),
      ]))
      expect(result?.error).toBeUndefined()
      expect(result?.assistantText).toBeUndefined()
      expect(result?.steps).toHaveLength(1)
      expect(result?.steps[0]).toEqual(expect.objectContaining({
        intent: 'sandbox.run_code',
        purpose: '计算第 2 个股东贷款口径 ROI',
        language: 'python',
        code: 'print("roi")',
      }))
      expect((result?.providerAssistantMessage as any)?.tool_calls?.[0]?.function?.name).toBe('sandbox_run_code')
      expect((result?.providerAssistantMessage as any)?.content).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects provider plain-text tool calls after the tool inventory is closed', async () => {
    const originalFetch = globalThis.fetch
    const encoder = new TextEncoder()
    const dsml = [
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="sandbox_run_code">',
      '<｜DSML｜parameter name="purpose">继续修复计算脚本</｜DSML｜parameter>',
      '<｜DSML｜parameter name="language">python</｜DSML｜parameter>',
      '<｜DSML｜parameter name="code">print("retry")</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('\n')
    const event = {
      choices: [{
        delta: {
          content: dsml,
        },
      }],
    }
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro', []))
      expect(result?.steps).toHaveLength(0)
      expect(result?.assistantText).toBeUndefined()
      expect(result?.error).toMatchObject({
        kind: 'provider_response_error',
        toolNames: ['sandbox_run_code'],
        toolCallBoundary: {
          code: 'tool_call_not_in_effective_inventory',
          toolName: 'sandbox_run_code',
          effectiveToolNames: [],
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects truncated provider plain-text tool-call markers as final assistant text', async () => {
    const originalFetch = globalThis.fetch
    const encoder = new TextEncoder()
    const event = {
      choices: [{
        delta: {
          content: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="sandbox_run_code">\n<｜｜DSML｜｜parameter name="purpose">retry',
        },
      }],
    }
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro', []))
      expect(result?.steps).toHaveLength(0)
      expect(result?.assistantText).toBeUndefined()
      expect(result?.error).toMatchObject({
        kind: 'provider_response_error',
        toolCallBoundary: {
          code: 'tool_call_arguments_invalid',
          effectiveToolNames: [],
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('repairs streamed tool names from provider call ids before frame damage checks', async () => {
    const originalFetch = globalThis.fetch
    const encoder = new TextEncoder()
    const event = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_0_ledger_create_member_income',
            type: 'function',
            function: {
              arguments: JSON.stringify({ monthLabel: '5月', memberName: '成员 A', onlineUnits: 10 }),
            },
          }],
        },
      }],
    }
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro'))
      expect(result?.error).toBeUndefined()
      expect(result?.steps).toHaveLength(1)
      expect(result?.steps[0]).toEqual(expect.objectContaining({
        intent: 'ledger.create_member_income',
        memberName: '成员 A',
        onlineUnits: 10,
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports incomplete streamed sandbox arguments as a provider tool-call parse failure', async () => {
    const originalFetch = globalThis.fetch
    const encoder = new TextEncoder()
    const event = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_sandbox_run_code',
            type: 'function',
            function: {
              name: 'sandbox_run_code',
              arguments: '{"purpose":"calculate ROI","language":"python","code":"print(',
            },
          }],
        },
      }],
    }
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

    try {
      const streamEvents: any[] = []
      const result = await new OpenAICompatibleChatAdapter().plan({
        ...runtimeInput('deepseek', 'deepseek-v4-pro', [tool('sandbox_run_code')]),
        stream: true,
        onStreamEvent: (event) => {
          streamEvents.push(event)
        },
      })
      expect(result?.steps).toHaveLength(0)
      expect(result?.error).toMatchObject({
        kind: 'provider_response_error',
        toolNames: ['sandbox_run_code'],
        toolCallBoundary: {
          code: 'tool_call_arguments_truncated',
          toolName: 'sandbox_run_code',
        },
      })
      expect(streamEvents).toContainEqual(expect.objectContaining({
        kind: 'tool_call_damage',
        toolName: 'sandbox_run_code',
        boundaryCode: 'tool_call_arguments_truncated',
        retryable: true,
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('materializes provider tool-call boundary failures as model-readable observations', () => {
    const reads = readDraftsFromRuntimeResult({
      source: 'openai_compatible_tool_calls',
      steps: [],
      error: {
        kind: 'provider_response_error',
        message: 'Unexpected end of JSON input',
        toolNames: ['sandbox_run_code'],
        toolCallBoundary: {
          code: 'tool_call_arguments_truncated',
          toolName: 'sandbox_run_code',
          toolNames: ['sandbox_run_code'],
          effectiveToolNames: ['sandbox_run_code', 'data_query_workspace'],
        },
      },
    })

    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({
      readKind: 'tool_observation',
      toolName: 'sandbox_run_code',
      observationStatus: 'not_executed',
      syntheticObservation: true,
      status: 'failed',
    })
    expect(JSON.parse(reads[0]?.modelContent ?? '{}')).toMatchObject({
      observationType: 'provider_tool_call_boundary',
      status: 'not_executed',
      executionMode: 'not_executed',
      toolName: 'sandbox_run_code',
      boundaryCode: 'tool_call_arguments_truncated',
    })
  })

  it('fails closed when provider emits a tool outside the effective inventory', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl_outside_inventory_tool',
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '我先查询当前工作区数据。',
          tool_calls: [{
            id: 'call_data_query_workspace',
            type: 'function',
            function: {
              name: 'data_query_workspace',
              arguments: JSON.stringify({ scope: 'workspace_summary' }),
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    try {
      const result = await new OpenAICompatibleChatAdapter().plan(runtimeInput('deepseek', 'deepseek-v4-pro', [
        tool('workspace_patch_config'),
      ]))
      expect(result?.steps).toHaveLength(0)
      expect(result?.assistantText).toBeUndefined()
      expect(result?.error).toMatchObject({
        kind: 'provider_response_error',
        toolNames: ['data_query_workspace'],
        toolCallBoundary: {
          code: 'tool_call_not_in_effective_inventory',
          toolName: 'data_query_workspace',
          toolNames: ['data_query_workspace'],
          effectiveToolNames: ['workspace_patch_config'],
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
