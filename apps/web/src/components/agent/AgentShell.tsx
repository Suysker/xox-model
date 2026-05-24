import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentActionRequest, AgentNavigationEvent } from '../../lib/api'
import { useAgentThread } from '../../hooks/useAgentThread'
import { AgentConsole } from './AgentConsole'
import {
  FALLBACK_VIEWPORT,
  type AgentShellLayoutMode,
  type AgentShellLayoutPreference,
  type AgentShellViewport,
  clampBottomDrawerHeight,
  clampSidePanelWidth,
  defaultBottomDrawerHeight,
  defaultSidePanelWidth,
  effectiveAgentShellLayoutMode,
  readAgentShellLayoutPreference,
  writeAgentShellLayoutPreference,
} from './agentShellLayout'

type DragTarget = 'bottomDrawer' | 'sidePanel' | null

function currentViewport(): AgentShellViewport {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT
  return {
    width: window.innerWidth || FALLBACK_VIEWPORT.width,
    height: window.innerHeight || FALLBACK_VIEWPORT.height,
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function bottomInsetPx(viewport: AgentShellViewport) {
  return viewport.width >= 768 ? 24 : 12
}

export function AgentShell(props: {
  children: ReactNode
  onNavigate: (event: AgentNavigationEvent) => void
  onActionExecuted: (action: AgentActionRequest) => Promise<void> | void
}) {
  const agent = useAgentThread({
    onNavigate: props.onNavigate,
    onActionExecuted: props.onActionExecuted,
  })
  const [viewport, setViewport] = useState<AgentShellViewport>(() => currentViewport())
  const [layoutPreference, setLayoutPreference] = useState<AgentShellLayoutPreference>(() =>
    readAgentShellLayoutPreference(safeLocalStorage(), currentViewport()),
  )
  const [dragTarget, setDragTarget] = useState<DragTarget>(null)

  useEffect(() => {
    const handleResize = () => setViewport(currentViewport())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  function updateLayoutPreference(updater: (current: AgentShellLayoutPreference) => AgentShellLayoutPreference) {
    setLayoutPreference((current) => {
      const next = updater(current)
      writeAgentShellLayoutPreference(safeLocalStorage(), next)
      return next
    })
  }

  const effectiveMode = effectiveAgentShellLayoutMode(layoutPreference.mode, viewport)
  const bottomHeight = useMemo(
    () => clampBottomDrawerHeight(layoutPreference.bottomHeightPx, viewport),
    [layoutPreference.bottomHeightPx, viewport],
  )
  const sideWidth = useMemo(
    () => clampSidePanelWidth(layoutPreference.sideWidthPx, viewport),
    [layoutPreference.sideWidthPx, viewport],
  )

  useEffect(() => {
    if (!dragTarget) return undefined
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = dragTarget === 'bottomDrawer' ? 'ns-resize' : 'ew-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault()
      updateLayoutPreference((current) => {
        if (dragTarget === 'bottomDrawer') {
          return {
            ...current,
            bottomHeightPx: clampBottomDrawerHeight(viewport.height - event.clientY - bottomInsetPx(viewport), viewport),
          }
        }
        return {
          ...current,
          sideWidthPx: clampSidePanelWidth(viewport.width - event.clientX, viewport),
        }
      })
    }
    const handlePointerUp = () => setDragTarget(null)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragTarget, viewport])

  function setLayoutMode(mode: AgentShellLayoutMode) {
    updateLayoutPreference((current) => ({ ...current, mode }))
  }

  function resizeBottomDrawer(delta: number) {
    updateLayoutPreference((current) => ({
      ...current,
      bottomHeightPx: clampBottomDrawerHeight(bottomHeight + delta, viewport),
    }))
  }

  function resizeSidePanel(delta: number) {
    updateLayoutPreference((current) => ({
      ...current,
      sideWidthPx: clampSidePanelWidth(sideWidth + delta, viewport),
    }))
  }

  function handleBottomResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    resizeBottomDrawer(event.key === 'ArrowUp' ? 20 : -20)
  }

  function handleSideResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    resizeSidePanel(event.key === 'ArrowLeft' ? 20 : -20)
  }

  const consoleProps = {
    threadId: agent.threadId,
    planner: agent.planner,
    transcriptNodes: agent.transcriptNodes,
    memories: agent.memories,
    providerSetting: agent.providerSetting,
    providerProbe: agent.providerProbe,
    threadSummaries: agent.threadSummaries,
    runningRunId: agent.runningRunId,
    eventConnectionMode: agent.eventConnectionMode,
    automationLevel: agent.automationLevel,
    layoutMode: effectiveMode,
    surface: effectiveMode === 'sidePanel' ? 'side' as const : 'drawer' as const,
    busy: agent.busy,
    error: agent.error,
    onLayoutModeChange: setLayoutMode,
    onSend: (message: string) => void agent.sendMessage(message),
    onCancelRun: () => void agent.cancelRun(),
    onConfirm: (id: string) => void agent.confirmAction(id),
    onCancel: (id: string) => void agent.cancelAction(id),
    onUpdate: (id: string, payload: Parameters<typeof agent.updateAction>[1]) => void agent.updateAction(id, payload),
    onSelectThread: (id: string) => void agent.loadThread(id),
    onNewThread: agent.startNewThread,
    onRefreshThreads: () => void agent.refreshThreads(),
    onRefreshMemories: (query?: string) => void agent.refreshMemories(query),
    onDeleteMemory: (id: string) => void agent.deleteMemory(id),
    onRefreshProviderSetting: () => void agent.refreshProviderSetting(),
    onAutomationLevelChange: agent.setAutomationLevel,
    onSaveProviderSetting: (payload: Parameters<typeof agent.saveProviderSetting>[0]) => agent.saveProviderSetting(payload),
    onProbeProviderSetting: (payload: Parameters<typeof agent.probeProviderSetting>[0]) => agent.probeProviderSetting(payload),
    onDeleteProviderSetting: () => void agent.deleteProviderSetting(),
  }

  if (effectiveMode === 'sidePanel') {
    return (
      <div className="flex min-h-screen bg-stone-100">
        <main className="min-w-0 flex-1 overflow-x-hidden">
          {props.children}
        </main>
        <aside className="sticky top-0 h-screen shrink-0" style={{ width: sideWidth }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={clampSidePanelWidth(0, viewport)}
            aria-valuemax={clampSidePanelWidth(Number.MAX_SAFE_INTEGER, viewport)}
            aria-valuenow={sideWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault()
              setDragTarget('sidePanel')
            }}
            onKeyDown={handleSideResizeKey}
            onDoubleClick={() => updateLayoutPreference((current) => ({ ...current, sideWidthPx: defaultSidePanelWidth(viewport) }))}
            className="absolute left-0 top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize outline-none focus-visible:bg-emerald-500/10"
            title="拖动调整 Agent 宽度"
          >
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-stone-200" />
          </div>
          <AgentConsole {...consoleProps} />
        </aside>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-stone-100">
      <main>
        {props.children}
      </main>
      <section className="fixed inset-x-3 bottom-3 z-50 md:inset-x-6" style={{ height: bottomHeight }}>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={clampBottomDrawerHeight(0, viewport)}
          aria-valuemax={clampBottomDrawerHeight(Number.MAX_SAFE_INTEGER, viewport)}
          aria-valuenow={bottomHeight}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault()
            setDragTarget('bottomDrawer')
          }}
          onKeyDown={handleBottomResizeKey}
          onDoubleClick={() => updateLayoutPreference((current) => ({ ...current, bottomHeightPx: defaultBottomDrawerHeight(viewport) }))}
          className="absolute inset-x-0 -top-3 z-10 h-5 cursor-ns-resize outline-none focus-visible:bg-emerald-500/10"
          title="拖动调整 Agent 高度"
        >
          <span className="absolute left-1/2 top-2 h-1 w-12 -translate-x-1/2 rounded-full bg-stone-300 shadow-sm" />
        </div>
        <AgentConsole {...consoleProps} />
      </section>
    </div>
  )
}
