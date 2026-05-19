import type { RuntimePlanningInput, RuntimePlanError, RuntimePlanResult } from './runtime-adapter.js'

function selectedToolFromError(input: RuntimePlanningInput, error?: RuntimePlanError) {
  return error?.toolNames?.find((name) =>
    input.tools.some((tool) => tool.function.name === name),
  )
}

function isRecoverableHttpError(error?: RuntimePlanError) {
  return error?.kind === 'provider_http_error' && error.classification === 'server'
}

export function shouldRetryRuntimePlan(result: RuntimePlanResult | null | undefined) {
  return result?.error?.kind === 'provider_network_error' ||
    result?.error?.kind === 'provider_response_error' ||
    result?.error?.kind === 'provider_timeout' ||
    isRecoverableHttpError(result?.error)
}

export function retryRuntimeInput(
  input: RuntimePlanningInput,
  result: RuntimePlanResult | null | undefined,
): RuntimePlanningInput {
  if (result?.error?.kind !== 'provider_response_error' && result?.error?.kind !== 'provider_timeout') {
    return input
  }
  const selectedToolName = selectedToolFromError(input, result.error)
  if (!selectedToolName) {
    return {
      ...input,
      stream: false,
      requestTimeoutMs: Math.max(input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs, 240_000),
    }
  }
  const selectedTool = input.tools.find((tool) => tool.function.name === selectedToolName)
  return {
    ...input,
    stream: false,
    tools: selectedTool ? [selectedTool] : input.tools,
    maxTokens: Math.max(input.maxTokens ?? 1600, 12_000),
    requestTimeoutMs: Math.max(input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs, 240_000),
  }
}

export function retryRuntimeMessage(error?: RuntimePlanError) {
  if (error?.kind === 'provider_response_error') {
    return '模型服务返回的流式工具调用不可解析，正在改用非流式请求对同一轮规划重试一次。'
  }
  if (error?.kind === 'provider_timeout') {
    return '模型服务响应超时，正在用更稳的同轮规划请求重试一次。'
  }
  if (isRecoverableHttpError(error)) {
    return '模型服务返回临时服务错误，正在对同一轮规划重试一次。'
  }
  return '模型服务连接中断，正在对同一轮规划重试一次。'
}
