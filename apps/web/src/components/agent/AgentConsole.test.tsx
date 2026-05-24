// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgentConsole } from './AgentConsole'
import type { AgentTranscriptNode } from '../../lib/api'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type AgentConsoleProps = ComponentProps<typeof AgentConsole>

function node(overrides: Partial<AgentTranscriptNode> = {}): AgentTranscriptNode {
  return {
    id: overrides.id ?? 'node-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sequence: overrides.sequence ?? 1,
    kind: overrides.kind ?? 'assistant_message',
    title: overrides.title ?? '回复',
    summary: overrides.summary ?? '你好',
    content: overrides.content ?? overrides.summary ?? '你好',
    status: overrides.status ?? 'completed',
    visibility: overrides.visibility ?? 'user',
    createdAt: overrides.createdAt ?? '2026-05-24T00:00:00.000Z',
    ...overrides,
  }
}

function props(overrides: Partial<AgentConsoleProps> = {}): AgentConsoleProps {
  return {
    threadId: 'thread-1',
    planner: null,
    transcriptNodes: [node()],
    memories: [],
    providerSetting: null,
    providerProbe: null,
    threadSummaries: [],
    runningRunId: null,
    eventConnectionMode: 'idle',
    automationLevel: 'manual',
    layoutMode: 'bottomDrawer',
    surface: 'drawer',
    conversationOpen: true,
    busy: false,
    error: null,
    onLayoutModeChange: () => undefined,
    onConversationOpenChange: () => undefined,
    onSend: () => undefined,
    onCancelRun: () => undefined,
    onConfirm: () => undefined,
    onCancel: () => undefined,
    onUpdate: () => undefined,
    onSelectThread: () => undefined,
    onNewThread: () => undefined,
    onRefreshThreads: () => undefined,
    onRefreshMemories: () => undefined,
    onDeleteMemory: () => undefined,
    onRefreshProviderSetting: () => undefined,
    onAutomationLevelChange: () => undefined,
    onSaveProviderSetting: () => undefined,
    onProbeProviderSetting: () => undefined,
    onDeleteProviderSetting: () => undefined,
    ...overrides,
  }
}

function renderConsole(componentProps: AgentConsoleProps) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)
  act(() => {
    root?.render(<AgentConsole {...componentProps} />)
  })
  return {
    container,
    cleanup: () => {
      act(() => root?.unmount())
      root = null
      container.remove()
    },
  }
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AgentConsole', () => {
  it('sends on Enter and keeps Shift+Enter for new lines', () => {
    const sent: string[] = []
    const rendered = renderConsole(props({ onSend: (message) => sent.push(message) }))
    try {
      const textarea = rendered.container.querySelector('textarea')
      if (!textarea) throw new Error('textarea missing')

      setTextareaValue(textarea, '第一行')
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(sent).toEqual(['第一行'])

      setTextareaValue(textarea, '第一行\n')
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
      })
      expect(sent).toEqual(['第一行'])
    } finally {
      rendered.cleanup()
    }
  })

  it('can hide the conversation area while keeping the composer visible', () => {
    const rendered = renderConsole(props({ conversationOpen: false }))
    try {
      expect(rendered.container.textContent).not.toContain('你好')
      expect(rendered.container.querySelector('textarea')?.getAttribute('placeholder')).toBe('输入指令')
      expect(rendered.container.querySelector('button[aria-label="展开对话"]')).not.toBeNull()
    } finally {
      rendered.cleanup()
    }
  })
})
