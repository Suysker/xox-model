import type { AgentMessage, AgentNavigationEvent } from '../lib/api'
import { buildOptimisticUserTranscriptNode, takeUnreplayedNavigationEvents } from './useAgentThread'

function buildNavigation(overrides: Partial<AgentNavigationEvent> = {}): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: 'period-1' },
    panel: null,
    focusRecordId: null,
    reason: '打开记账工作台',
    ...overrides,
  }
}

describe('useAgentThread navigation replay', () => {
  it('replays each server-owned navigation event once for the same run', () => {
    const replayedKeys = new Set<string>()
    const navigation = buildNavigation()

    expect(takeUnreplayedNavigationEvents({
      threadId: 'thread-1',
      runId: 'run-1',
      navigationEvents: [navigation],
      replayedKeys,
    })).toEqual([navigation])

    expect(takeUnreplayedNavigationEvents({
      threadId: 'thread-1',
      runId: 'run-1',
      navigationEvents: [navigation],
      replayedKeys,
    })).toEqual([])
  })

  it('does not suppress the same navigation target in a later run', () => {
    const replayedKeys = new Set<string>()
    const navigation = buildNavigation()

    takeUnreplayedNavigationEvents({
      threadId: 'thread-1',
      runId: 'run-1',
      navigationEvents: [navigation],
      replayedKeys,
    })

    expect(takeUnreplayedNavigationEvents({
      threadId: 'thread-1',
      runId: 'run-2',
      navigationEvents: [navigation],
      replayedKeys,
    })).toEqual([navigation])
  })

  it('keeps duplicate navigation steps distinct within one action graph', () => {
    const replayedKeys = new Set<string>()
    const first = buildNavigation({ reason: '打开记账工作台' })
    const second = buildNavigation({ reason: '再次打开记账工作台' })

    expect(takeUnreplayedNavigationEvents({
      threadId: 'thread-1',
      runId: 'run-1',
      navigationEvents: [first, second],
      replayedKeys,
    })).toEqual([first, second])
  })
})

describe('useAgentThread optimistic transcript', () => {
  it('turns a local user message into a visible transcript row immediately', () => {
    const message: AgentMessage = {
      id: 'local-1',
      threadId: 'pending',
      role: 'user',
      content: '你好',
      createdAt: '2026-05-22T00:00:00.000Z',
    }

    expect(buildOptimisticUserTranscriptNode(message)).toMatchObject({
      id: 'node-timeline-local-1',
      threadId: 'pending',
      runId: null,
      kind: 'user_message',
      summary: '你好',
      content: '你好',
      status: 'completed',
      visibility: 'user',
    })
  })
})
