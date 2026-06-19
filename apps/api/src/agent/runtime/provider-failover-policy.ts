import {
  buildProviderRuntimeRetryPatch,
  isRecoverableProviderHttpRuntimeError,
  shouldRetryProviderRuntimeResult,
} from '@agentic-os/runtime-openai-compatible'
import type { RuntimePlanningInput, RuntimePlanError, RuntimePlanResult } from './runtime-adapter.js'
import {
  HIGH_VOLUME_STRUCTURED_TOOL_NAMES,
  HIGH_VOLUME_STRUCTURED_MAX_TOKENS,
  HIGH_VOLUME_STRUCTURED_TIMEOUT_MS,
} from './high-volume-tool-policy.js'

export function shouldRetryRuntimePlan(result: RuntimePlanResult | null | undefined) {
  return shouldRetryProviderRuntimeResult(result)
}

export function retryRuntimeInput(
  input: RuntimePlanningInput,
  result: RuntimePlanResult | null | undefined,
): RuntimePlanningInput {
  const patch = buildProviderRuntimeRetryPatch({
    availableToolNames: input.tools.map((tool) => tool.function.name),
    baselineMaxTokens: input.maxTokens ?? 1600,
    baselineRequestTimeoutMs: input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs,
    highVolumeToolNames: HIGH_VOLUME_STRUCTURED_TOOL_NAMES,
    highVolumeRetryMaxTokens: HIGH_VOLUME_STRUCTURED_MAX_TOKENS,
    highVolumeRetryTimeoutMs: HIGH_VOLUME_STRUCTURED_TIMEOUT_MS,
    ...(result?.error ? { error: result.error } : {}),
  })
  if (!patch) {
    return input
  }
  const selectedTool = patch.selectedToolName
    ? input.tools.find((tool) => tool.function.name === patch.selectedToolName)
    : undefined
  return {
    ...input,
    stream: patch.stream,
    ...(selectedTool ? { tools: [selectedTool] } : {}),
    ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
    requestTimeoutMs: patch.requestTimeoutMs,
  }
}

export function retryRuntimeMessage(error?: RuntimePlanError) {
  if (error?.kind === 'provider_response_error') {
    if (error.toolCallBoundary?.code === 'tool_call_arguments_truncated') {
      return '模型服务返回的流式工具调用参数不完整，正在改用非流式请求对同一轮规划重试一次。'
    }
    if (error.toolCallBoundary?.code === 'tool_call_stream_interrupted') {
      return '模型服务的工具调用流中断，正在改用非流式请求对同一轮规划重试一次。'
    }
    return '模型服务返回的流式工具调用不可解析，正在改用非流式请求对同一轮规划重试一次。'
  }
  if (error?.kind === 'provider_timeout') {
    return '模型服务响应超时，正在用更稳的同轮规划请求重试一次。'
  }
  if (isRecoverableProviderHttpRuntimeError(error)) {
    return '模型服务返回临时服务错误，正在对同一轮规划重试一次。'
  }
  return '模型服务连接中断，正在对同一轮规划重试一次。'
}
