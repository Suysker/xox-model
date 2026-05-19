import { useEffect, useRef, useState } from 'react'
import {
  api,
  type AgentActionRequest,
  type AgentActionUpdatePayload,
  type AgentAutomationLevel,
  type AgentEvaluationResult,
  type AgentGoalRecord,
  type AgentMemoryRecord,
  type AgentMessage,
  type AgentNavigationEvent,
  type AgentPlanStep,
  type AgentProviderProbePayload,
  type AgentProviderProbeResult,
  type AgentProviderSettingRecord,
  type AgentProviderSettingUpdatePayload,
  type AgentRunEvent,
  type AgentSendResponse,
  type AgentThreadEvent,
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

export function takeUnreplayedNavigationEvents(input: {
  threadId: string
  runId: string | null
  navigationEvents: AgentNavigationEvent[]
  replayedKeys: Set<string>
}) {
  const runKey = input.runId ?? 'no-run'
  const nextEvents: AgentNavigationEvent[] = []
  input.navigationEvents.forEach((navigation, index) => {
    const key = `${input.threadId}:${runKey}:${index}:${JSON.stringify(navigation)}`
    if (input.replayedKeys.has(key)) return
    input.replayedKeys.add(key)
    nextEvents.push(navigation)
  })
  return nextEvents
}

export function useAgentThread(props: {
  onNavigate: (event: AgentNavigationEvent) => void
  onActionExecuted: (action: AgentActionRequest) => Promise<void> | void
}) {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [actionRequests, setActionRequests] = useState<AgentActionRequest[]>([])
  const [planSteps, setPlanSteps] = useState<AgentPlanStep[]>([])
  const [runEvents, setRunEvents] = useState<AgentRunEvent[]>([])
  const [goals, setGoals] = useState<AgentGoalRecord[]>([])
  const [evaluations, setEvaluations] = useState<AgentEvaluationResult[]>([])
  const [navigationEvents, setNavigationEvents] = useState<AgentNavigationEvent[]>([])
  const [planner, setPlanner] = useState<AgentSendResponse['planner'] | null>(null)
  const [memories, setMemories] = useState<AgentMemoryRecord[]>([])
  const [providerSetting, setProviderSetting] = useState<AgentProviderSettingRecord | null>(null)
  const [providerProbe, setProviderProbe] = useState<AgentProviderProbeResult | null>(null)
  const [threadSummaries, setThreadSummaries] = useState<AgentThreadSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [runningRunId, setRunningRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [automationLevel, setAutomationLevel] = useState<AgentAutomationLevel>('manual')
  const [eventConnectionMode, setEventConnectionMode] = useState<'idle' | 'connecting' | 'sse' | 'polling'>('idle')
  const replayedNavigationKeys = useRef(new Set<string>())

  function applyThreadState(state: AgentThreadState, replayNavigation: boolean) {
    const latestRun = state.runs[0] ?? null
    setThreadId(state.thread.id)
    setMessages(state.messages)
    setActionRequests(state.actionRequests)
    setPlanSteps(state.planSteps)
    setRunEvents(state.runEvents)
    setGoals(state.goals)
    setEvaluations(state.evaluations)
    setNavigationEvents(state.navigationEvents)
    setPlanner(state.planner)
    setRunningRunId(latestRun?.status === 'running' ? latestRun.id : null)
    writeCurrentThreadId(state.thread.id)
    if (replayNavigation) {
      takeUnreplayedNavigationEvents({
        threadId: state.thread.id,
        runId: latestRun?.id ?? null,
        navigationEvents: state.navigationEvents,
        replayedKeys: replayedNavigationKeys.current,
      }).forEach(props.onNavigate)
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

  async function refreshProviderSetting() {
    try {
      const response = await api.getAgentProviderSetting()
      setProviderSetting(response.setting)
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : String(providerError))
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
      await Promise.all([refreshMemories(), refreshThreads(), refreshProviderSetting()])
      const storedThreadId = readCurrentThreadId()
      if (storedThreadId) {
        await loadThread(storedThreadId, true)
      }
    }
    void bootstrapAgentState()
  }, [])

  useEffect(() => {
    if (!threadId || !runningRunId) return
    if (eventConnectionMode === 'connecting' || eventConnectionMode === 'sse') return

    let active = true
    setEventConnectionMode('polling')

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
  }, [threadId, runningRunId, eventConnectionMode])

  useEffect(() => {
    if (!threadId) {
      setEventConnectionMode('idle')
      return
    }
    if (typeof globalThis.EventSource !== 'function') {
      setEventConnectionMode(runningRunId ? 'polling' : 'idle')
      return
    }

    let active = true
    const source = new globalThis.EventSource(api.agentThreadEventsPath(threadId), { withCredentials: true })
    setEventConnectionMode('connecting')

    source.onopen = () => {
      if (active) setEventConnectionMode('sse')
    }

    source.addEventListener('thread_state', (event) => {
      if (!active) return
      try {
        const payload = JSON.parse(event.data) as AgentThreadEvent
        if (payload.threadId !== threadId) return
        const latestRun = payload.state.runs[0] ?? null
        applyThreadState(payload.state, true)
        if (latestRun?.status !== 'running') {
          void refreshMemories()
          void refreshThreads()
        }
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : String(parseError))
      }
    })

    source.onerror = () => {
      if (!active) return
      source.close()
      setEventConnectionMode('polling')
    }

    return () => {
      active = false
      source.close()
      setEventConnectionMode('idle')
    }
  }, [threadId])

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
      const response = await api.sendAgentMessage({ threadId, message, background: true, automationLevel })
      setThreadId(response.threadId)
      writeCurrentThreadId(response.threadId)
      setPlanner(response.planner)
      setMessages((current) => [...current.filter((item) => item.id !== optimisticId), ...response.messages])
      setActionRequests(response.actionRequests)
      setPlanSteps(response.planSteps)
      setRunEvents(response.runEvents)
      setGoals([])
      setEvaluations([])
      setNavigationEvents(response.navigationEvents)
      setRunningRunId(response.status === 'running' ? response.runId : null)
      takeUnreplayedNavigationEvents({
        threadId: response.threadId,
        runId: response.runId,
        navigationEvents: response.navigationEvents,
        replayedKeys: replayedNavigationKeys.current,
      }).forEach(props.onNavigate)
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
      setRunEvents(response.runEvents)
      setMessages((current) => [...current, ...response.messages])
      const state = await api.getAgentThread(response.actionRequest.threadId)
      applyThreadState(state, false)
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
      setRunEvents(response.runEvents)
      setMessages((current) => [...current, ...response.messages])
      const state = await api.getAgentThread(response.actionRequest.threadId)
      applyThreadState(state, false)
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
      setRunEvents(response.runEvents)
      const state = await api.getAgentThread(response.actionRequest.threadId)
      applyThreadState(state, false)
      void refreshThreads()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setBusy(false)
    }
  }

  function startNewThread() {
    writeCurrentThreadId(null)
    replayedNavigationKeys.current.clear()
    setThreadId(null)
    setMessages([])
    setActionRequests([])
    setPlanSteps([])
    setRunEvents([])
    setGoals([])
    setEvaluations([])
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

  async function saveProviderSetting(payload: AgentProviderSettingUpdatePayload) {
    setBusy(true)
    setError(null)
    try {
      const response = await api.updateAgentProviderSetting(payload)
      setProviderSetting(response.setting)
      setProviderProbe(null)
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : String(providerError))
      throw providerError
    } finally {
      setBusy(false)
    }
  }

  async function deleteProviderSetting() {
    setBusy(true)
    setError(null)
    try {
      await api.deleteAgentProviderSetting()
      setProviderSetting(null)
      setProviderProbe(null)
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : String(providerError))
    } finally {
      setBusy(false)
    }
  }

  async function probeProviderSetting(payload: AgentProviderProbePayload) {
    setBusy(true)
    setError(null)
    try {
      const response = await api.probeAgentProviderSetting(payload)
      setProviderProbe(response.probe)
      return response.probe
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : String(providerError))
      throw providerError
    } finally {
      setBusy(false)
    }
  }

  return {
    threadId,
    messages,
    actionRequests,
    planSteps,
    runEvents,
    goals,
    evaluations,
    navigationEvents,
    planner,
    memories,
    providerSetting,
    providerProbe,
    threadSummaries,
    runningRunId,
    eventConnectionMode,
    automationLevel,
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
    refreshProviderSetting,
    setAutomationLevel,
    deleteMemory,
    saveProviderSetting,
    probeProviderSetting,
    deleteProviderSetting,
  }
}
