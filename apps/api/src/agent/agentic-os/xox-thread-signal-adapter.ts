import { AgentServerSignalBus, type AgentServerSignal } from '@agentic-os/server'

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

const threadSignalBus = new AgentServerSignalBus<AgentThreadEventReason>()

function toThreadSignal(signal: AgentServerSignal<AgentThreadEventReason>): AgentThreadEventSignal {
  return {
    threadId: signal.topicId,
    sequence: signal.sequence,
    reason: signal.reason,
  }
}

export const agentThreadEvents = {
  subscribe(threadId: string, listener: AgentThreadEventListener) {
    return threadSignalBus.subscribe(threadId, (signal) => listener(toThreadSignal(signal)))
  },
  publish(threadId: string, reason: AgentThreadEventReason) {
    return toThreadSignal(threadSignalBus.publish(threadId, reason))
  },
  listenerCount(threadId: string) {
    return threadSignalBus.listenerCount(threadId)
  },
}
