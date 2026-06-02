import type { ChatTool } from '../tool-catalog.js'
import { classifyProviderHttpError, safeProviderErrorMessage } from './provider-error-classifier.js'
import { shapeOpenAICompatibleChatRequest } from './provider-request-shaper.js'
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

const PROBE_TOOL: ChatTool = {
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

function hasProbeToolCall(body: any) {
  const calls = body?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls) && calls.some((call: any) => call?.function?.name === PROBE_TOOL.function.name)
}

export async function probeOpenAICompatibleProvider(input: {
  settings: RuntimePlanningInput['settings']
  timeoutMs?: number
}): Promise<ProviderProbeResult> {
  const provider = input.settings.openaiCompatibleProvider
  const model = input.settings.openaiCompatibleModel
  const checks: ProviderProbeResult['checks'] = []
  if (!input.settings.openaiCompatibleApiKey) {
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

  const runtimeInput: RuntimePlanningInput = {
    settings: input.settings,
    message: '请调用 xox_provider_probe，参数 ok=true。不要输出解释文字。',
    context: { purpose: 'provider capability probe' },
    tools: [PROBE_TOOL],
    stream: false,
    maxTokens: 80,
    requestTimeoutMs: input.timeoutMs ?? Math.min(input.settings.agentProviderRequestTimeoutMs, 20_000),
  }
  const shaped = shapeOpenAICompatibleChatRequest(runtimeInput, { thinkingLevel: 'off' })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('provider probe timed out')), runtimeInput.requestTimeoutMs)
  timeout.unref?.()
  try {
    const response = await fetch(`${input.settings.openaiCompatibleBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.settings.openaiCompatibleApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(shaped.body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const providerMessage = await response.text().catch(() => response.statusText)
      const error = classifyProviderHttpError(response.status, providerMessage)
      const failedMessage = `HTTP ${response.status}: ${error.message ?? response.statusText}`
      checks.push({ name: 'auth', status: response.status === 401 || response.status === 403 ? 'failed' : 'warning', message: failedMessage })
      checks.push({ name: 'model', status: 'failed', message: failedMessage })
      checks.push({ name: 'chat', status: 'failed', message: failedMessage })
      checks.push({ name: 'tools', status: 'skipped', message: '对话请求失败，未检查工具调用。' })
      checks.push({ name: 'stream', status: 'skipped', message: '当前 probe 使用非流式低成本请求。' })
      return { status: 'failed', provider, model, checks, message: failedMessage }
    }
    const body = await response.json()
    const toolOk = hasProbeToolCall(body)
    checks.push({ name: 'auth', status: 'passed', message: 'API key 可用于当前 provider。' })
    checks.push({ name: 'model', status: 'passed', message: `模型 ${model} 返回了有效响应。` })
    checks.push({ name: 'chat', status: 'passed', message: 'Chat Completions 请求成功。' })
    checks.push({
      name: 'tools',
      status: toolOk ? 'passed' : 'warning',
      message: toolOk ? '模型返回了 provider-native tool_calls。' : '模型响应成功，但本次未返回 tool_call。',
    })
    checks.push({ name: 'stream', status: 'skipped', message: '当前 probe 使用非流式低成本请求；真实运行会继续使用服务端流式 trace。' })
    return {
      status: toolOk ? 'passed' : 'warning',
      provider,
      model,
      checks,
      message: toolOk ? 'Provider probe passed.' : 'Provider probe completed, but tool_calls were not observed.',
    }
  } catch (error) {
    const message = safeProviderErrorMessage(error instanceof Error ? error.message : String(error))
    return {
      status: 'failed',
      provider,
      model,
      checks: [
        { name: 'auth', status: 'warning', message },
        { name: 'model', status: 'failed', message },
        { name: 'chat', status: 'failed', message },
        { name: 'tools', status: 'skipped', message: '请求失败，未检查工具调用。' },
        { name: 'stream', status: 'skipped', message: '请求失败，未检查流式输出。' },
      ],
      message,
    }
  } finally {
    clearTimeout(timeout)
  }
}
