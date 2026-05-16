import type { ReactNode } from 'react'
import type { AgentActionRequest, AgentNavigationEvent } from '../../lib/api'
import { useAgentThread } from '../../hooks/useAgentThread'
import { AgentConsole } from './AgentConsole'

export function AgentShell(props: {
  children: ReactNode
  onNavigate: (event: AgentNavigationEvent) => void
  onActionExecuted: (action: AgentActionRequest) => Promise<void> | void
}) {
  const agent = useAgentThread({
    onNavigate: props.onNavigate,
    onActionExecuted: props.onActionExecuted,
  })

  return (
    <div className="min-h-screen bg-stone-100 pb-[250px]">
      <div
        style={{
          transform: 'scale(0.85)',
          transformOrigin: 'top center',
          width: '117.647%',
          marginLeft: '-8.8235%',
        }}
      >
        {props.children}
      </div>
      <AgentConsole
        threadId={agent.threadId}
        planner={agent.planner}
        messages={agent.messages}
        planSteps={agent.planSteps}
        actionRequests={agent.actionRequests}
        navigationEvents={agent.navigationEvents}
        memories={agent.memories}
        threadSummaries={agent.threadSummaries}
        runningRunId={agent.runningRunId}
        eventConnectionMode={agent.eventConnectionMode}
        busy={agent.busy}
        error={agent.error}
        onSend={(message) => void agent.sendMessage(message)}
        onCancelRun={() => void agent.cancelRun()}
        onConfirm={(id) => void agent.confirmAction(id)}
        onCancel={(id) => void agent.cancelAction(id)}
        onUpdate={(id, payload) => void agent.updateAction(id, payload)}
        onSelectThread={(id) => void agent.loadThread(id)}
        onNewThread={agent.startNewThread}
        onRefreshThreads={() => void agent.refreshThreads()}
        onRefreshMemories={() => void agent.refreshMemories()}
        onDeleteMemory={(id) => void agent.deleteMemory(id)}
      />
    </div>
  )
}
