import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { redactSecretLikeContent } from './memory.js'
import { addRunEvent } from './run-events.js'
import type { RuntimeStreamEvent } from './runtime/runtime-adapter.js'

type RuntimeTraceContext = {
  db: Kysely<Database>
  threadId: string
  runId: string
  phase?: 'planning' | 'final_answer'
}

const PROVIDER_STREAM_DELTA_LIMIT = 240
const PROVIDER_STREAM_PREVIEW_LIMIT = 700

function safeProviderStreamValue(value: string, maxLength: number) {
  return redactSecretLikeContent(value).slice(0, maxLength)
}

function runtimeStreamEventPayload(event: RuntimeStreamEvent): Record<string, unknown> {
  if (event.kind === 'stream_started') {
    return {
      kind: event.kind,
      provider: safeProviderStreamValue(event.provider, 80),
      model: safeProviderStreamValue(event.model, 120),
      source: event.source,
      ...(event.requestTimeoutMs ? { requestTimeoutMs: event.requestTimeoutMs } : {}),
    }
  }
  if (event.kind === 'content_delta') {
    return {
      kind: event.kind,
      delta: safeProviderStreamValue(event.delta, PROVIDER_STREAM_DELTA_LIMIT),
      preview: safeProviderStreamValue(event.preview, PROVIDER_STREAM_PREVIEW_LIMIT),
    }
  }
  if (event.kind === 'tool_call_delta') {
    return {
      kind: event.kind,
      toolCallIndex: event.toolCallIndex,
      ...(event.toolName ? { toolName: safeProviderStreamValue(event.toolName, 120) } : {}),
      ...(event.argumentsDelta ? { argumentsDelta: safeProviderStreamValue(event.argumentsDelta, PROVIDER_STREAM_DELTA_LIMIT) } : {}),
      ...(event.argumentsPreview ? { argumentsPreview: safeProviderStreamValue(event.argumentsPreview, PROVIDER_STREAM_PREVIEW_LIMIT) } : {}),
    }
  }
  if (event.kind === 'tool_call_repaired') {
    return {
      kind: event.kind,
      toolName: safeProviderStreamValue(event.toolName, 120),
      ...(event.toolCallId ? { toolCallId: safeProviderStreamValue(event.toolCallId, 120) } : {}),
      leadingChars: event.leadingChars,
      trailingChars: event.trailingChars,
    }
  }
  if (event.kind === 'tool_call_damage') {
    return {
      kind: event.kind,
      toolCallIndex: event.toolCallIndex,
      ...(event.toolName ? { toolName: safeProviderStreamValue(event.toolName, 120) } : {}),
      boundaryCode: event.boundaryCode,
      message: safeProviderStreamValue(event.message, PROVIDER_STREAM_PREVIEW_LIMIT),
      retryable: event.retryable,
    }
  }
  return {
    kind: event.kind,
    contentLength: event.contentLength,
    toolCallCount: event.toolCallCount,
    ...(event.source ? { source: event.source } : {}),
  }
}

export async function addRuntimeStreamRunEvent(ctx: RuntimeTraceContext, event: RuntimeStreamEvent) {
  const data: Record<string, unknown> = {
    ...runtimeStreamEventPayload(event),
    ...(ctx.phase ? { phase: ctx.phase } : {}),
  }
  if (event.kind === 'stream_started') {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stream_started',
      channel: 'lifecycle',
      title: 'Provider 流已打开',
      message: `正在接收 ${data.provider} / ${data.model} 的流式输出。`,
      status: 'running',
      data,
    })
    return
  }
  if (event.kind === 'content_delta') {
    const delta = typeof data.delta === 'string' && data.delta.trim().length > 0 ? data.delta : '正在输出回答内容。'
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stream_delta',
      channel: 'assistant',
      title: '模型输出片段',
      message: delta,
      status: 'running',
      data,
    })
    return
  }
  if (event.kind === 'tool_call_delta') {
    const toolName = typeof data.toolName === 'string' ? data.toolName : '工具调用'
    const preview = typeof data.argumentsPreview === 'string' && data.argumentsPreview.trim().length > 0
      ? data.argumentsPreview
      : '正在组装工具参数。'
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stream_delta',
      channel: 'tool',
      title: '工具调用片段',
      message: `${toolName}: ${preview}`,
      status: 'running',
      data,
    })
    return
  }
  if (event.kind === 'tool_call_repaired') {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_tool_call_repaired',
      channel: 'tool',
      title: '工具调用参数已修复',
      message: `${data.toolName} 的流式参数包含 provider 污染片段，已在有界范围内提取完整 JSON。`,
      status: 'info',
      data,
    })
    return
  }
  if (event.kind === 'tool_call_damage') {
    const toolName = typeof data.toolName === 'string' ? data.toolName : '工具调用'
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_tool_call_damage',
      channel: 'tool',
      title: '工具调用帧不可执行',
      message: `${toolName}: ${data.message}`,
      status: event.retryable ? 'running' : 'failed',
      data,
    })
    return
  }
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'provider_stream_completed',
    channel: 'lifecycle',
    title: 'Provider 流已结束',
    message: `模型流已结束，累计内容 ${event.contentLength} 字符，工具调用 ${event.toolCallCount} 个。`,
    status: 'completed',
    data,
  })
}
