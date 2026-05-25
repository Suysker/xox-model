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

function threadSummary(index: number): AgentConsoleProps['threadSummaries'][number] {
  return {
    id: `thread-${index}`,
    title: `历史任务 ${index}`,
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    lastMessage: `第 ${index} 条历史摘要`,
    lastMessageAt: '2026-05-24T00:00:00.000Z',
    latestRunStatus: 'completed',
    planner: 'openai_compatible_tool_calls',
    pendingActionCount: 0,
  }
}

function memoryRecord(index: number): AgentConsoleProps['memories'][number] {
  return {
    id: `memory-${index}`,
    workspaceId: 'workspace-1',
    userId: 'user-1',
    threadId: null,
    kind: 'agent_run',
    scopeType: 'workspace',
    memoryType: 'episodic',
    status: 'active',
    key: `memory.${index}`,
    value: `记忆内容 ${index}`,
    confidence: 0.8,
    evidence: { runId: `run-${index}` },
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
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

  it('lets history and memory panels fill the available conversation space', () => {
    const rendered = renderConsole(props({
      threadSummaries: [threadSummary(1), threadSummary(2), threadSummary(3)],
      memories: [memoryRecord(1), memoryRecord(2), memoryRecord(3)],
    }))
    try {
      const historyButton = rendered.container.querySelector('button[title="历史对话"]') as HTMLButtonElement | null
      const memoryButton = rendered.container.querySelector('button[title="记忆"]') as HTMLButtonElement | null
      if (!historyButton || !memoryButton) throw new Error('panel buttons missing')

      act(() => historyButton.click())
      act(() => memoryButton.click())

      const panelRegion = rendered.container.querySelector('[data-testid="agent-utility-panels"]') as HTMLElement | null
      expect(panelRegion).not.toBeNull()
      expect(panelRegion?.className).toContain('flex-1')
      expect(panelRegion?.style.gridTemplateRows).toContain('minmax(0, 1fr)')
      expect(rendered.container.querySelector('[data-testid="agent-history-panel"]')?.className).toContain('min-h-0')
      expect(rendered.container.querySelector('[data-testid="agent-memory-panel"]')?.className).toContain('min-h-0')
      expect(rendered.container.innerHTML).not.toContain('max-h-28')
      expect(rendered.container.innerHTML).not.toContain('max-h-24')
      expect(rendered.container.querySelector('textarea')?.getAttribute('placeholder')).toBe('输入指令')
    } finally {
      rendered.cleanup()
    }
  })
})
