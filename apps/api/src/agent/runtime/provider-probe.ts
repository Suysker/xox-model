import {
  probeOpenAICompatibleProvider as probeProviderOpenAICompatibleProvider,
  type OpenAiCompatibleFunctionToolDescriptor,
  type OpenAICompatibleProviderProbeCheck,
  type OpenAICompatibleProviderProbeResult,
} from '@agentic-os/runtime-openai-compatible'
import type { RuntimePlanningInput } from './runtime-adapter.js'

export type ProviderProbeResult = {
  status: 'passed' | 'failed' | 'warning'
  provider: string
  model: string
  checks: Array<{
    name: 'auth' | 'model' | 'chat' | 'tools' | 'stream'
    status: 'passed' | 'failed' | 'warning' | 'skipped'
    message: string
  }>
  message: string
}

type ProviderProbeCheck = ProviderProbeResult['checks'][number]

const PROBE_TOOL: OpenAiCompatibleFunctionToolDescriptor = {
  type: 'function',
  function: {
    name: 'xox_provider_probe',
    description: '用于验证当前 provider 是否支持 OpenAI-compatible tool_calls。必须调用这个工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', description: '固定传 true。' },
      },
    },
  },
}

function missingKeyResult(provider: string, model: string): ProviderProbeResult {
  return {
    status: 'failed',
    provider,
    model,
    checks: [
      { name: 'auth', status: 'failed', message: '没有可用 API key。' },
      { name: 'model', status: 'skipped', message: '认证失败前不检查模型。' },
      { name: 'chat', status: 'skipped', message: '认证失败前不检查对话。' },
      { name: 'tools', status: 'skipped', message: '认证失败前不检查工具调用。' },
      { name: 'stream', status: 'skipped', message: '认证失败前不检查流式输出。' },
    ],
    message: 'Provider probe failed: missing API key.',
  }
}

function localizeProbeCheck(input: {
  check: OpenAICompatibleProviderProbeCheck
  model: string
  result: OpenAICompatibleProviderProbeResult
}): ProviderProbeCheck {
  const httpFailure = input.result.status === 'failed' && input.result.message.startsWith('HTTP ')
  const transportFailure = input.result.status === 'failed' && !httpFailure

  if (input.check.name === 'auth' && input.check.status === 'passed') {
    return { name: 'auth', status: 'passed', message: 'API key 可用于当前 provider。' }
  }
  if (input.check.name === 'model' && input.check.status === 'passed') {
    return { name: 'model', status: 'passed', message: `模型 ${input.model} 返回了有效响应。` }
  }
  if (input.check.name === 'chat' && input.check.status === 'passed') {
    return { name: 'chat', status: 'passed', message: 'Chat Completions 请求成功。' }
  }
  if (input.check.name === 'tools') {
    if (input.check.status === 'passed') {
      return { name: 'tools', status: 'passed', message: '模型返回了 provider-native tool_calls。' }
    }
    if (input.check.status === 'warning') {
      return { name: 'tools', status: 'warning', message: '模型响应成功，但本次未返回 tool_call。' }
    }
    if (input.check.status === 'skipped') {
      return {
        name: 'tools',
        status: 'skipped',
        message: httpFailure ? '对话请求失败，未检查工具调用。' : '请求失败，未检查工具调用。',
      }
    }
  }
  if (input.check.name === 'stream' && input.check.status === 'skipped') {
    if (input.result.status === 'passed' || input.result.status === 'warning') {
      return {
        name: 'stream',
        status: 'skipped',
        message: '当前 probe 使用非流式低成本请求；真实运行会继续使用服务端流式 trace。',
      }
    }
    return {
      name: 'stream',
      status: 'skipped',
      message: transportFailure ? '请求失败，未检查流式输出。' : '当前 probe 使用非流式低成本请求。',
    }
  }
  return input.check
}

function toXoxProbeResult(result: OpenAICompatibleProviderProbeResult): ProviderProbeResult {
  return {
    status: result.status,
    provider: result.provider,
    model: result.model,
    checks: result.checks.map((check) => localizeProbeCheck({
      check,
      model: result.model,
      result,
    })),
    message: result.message,
  }
}

export async function probeOpenAICompatibleProvider(input: {
  settings: RuntimePlanningInput['settings']
  timeoutMs?: number
}): Promise<ProviderProbeResult> {
  const provider = input.settings.openaiCompatibleProvider
  const model = input.settings.openaiCompatibleModel
  if (!input.settings.openaiCompatibleApiKey) {
    return missingKeyResult(provider, model)
  }

  return toXoxProbeResult(await probeProviderOpenAICompatibleProvider({
    provider,
    baseUrl: input.settings.openaiCompatibleBaseUrl,
    model,
    apiKey: input.settings.openaiCompatibleApiKey,
    probeTool: PROBE_TOOL,
    probeMessage: '请调用 xox_provider_probe，参数 ok=true。不要输出解释文字。',
    timeoutMs: input.timeoutMs ?? Math.min(input.settings.agentProviderRequestTimeoutMs, 20_000),
    maxTokens: 80,
  }))
}
