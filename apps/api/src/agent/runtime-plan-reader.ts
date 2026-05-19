import type { AgentPlannerSource } from '@xox/contracts'
import type { Settings } from '../core/settings.js'
import { redactSecretLikeContent } from './memory.js'
import type { ReadDraft } from './action-draft-builder.js'
import type { RuntimePlanError, RuntimePlanResult } from './runtime/runtime-adapter.js'

export function configuredRuntimePlannerSource(settings: Settings): Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'> | null {
  if (settings.llmProvider === 'rules') return null
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

function modelToolCallRequiredRead(error?: RuntimePlanError | null): ReadDraft {
  if (error?.kind === 'missing_api_key') {
    return {
      title: '模型 API key 未配置',
      message: '当前已选择真实模型 provider，但没有可用 API key。请在模型配置里重新填写该 provider 的 API key；如果刚从 qwen 切到 DeepSeek，不要留空沿用旧 key。',
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_http_error') {
    const authFailed = error.statusCode === 401 || error.statusCode === 403
    return {
      title: authFailed ? '模型服务认证失败' : '模型服务请求失败',
      message: authFailed
        ? `模型服务认证失败：模型服务返回 HTTP ${error.statusCode}，当前保存的 API key 可能不是这个 provider 的 key，或已经失效。请重新保存 DeepSeek/Qwen/Doubao 对应的 API key。${error.message ? ` Provider 提示：${error.message}` : ''}`
        : `模型服务返回 HTTP ${error.statusCode ?? '错误'}。请检查 base URL、model 名称和 provider 配置。${error.message ? ` Provider 提示：${error.message}` : ''}`,
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_network_error') {
    return {
      title: '无法连接模型服务',
      message: `无法连接当前 provider 的 Chat Completions 接口。请检查 base URL 是否可访问，以及本地代理/网络设置。${error.message ? ` 错误：${error.message}` : ''}`,
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_timeout') {
    return {
      title: '模型服务响应超时',
      message: `当前 provider 在本轮规划预算内没有完成响应。复杂经营模型会自动使用更长预算并重试；如果仍失败，请稍后重试或检查 provider 负载。${error.message ? ` 错误：${error.message}` : ''}`,
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_response_error') {
    return {
      title: '模型响应格式不可用',
      message: `模型服务返回了无法解析的工具调用或流式片段，系统没有生成写入动作。${error.message ? ` 错误：${error.message}` : ''}`,
      status: 'failed',
    }
  }

  return {
    title: '模型没有返回内容',
    message: '模型这轮没有返回可展示内容，也没有调用工具。系统没有生成任何写入动作；请换一种说法重试。',
    status: 'info',
  }
}

function providerAssistantTextRead(text: string): ReadDraft {
  const message = redactSecretLikeContent(text).trim().slice(0, 4000)
  return {
    title: '模型回复',
    message: message || '模型这轮没有返回可展示内容。',
    status: 'executed',
  }
}

export function readDraftFromRuntimeResult(result?: RuntimePlanResult | null): ReadDraft {
  return result?.assistantText
    ? providerAssistantTextRead(result.assistantText)
    : modelToolCallRequiredRead(result?.error)
}
