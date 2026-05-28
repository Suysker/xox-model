// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgentConsole } from './AgentConsole'
import type { AgentProviderProbeResult, AgentTranscriptNode } from '../../lib/api'

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

function providerProbe(status: AgentProviderProbeResult['status'] = 'passed'): AgentProviderProbeResult {
  return {
    status,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    message: status === 'passed' ? '测试通过' : '测试失败',
    checks: [
      { name: 'auth', status, message: status === 'passed' ? '认证通过' : '认证失败' },
      { name: 'tools', status, message: status === 'passed' ? 'tool_calls 可用' : 'tool_calls 不可用' },
    ],
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
    onProbeProviderSetting: async () => providerProbe('passed'),
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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

  it('keeps the side panel composer at the bottom when conversation is collapsed', () => {
    const rendered = renderConsole(props({
      conversationOpen: false,
      layoutMode: 'sidePanel',
      surface: 'side',
    }))
    try {
      expect(rendered.container.querySelector('[data-testid="agent-side-spacer"]')).not.toBeNull()
      expect(rendered.container.querySelector('[data-testid="agent-side-composer"]')).not.toBeNull()
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

      expect(historyButton.getAttribute('aria-pressed')).toBe('true')
      expect(memoryButton.getAttribute('aria-pressed')).toBe('true')
      const panelRegion = rendered.container.querySelector('[data-testid="agent-utility-panels"]') as HTMLElement | null
      const memoryToolbar = rendered.container.querySelector('[data-testid="agent-memory-toolbar"]') as HTMLElement | null
      expect(panelRegion).not.toBeNull()
      expect(memoryToolbar?.querySelector('input[placeholder="搜索记忆"]')).not.toBeNull()
      expect(memoryToolbar?.querySelector('select[title="按记忆类型过滤"]')).not.toBeNull()
      expect(memoryToolbar?.querySelector('button[title="按关键词刷新记忆"]')).not.toBeNull()
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

  it('expands the conversation when opening history, memory, or provider from collapsed mode', () => {
    const expansionRequests: boolean[] = []
    const rendered = renderConsole(props({
      conversationOpen: false,
      onConversationOpenChange: (open) => expansionRequests.push(open),
    }))
    try {
      const historyButton = rendered.container.querySelector('button[title="历史对话"]') as HTMLButtonElement | null
      const memoryButton = rendered.container.querySelector('button[title="记忆"]') as HTMLButtonElement | null
      const providerButton = rendered.container.querySelector('button[title="模型配置"]') as HTMLButtonElement | null
      if (!historyButton || !memoryButton || !providerButton) throw new Error('utility buttons missing')

      act(() => historyButton.click())
      act(() => memoryButton.click())
      act(() => providerButton.click())

      expect(expansionRequests).toEqual([true, true, true])
      expect(historyButton.getAttribute('aria-pressed')).toBe('true')
      expect(memoryButton.getAttribute('aria-pressed')).toBe('true')
      expect(providerButton.getAttribute('aria-pressed')).toBe('true')
    } finally {
      rendered.cleanup()
    }
  })

  it('uses compact Codex-style chrome in the side panel', () => {
    const automationChanges: AgentConsoleProps['automationLevel'][] = []
    const rendered = renderConsole(props({
      layoutMode: 'sidePanel',
      surface: 'side',
      providerSetting: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        hasApiKey: true,
        updatedAt: '2026-05-24T00:00:00.000Z',
      },
      threadSummaries: [threadSummary(1)],
      memories: [memoryRecord(1)],
      onAutomationLevelChange: (level) => automationChanges.push(level),
    }))
    try {
      const sideHeader = rendered.container.querySelector('[data-testid="agent-side-header"]') as HTMLElement | null
      const sideToolbar = rendered.container.querySelector('[data-testid="agent-side-toolbar"]') as HTMLElement | null
      const sideComposer = rendered.container.querySelector('[data-testid="agent-side-composer"]') as HTMLElement | null
      const sideAutomation = rendered.container.querySelector('[data-testid="agent-side-automation"]') as HTMLElement | null
      expect(sideHeader).not.toBeNull()
      expect(sideToolbar).not.toBeNull()
      expect(sideComposer).not.toBeNull()
      expect(sideAutomation).not.toBeNull()
      expect(sideHeader?.querySelector('button[aria-label="历史对话 1"]')).not.toBeNull()
      expect(sideHeader?.querySelector('button[aria-label="记忆 1"]')).not.toBeNull()
      expect(sideHeader?.querySelector('button[aria-label="模型 deepseek"]')).not.toBeNull()
      expect(sideHeader?.querySelector('button[aria-label="新建对话"]')).not.toBeNull()
      expect(sideComposer?.querySelector('button[aria-label="新建对话"]')).toBeNull()
      expect(sideAutomation?.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
      expect(sideAutomation?.textContent).toContain('手动')
      expect(sideAutomation?.textContent).not.toContain('低')
      const automationButton = sideAutomation?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement | null
      if (!automationButton) throw new Error('automation menu button missing')
      act(() => automationButton.click())
      expect(sideAutomation?.querySelector('[role="menu"]')).not.toBeNull()
      const menuItems = Array.from(sideAutomation?.querySelectorAll('[role="menuitemradio"]') ?? []) as HTMLButtonElement[]
      expect(menuItems).toHaveLength(4)
      act(() => menuItems[3]?.click())
      expect(automationChanges).toEqual(['high'])
      expect(sideComposer?.querySelector('textarea')?.getAttribute('placeholder')).toBe('输入指令')
      expect(sideHeader?.textContent).not.toContain('新对话')
      expect(sideHeader?.textContent).not.toContain('历史 1')
      expect(sideHeader?.textContent).not.toContain('记忆 1')
      expect(sideHeader?.textContent).not.toContain('模型 deepseek')
      expect(rendered.container.textContent).toContain('手动')
    } finally {
      rendered.cleanup()
    }
  })

  it('shows a saved provider key as a password mask without submitting the mask', async () => {
    const probes: unknown[] = []
    const saves: unknown[] = []
    const rendered = renderConsole(props({
      providerSetting: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        hasApiKey: true,
        updatedAt: '2026-05-24T00:00:00.000Z',
      },
      onProbeProviderSetting: async (payload) => {
        probes.push(payload)
        return providerProbe('passed')
      },
      onSaveProviderSetting: async (payload) => {
        saves.push(payload)
      },
    }))
    try {
      const providerButton = rendered.container.querySelector('button[title="模型配置"]') as HTMLButtonElement | null
      if (!providerButton) throw new Error('provider button missing')
      act(() => providerButton.click())

      const apiKeyInput = rendered.container.querySelector('input[type="password"]') as HTMLInputElement | null
      expect(apiKeyInput?.value).toBe('••••••••••••••••')

      const saveButton = Array.from(rendered.container.querySelectorAll('button[type="submit"]'))
        .find((button) => button.textContent?.includes('保存')) as HTMLButtonElement | undefined
      if (!saveButton) throw new Error('save button missing')
      await act(async () => saveButton.click())

      expect(probes).toEqual([{ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }])
      expect(saves).toEqual([{ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }])
      expect(apiKeyInput?.value).toBe('••••••••••••••••')
    } finally {
      rendered.cleanup()
    }
  })

  it('tests a new provider key before saving and blocks failed probes', async () => {
    const saves: unknown[] = []
    const rendered = renderConsole(props({
      providerSetting: null,
      onProbeProviderSetting: async () => providerProbe('failed'),
      onSaveProviderSetting: async (payload) => {
        saves.push(payload)
      },
    }))
    try {
      const providerButton = rendered.container.querySelector('button[title="模型配置"]') as HTMLButtonElement | null
      if (!providerButton) throw new Error('provider button missing')
      act(() => providerButton.click())

      const apiKeyInput = rendered.container.querySelector('input[type="password"]') as HTMLInputElement | null
      if (!apiKeyInput) throw new Error('api key input missing')
      setInputValue(apiKeyInput, 'sk-test')

      const saveButton = Array.from(rendered.container.querySelectorAll('button[type="submit"]'))
        .find((button) => button.textContent?.includes('保存')) as HTMLButtonElement | undefined
      if (!saveButton) throw new Error('save button missing')
      await act(async () => saveButton.click())

      expect(saves).toEqual([])
      expect(apiKeyInput.value).toBe('sk-test')
    } finally {
      rendered.cleanup()
    }
  })
})
