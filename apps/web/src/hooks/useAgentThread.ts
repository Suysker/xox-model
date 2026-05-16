import { useState } from 'react'
import {
  api,
  type AgentActionRequest,
  type AgentActionUpdatePayload,
  type AgentMessage,
  type AgentNavigationEvent,
  type AgentPlanStep,
} from '../lib/api'

export function useAgentThread(props: {
  onNavigate: (event: AgentNavigationEvent) => void
  onActionExecuted: (action: AgentActionRequest) => Promise<void> | void
}) {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [actionRequests, setActionRequests] = useState<AgentActionRequest[]>([])
  const [planSteps, setPlanSteps] = useState<AgentPlanStep[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    try {
      const response = await api.sendAgentMessage({ threadId, message })
      setThreadId(response.threadId)
      setMessages((current) => [...current, ...response.messages])
      mergeActions(response.actionRequests)
      setPlanSteps(response.planSteps)
      response.navigationEvents.forEach(props.onNavigate)
    } catch (sendError) {
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
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setBusy(false)
    }
  }

  return {
    messages,
    actionRequests,
    planSteps,
    busy,
    error,
    sendMessage,
    confirmAction,
    cancelAction,
    updateAction,
  }
}
