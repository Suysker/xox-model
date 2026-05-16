export type AgentThreadEventReason =
  | 'thread_started'
  | 'plan_ready'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'run_trace'
  | 'action_executed'
  | 'action_cancelled'
  | 'action_updated'
  | 'thread_restored'

export type AgentThreadEventSignal = {
  threadId: string
  sequence: number
  reason: AgentThreadEventReason
}

type AgentThreadEventListener = (event: AgentThreadEventSignal) => void

export class AgentThreadEventBroker {
  private sequence = 0
  private readonly listeners = new Map<string, Set<AgentThreadEventListener>>()

  subscribe(threadId: string, listener: AgentThreadEventListener) {
    const listeners = this.listeners.get(threadId) ?? new Set<AgentThreadEventListener>()
    listeners.add(listener)
    this.listeners.set(threadId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(threadId)
    }
  }

  publish(threadId: string, reason: AgentThreadEventReason) {
    this.sequence += 1
    const event = { threadId, sequence: this.sequence, reason }
    const listeners = this.listeners.get(threadId)
    if (!listeners) return event
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        listeners.delete(listener)
      }
    }
    if (listeners.size === 0) this.listeners.delete(threadId)
    return event
  }

  listenerCount(threadId: string) {
    return this.listeners.get(threadId)?.size ?? 0
  }
}

export const agentThreadEvents = new AgentThreadEventBroker()
