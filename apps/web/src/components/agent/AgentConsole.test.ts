import type { AgentRunEvent } from '../../lib/api'
import { buildProviderStreamPreview } from './AgentConsole'

function buildRunEvent(overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    id: 'run-event-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sequence: 1,
    type: 'provider_stream_delta',
    title: '工具调用片段',
    message: 'ledger_create_entry',
    status: 'running',
    data: null,
    createdAt: '2026-05-17T00:00:00.000Z',
    ...overrides,
  }
}

describe('AgentConsole provider stream preview', () => {
  it('aggregates backend-owned provider content and tool-call deltas', () => {
    const preview = buildProviderStreamPreview([
      buildRunEvent({ id: 'event-1', sequence: 1, type: 'provider_stream_started', data: { kind: 'stream_started', provider: 'deepseek', model: 'deepseek-v4-pro' } }),
      buildRunEvent({ id: 'event-3', sequence: 3, data: { kind: 'tool_call_delta', toolCallIndex: 0, toolName: 'ledger_create_entry', argumentsPreview: '{"monthLabel":"3月"' } }),
      buildRunEvent({ id: 'event-2', sequence: 2, title: '模型输出片段', data: { kind: 'content_delta', delta: '正在', preview: '正在' } }),
      buildRunEvent({ id: 'event-4', sequence: 4, data: { kind: 'tool_call_delta', toolCallIndex: 0, argumentsDelta: ',"amount":176}', argumentsPreview: '{"monthLabel":"3月","amount":176}' } }),
      buildRunEvent({ id: 'event-5', sequence: 5, type: 'provider_stream_completed', status: 'completed', data: { kind: 'stream_completed', contentLength: 2, toolCallCount: 1 } }),
    ])

    expect(preview).toEqual({
      content: '正在',
      completed: true,
      tools: [{
        index: 0,
        name: 'ledger_create_entry',
        argumentsPreview: '{"monthLabel":"3月","amount":176}',
      }],
    })
  })

  it('does not invent stream state when the backend did not emit stream events', () => {
    expect(buildProviderStreamPreview([
      buildRunEvent({ type: 'model_planning', data: null }),
    ])).toBeNull()
  })
})
