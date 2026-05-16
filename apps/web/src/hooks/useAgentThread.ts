import { useEffect, useState } from 'react'
import {
  api,
  type AgentActionRequest,
  type AgentActionUpdatePayload,
  type AgentMemoryRecord,
  type AgentMessage,
  type AgentNavigationEvent,
  type AgentPlanStep,
  type AgentSendResponse,
  type AgentThreadState,
  type AgentThreadSummary,
} from '../lib/api'

const CURRENT_THREAD_STORAGE_KEY = 'xox.agent.currentThreadId'

function readCurrentThreadId() {
  try {
    return globalThis.localStorage?.getItem(CURRENT_THREAD_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function writeCurrentThreadId(threadId: string | null) {
  try {
    if (threadId) {
      globalThis.localStorage?.setItem(CURRENT_THREAD_STORAGE_KEY, threadId)
    } else {
      globalThis.localStorage?.removeItem(CURRENT_THREAD_STORAGE_KEY)
    }
  } catch {
    // localStorage is only a recoverable pointer; server state remains authoritative.
  }
}

export function useAgentThread(props: {
  onNavigate: (event: AgentNavigationEvent) => void
  onActionExecuted: (action: AgentActionRequest) => Promise<void> | void
}) {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [actionRequests, setActionRequests] = useState<AgentActionRequest[]>([])
  const [planSteps, setPlanSteps] = useState<AgentPlanStep[]>([])
  const [navigationEvents, setNavigationEvents] = useState<AgentNavigationEvent[]>([])
  const [planner, setPlanner] = useState<AgentSendResponse['planner'] | null>(null)
  const [memories, setMemories] = useState<AgentMemoryRecord[]>([])
  const [threadSummaries, setThreadSummaries] = useState<AgentThreadSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [runningRunId, setRunningRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function applyThreadState(state: AgentThreadState, replayNavigation: boolean) {
    const latestRun = state.runs[0] ?? null
    setThreadId(state.thread.id)
    setMessages(state.messages)
    setActionRequests(state.actionRequests)
    setPlanSteps(state.planSteps)
    setNavigationEvents(state.navigationEvents)
    setPlanner(state.planner)
    setRunningRunId(latestRun?.status === 'running' ? latestRun.id : null)
    writeCurrentThreadId(state.thread.id)
    if (replayNavigation) {
      const latestNavigation = state.navigationEvents.at(-1)
      if (latestNavigation) props.onNavigate(latestNavigation)
    }
  }

  async function refreshMemories() {
    try {
      const response = await api.listAgentMemories()
      setMemories(response.memories)
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : String(memoryError))
    }
  }

  async function refreshThreads() {
    try {
      const response = await api.listAgentThreads()
      setThreadSummaries(response.threads)
    } catch (threadsError) {
      setError(threadsError instanceof Error ? threadsError.message : String(threadsError))
    }
  }

  async function loadThread(nextThreadId: string, replayNavigation = true) {
    setBusy(true)
    setError(null)
    try {
      const state = await api.getAgentThread(nextThreadId)
      applyThreadState(state, replayNavigation)
      void refreshThreads()
    } catch (loadError) {
      if (nextThreadId === readCurrentThreadId()) writeCurrentThreadId(null)
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    async function bootstrapAgentState() {
      await Promise.all([refreshMemories(), refreshThreads()])
      const storedThreadId = readCurrentThreadId()
      if (storedThreadId) {
        await loadThread(storedThreadId, true)
      }
    }
    void bootstrapAgentState()
  }, [])

  useEffect(() => {
    if (!threadId || !runningRunId) return

    let active = true

    async function pollThreadState() {
      try {
        const state = await api.getAgentThread(threadId!)
        if (!active) return
        const latestRun = state.runs[0] ?? null
        applyThreadState(state, latestRun?.status !== 'running')
        if (latestRun?.status !== 'running') {
          void refreshMemories()
          void refreshThreads()
        }
      } catch (pollError) {
        if (active) setError(pollError instanceof Error ? pollError.message : String(pollError))
      }
    }

    void pollThreadState()
    const timer = globalThis.setInterval(() => void pollThreadState(), 1500)
    return () => {
      active = false
      globalThis.clearInterval(timer)
    }
  }, [threadId, runningRunId])

  function mergeActions(nextActions: AgentActionRequest[]) {
    setActionRequests((current) => {
      const byId = new Map(current.map((action) => [action.id, action]))
      nextActions.forEach((action) => byId.set(action.id, action))
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    })
  }

  async function sendMessage(content: string) {
    const message = content.trim()
    if (!message) return

    setBusy(true)
    setError(null)
    const optimisticId = `local-${Date.now()}`
    const optimisticMessage: AgentMessage = {
      id: optimisticId,
      threadId: threadId ?? 'pending',
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    }
    setMessages((current) => [...current, optimisticMessage])
    try {
      const response = await api.sendAgentMessage({ threadId, message, background: true })
      setThreadId(response.threadId)
      writeCurrentThreadId(response.threadId)
      setPlanner(response.planner)
      setMessages((current) => [...current.filter((item) => item.id !== optimisticId), ...response.messages])
      setActionRequests(response.actionRequests)
      setPlanSteps(response.planSteps)
      setNavigationEvents(response.navigationEvents)
      setRunningRunId(response.status === 'running' ? response.runId : null)
      response.navigationEvents.forEach(props.onNavigate)
      void refreshMemories()
      void refreshThreads()
    } catch (sendError) {
      setMessages((current) => current.filter((item) => item.id !== optimisticId))
      setError(sendError instanceof Error ? sendError.message : String(sendError))
    } finally {
      setBusy(false)
    }
  }

  async function confirmAction(actionId: string) {
    setBusy(true)
    setError(null)
    try {
      const response = await api.confirmAgentAction(actionId)
      mergeActions([response.actionRequest])
      setPlanSteps(response.planSteps)
      setMessages((current) => [...current, ...response.messages])
      await props.onActionExecuted(response.actionRequest)
      void refreshMemories()
      void refreshThreads()
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : String(confirmError))
    } finally {
      setBusy(false)
    }
  }

  async function cancelAction(actionId: string) {
    setBusy(true)
    setError(null)
    try {
      const response = await api.cancelAgentAction(actionId)
      mergeActions([response.actionRequest])
      setPlanSteps(response.planSteps)
      setMessages((current) => [...current, ...response.messages])
      void refreshThreads()
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setBusy(false)
    }
  }

  async function cancelRun() {
    if (!runningRunId) return
    setBusy(true)
    setError(null)
    try {
      const state = await api.cancelAgentRun(runningRunId)
      applyThreadState(state, false)
      void refreshThreads()
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setBusy(false)
    }
  }

  async function updateAction(actionId: string, payload: AgentActionUpdatePayload) {
    setBusy(true)
    setError(null)
    try {
      const response = await api.updateAgentAction(actionId, payload)
      mergeActions([response.actionRequest])
      setPlanSteps(response.planSteps)
      void refreshThreads()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setBusy(false)
    }
  }

  function startNewThread() {
    writeCurrentThreadId(null)
    setThreadId(null)
    setMessages([])
    setActionRequests([])
    setPlanSteps([])
    setNavigationEvents([])
    setPlanner(null)
    setRunningRunId(null)
    setError(null)
    void refreshMemories()
    void refreshThreads()
  }

  async function deleteMemory(memoryId: string) {
    setBusy(true)
    setError(null)
    try {
      await api.deleteAgentMemory(memoryId)
      await refreshMemories()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    } finally {
      setBusy(false)
    }
  }

  return {
    threadId,
    messages,
    actionRequests,
    planSteps,
    navigationEvents,
    planner,
    memories,
    threadSummaries,
    runningRunId,
    busy: busy || Boolean(runningRunId),
    error,
    sendMessage,
    confirmAction,
    cancelAction,
    cancelRun,
    updateAction,
    loadThread,
    startNewThread,
    refreshMemories,
    refreshThreads,
    deleteMemory,
  }
}
