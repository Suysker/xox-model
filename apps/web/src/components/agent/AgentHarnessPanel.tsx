import { useEffect, useMemo, useState } from 'react'
import {
  AgentHarnessConsole,
  type AgentHarnessConsoleAudience,
} from '@agentic-os/ui'
import {
  createAgentHarnessUiState,
  reduceAgentHarnessUiFrame,
} from '@agentic-os/ui-react'
import type { AgentHarnessUiProjection } from '../../lib/api'

const audiences: Array<{ value: AgentHarnessConsoleAudience; label: string }> = [
  { value: 'user', label: '用户' },
  { value: 'operator', label: '运维' },
  { value: 'developer', label: '调试' },
]

export function AgentHarnessPanel(props: {
  threadId: string | null
  harnessUi: AgentHarnessUiProjection | null
  className?: string
  canInspectHarness?: boolean
  onApprove?: (approvalId: string) => void
  onReject?: (approvalId: string) => void
}) {
  const [audience, setAudience] = useState<AgentHarnessConsoleAudience>('user')
  const state = useMemo(() => {
    const initial = createAgentHarnessUiState({
      threadId: props.threadId ?? 'pending-thread',
      connectionStatus: props.harnessUi ? 'closed' : 'idle',
    })
    return props.harnessUi?.frames.reduce(reduceAgentHarnessUiFrame, initial) ?? initial
  }, [props.harnessUi, props.threadId])

  useEffect(() => {
    if (!props.canInspectHarness && audience !== 'user') setAudience('user')
  }, [audience, props.canInspectHarness])

  return (
    <div className={['flex min-h-0 flex-col overflow-hidden rounded-md border border-stone-900/10 bg-white', props.className ?? ''].join(' ')} data-testid="agent-harness-ui-panel">
      {props.canInspectHarness ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-stone-900/10 bg-stone-50 px-3 py-2">
          <div className="inline-flex rounded-md border border-stone-900/10 bg-white p-1" data-testid="agent-harness-audience-switcher">
            {audiences.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setAudience(item.value)}
                className={[
                  'h-7 rounded px-2 text-xs font-semibold transition',
                  audience === item.value
                    ? 'bg-stone-950 text-white shadow-sm'
                    : 'text-stone-600 hover:bg-stone-100 hover:text-stone-950',
                ].join(' ')}
                aria-pressed={audience === item.value}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <AgentHarnessConsole
        state={state}
        audience={props.canInspectHarness ? audience : 'user'}
        surface="embedded"
        className="min-h-0"
        labels={{
          title: 'Agentic OS',
          runTimeline: '运行时间线',
          activity: '工具活动',
          approvals: '待确认',
          tools: '工具',
          trace: '轨迹',
          sandbox: '沙箱',
          review: '最终检查',
          operatorInspector: '运维检查',
          developerDebug: '开发调试',
          processing: '处理中',
          completed: '已完成',
          viewDetails: '查看详情',
        }}
        permissions={{
          canViewOperatorInspector: props.canInspectHarness === true,
          canViewDeveloperDebug: props.canInspectHarness === true,
          canViewRawPayloads: props.canInspectHarness === true,
        }}
        {...(props.onApprove !== undefined ? { onApprove: props.onApprove } : {})}
        {...(props.onReject !== undefined ? { onReject: props.onReject } : {})}
      />
    </div>
  )
}
